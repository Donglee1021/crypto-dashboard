#!/usr/bin/env python3
"""每日回测。研究用，不下单。"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from analysis.engine import downsample, sweep
from analysis.market import fetch_fng, fetch_funding, fetch_ohlcv
from analysis.scoring import score_frame
from analysis.store import SUMMARY, insert_backtests

REPORTS = ROOT / "reports"
BAR_HOURS = {"15m": 0.25, "1h": 1.0, "4h": 4.0, "1d": 24.0, "composite": 1.0}
HORIZON_ZH = {"15m": "15分钟", "1h": "1小时", "4h": "4小时", "1d": "日线", "composite": "综合"}


def prepare(coin: str):
    frames = {}
    raw = {}
    for tf in ("15m", "1h", "4h", "1d"):
        df = fetch_ohlcv(coin, tf)
        raw[tf] = df
        scored = score_frame(df)
        scored["open"] = df["open"]
        scored["high"] = df["high"]
        scored["low"] = df["low"]
        scored["volume"] = df["volume"]
        frames[tf] = scored.dropna(subset=["score"])
        print(coin, tf, "bars", len(frames[tf]))
    try:
        funding = fetch_funding(coin)
    except Exception as e:
        print("funding failed", coin, e)
        funding = pd.Series(dtype=float)
    try:
        fng = fetch_fng()
    except Exception as e:
        print("fng failed", e)
        fng = pd.DataFrame(columns=["value"])
    from analysis.engine import align_composite
    fund_series = funding["rate"] if len(funding) else pd.Series(dtype=float)
    composite = align_composite(frames, fng, fund_series)
    return frames, composite, fund_series


def _naive(series: pd.Series) -> pd.Series:
    out = series.copy()
    if getattr(out.index, "tz", None) is not None:
        out.index = out.index.tz_convert("UTC").tz_localize(None)
    return out


def write_report(equity: pd.Series, bench: pd.Series, path: Path, title: str):
    import logging
    import matplotlib
    matplotlib.rcParams["font.family"] = "DejaVu Sans"
    logging.getLogger("matplotlib.font_manager").setLevel(logging.ERROR)
    import quantstats as qs
    path.parent.mkdir(parents=True, exist_ok=True)
    rets = _naive(equity).pct_change().fillna(0)
    bh = _naive(bench).pct_change().fillna(0)
    rets = rets[~rets.index.duplicated(keep="last")]
    bh = bh.reindex(rets.index).fillna(0)
    qs.reports.html(rets, benchmark=bh, output=str(path), title=title)


def equity_payload(series: pd.Series):
    return downsample(series)


def main():
    SUMMARY.parent.mkdir(parents=True, exist_ok=True)
    REPORTS.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    payload = {
        "generated": now.isoformat(),
        "notes": [
            "规则与页面单周期打分一致。综合分 = 15分钟×0.1 + 1小时×0.2 + 4小时×0.3 + 日线×0.4，并加上恐惧贪婪和资金费率。",
            "新闻和清算没有可靠的长历史，回测里没有计入。多空人数比也没有计入。",
            "默认阈值是 3（页面里做多 / 做空的分界），止损是 1.5 倍 ATR。参数搜索只在前 70% 样本上进行，后 30% 留作样本外。",
            "样本内选出来的“最佳”参数容易过拟合，请以样本外结果为准。回测不代表未来收益。",
            "费用按 OKX 吃单 0.05% 每边计算。有资金费率历史时，持仓会扣或收资金费。",
            "TA-Lib 会另算一套 RSI / MACD / 布林 / ATR / STOCH，信号本身仍用页面公式，以便和浏览器打分对照。",
        ],
        "coins": {},
    }
    db_rows = []
    for coin in ("BTC", "ETH"):
        frames, composite, funding = prepare(coin)
        coin_out = {"horizons": {}}
        series_map = {
            "15m": frames["15m"],
            "1h": frames["1h"],
            "4h": frames["4h"],
            "1d": frames["1d"],
            "composite": composite,
        }
        for horizon, df in series_map.items():
            if len(df) < 200:
                print("skip", coin, horizon, len(df))
                continue
            fund = None if horizon == "composite" else funding
            if horizon == "composite":
                fund = funding
            result = sweep(df, fund if len(fund) else None, BAR_HOURS[horizon], coin, HORIZON_ZH[horizon])
            zh = HORIZON_ZH[horizon]
            coin_out["horizons"][zh] = {
                "default_train": result["default_train"],
                "default_test": result["default_test"],
                "best_train": result["best_train"],
                "best_test": result["best_test"],
                "equity_default": equity_payload(result["equity_default"]),
                "equity_bench": equity_payload(result["bench"]),
                "bars": int(len(df)),
                "start": df.index[0].isoformat(),
                "end": df.index[-1].isoformat(),
            }
            for key in ("default_train", "default_test", "best_train", "best_test"):
                row = dict(result[key])
                row["run_ts"] = now
                db_rows.append(row)
            if horizon == "composite":
                try:
                    write_report(result["equity_default"], result["bench"], REPORTS / f"{coin.lower()}_default.html", f"{coin} 默认规则")
                    write_report(result["equity_best"], result["bench_test"], REPORTS / f"{coin.lower()}_best_oos.html", f"{coin} 样本外最佳参数")
                except Exception as e:
                    print("quantstats", coin, e)
                    coin_out["report_error"] = str(e)[:200]
            print(coin, zh, "default test", result["default_test"]["total_return"], "best test", result["best_test"]["total_return"])
        payload["coins"][coin] = coin_out
    SUMMARY.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        insert_backtests(db_rows)
    except Exception as e:
        print("duckdb backtests", e)
    print("wrote", SUMMARY)


if __name__ == "__main__":
    main()
