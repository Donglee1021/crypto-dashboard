"""信号和回测结果放进 DuckDB，同时导出页面用的 JSON。"""
from __future__ import annotations

import json
from pathlib import Path

import duckdb
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "data" / "history.duckdb"
PARQUET = ROOT / "data" / "history" / "signals.parquet"
SUMMARY = ROOT / "data" / "backtest" / "summary.json"
SIGNALS = ROOT / "data" / "backtest" / "signals.json"


def connect():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(DB_PATH))
    con.execute("""
        CREATE TABLE IF NOT EXISTS signals (
            ts TIMESTAMP,
            coin VARCHAR,
            horizon VARCHAR,
            score DOUBLE,
            verdict VARCHAR,
            price DOUBLE,
            factors VARCHAR,
            ret_1h DOUBLE,
            ret_4h DOUBLE,
            ret_24h DOUBLE,
            hit_1h BOOLEAN,
            hit_4h BOOLEAN,
            hit_24h BOOLEAN
        )
    """)
    con.execute("""
        CREATE TABLE IF NOT EXISTS backtests (
            run_ts TIMESTAMP,
            coin VARCHAR,
            horizon VARCHAR,
            kind VARCHAR,
            threshold DOUBLE,
            atr_mult DOUBLE,
            split VARCHAR,
            total_return DOUBLE,
            bench_return DOUBLE,
            max_drawdown DOUBLE,
            sharpe DOUBLE,
            win_rate DOUBLE,
            trades INTEGER,
            profit_factor DOUBLE,
            avg_hold_hours DOUBLE
        )
    """)
    return con


def insert_signals(rows: list[dict]):
    if not rows:
        return
    con = connect()
    df = pd.DataFrame(rows)
    con.register("incoming", df)
    con.execute("""
        INSERT INTO signals
        SELECT ts, coin, horizon, score, verdict, price, factors,
               NULL, NULL, NULL, NULL, NULL, NULL
        FROM incoming i
        WHERE NOT EXISTS (
            SELECT 1 FROM signals s
            WHERE s.ts = i.ts AND s.coin = i.coin AND s.horizon = i.horizon
        )
    """)
    con.close()


def update_outcomes():
    """用后来的价格给已经过去的信号补上 1小时 / 4小时 / 24小时结果。"""
    con = connect()
    df = con.execute("SELECT * FROM signals ORDER BY ts").df()
    if df.empty:
        con.close()
        return
    for coin, g in df.groupby("coin"):
        # 同一时刻各周期价格相同，取 composite 或任意一行的价格轨迹
        path = g.drop_duplicates("ts").sort_values("ts")
        times = list(path["ts"])
        prices = {t: p for t, p in zip(path["ts"], path["price"])}
        for idx, row in g.iterrows():
            t0 = row["ts"]
            p0 = row["price"]
            if not p0:
                continue
            updates = {}
            for label, hours in (("1h", 1), ("4h", 4), ("24h", 24)):
                if row[f"ret_{label}"] is not None and not pd.isna(row[f"ret_{label}"]):
                    continue
                target = t0 + pd.Timedelta(hours=hours)
                later = [t for t in times if t >= target]
                if not later:
                    continue
                p1 = prices[later[0]]
                ret = (p1 / p0 - 1) * 100
                verdict = row["verdict"] or ""
                hit = None
                if "多" in verdict and "空" not in verdict:
                    hit = bool(ret > 0)
                elif "空" in verdict:
                    hit = bool(ret < 0)
                updates[f"ret_{label}"] = round(float(ret), 3)
                updates[f"hit_{label}"] = hit
            if updates:
                sets = ", ".join(f"{k} = ?" for k in updates)
                con.execute(
                    f"UPDATE signals SET {sets} WHERE ts = ? AND coin = ? AND horizon = ?",
                    list(updates.values()) + [row["ts"], row["coin"], row["horizon"]],
                )
    con.close()


def export_frontend():
    con = connect()
    con.execute("DELETE FROM signals WHERE ts < now() - INTERVAL 180 DAY")
    con.execute("""
        DELETE FROM backtests
        WHERE run_ts NOT IN (SELECT run_ts FROM backtests ORDER BY run_ts DESC LIMIT 40)
    """)
    sig = con.execute("""
        SELECT * FROM signals
        ORDER BY ts DESC
        LIMIT 50
    """).df()
    PARQUET.parent.mkdir(parents=True, exist_ok=True)
    full = con.execute("SELECT * FROM signals ORDER BY ts").df()
    if not full.empty:
        full.to_parquet(PARQUET, index=False)
    SIGNALS.parent.mkdir(parents=True, exist_ok=True)
    records = []
    for _, r in sig.iterrows():
        records.append({
            "ts": pd.Timestamp(r["ts"]).isoformat(),
            "coin": r["coin"],
            "horizon": r["horizon"],
            "score": None if pd.isna(r["score"]) else r["score"],
            "verdict": r["verdict"],
            "price": None if pd.isna(r["price"]) else r["price"],
            "ret_1h": None if pd.isna(r["ret_1h"]) else r["ret_1h"],
            "ret_4h": None if pd.isna(r["ret_4h"]) else r["ret_4h"],
            "ret_24h": None if pd.isna(r["ret_24h"]) else r["ret_24h"],
            "hit_1h": None if pd.isna(r["hit_1h"]) else bool(r["hit_1h"]),
            "hit_4h": None if pd.isna(r["hit_4h"]) else bool(r["hit_4h"]),
            "hit_24h": None if pd.isna(r["hit_24h"]) else bool(r["hit_24h"]),
        })
    SIGNALS.write_text(json.dumps({"items": records}, ensure_ascii=False, indent=2), encoding="utf-8")
    con.close()


def insert_backtests(rows: list[dict]):
    if not rows:
        return
    con = connect()
    df = pd.DataFrame(rows)
    con.register("bt", df)
    con.execute("""
        INSERT INTO backtests
        SELECT run_ts, coin, horizon, kind, threshold, atr_mult, split,
               total_return, bench_return, max_drawdown, sharpe, win_rate,
               trades, profit_factor, avg_hold_hours
        FROM bt
    """)
    con.close()
