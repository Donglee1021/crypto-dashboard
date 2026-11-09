"""用 VectorBT 回测页面上的多空规则。只做研究，不下单。"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import pandas as pd
import vectorbt as vbt

from analysis.scoring import composite_row, fng_adjust, funding_adjust, score_frame

FEE = 0.0005  # OKX 吃单 0.05%
THRESHOLDS = [2, 3, 4, 5, 6]
ATR_MULTS = [0.0, 1.0, 1.5, 2.0]


@dataclass
class RunResult:
    total_return: float
    bench_return: float
    max_drawdown: float
    sharpe: float
    win_rate: float
    trades: int
    profit_factor: float
    avg_hold_hours: float
    equity: pd.Series


def desired_position(score: pd.Series, threshold: float) -> pd.Series:
    values = score.to_numpy(dtype=float)
    out = np.empty(len(values))
    cur = 0.0
    for i, val in enumerate(values):
        if not math.isnan(val):
            if val >= threshold:
                cur = 1.0
            elif val <= -threshold:
                cur = -1.0
            else:
                cur = 0.0
        out[i] = cur
    return pd.Series(out, index=score.index)


def _events(pos: pd.Series):
    prev = pos.shift(1).fillna(0)
    long_entries = (pos > 0) & (prev <= 0)
    long_exits = (pos <= 0) & (prev > 0)
    short_entries = (pos < 0) & (prev >= 0)
    short_exits = (pos >= 0) & (prev < 0)
    return long_entries, long_exits, short_entries, short_exits


def run_vectorbt(close: pd.Series, high: pd.Series, low: pd.Series, score: pd.Series, atr: pd.Series,
                 threshold: float, atr_mult: float, funding: pd.Series | None, bar_hours: float) -> RunResult:
    score = score.astype(float)
    pos = desired_position(score, threshold)
    le, lx, se, sx = _events(pos)
    freq = pd.Timedelta(hours=bar_hours)
    sl = None
    if atr_mult:
        sl = (atr.ffill() * atr_mult / close).clip(lower=0.001, upper=0.5).fillna(0.2)
    pf = vbt.Portfolio.from_signals(
        close,
        entries=le,
        exits=lx,
        short_entries=se,
        short_exits=sx,
        high=high,
        low=low,
        sl_stop=sl,
        fees=FEE,
        freq=freq,
        init_cash=10_000,
        upon_opposite_entry="reverse",
    )
    rets = pf.returns().copy()
    if funding is not None and len(funding):
        aligned = funding.reindex(close.index, method="ffill").fillna(0.0)
        # 8 小时收一次。这一根 K 线承担的资金费 = 费率 × 持仓方向 × (K线小时 / 8)。
        try:
            direction = np.sign(pf.asset_flow().cumsum()).reindex(close.index).fillna(0.0)
        except Exception:
            direction = pos.reindex(close.index).fillna(0.0)
        rets = rets - aligned * direction * (bar_hours / 8.0)
    equity = (1 + rets.fillna(0)).cumprod()
    bench = close / close.iloc[0]
    total = float(equity.iloc[-1] - 1) if len(equity) else 0.0
    bench_ret = float(bench.iloc[-1] - 1) if len(bench) else 0.0
    dd = float((equity / equity.cummax() - 1).min()) if len(equity) else 0.0
    sharpe = 0.0
    if rets.std() and not math.isnan(rets.std()):
        periods = (24 / bar_hours) * 365
        sharpe = float(rets.mean() / rets.std() * math.sqrt(periods))
    trades = pf.trades.records_readable if pf.trades.count() else pd.DataFrame()
    n = int(pf.trades.count())
    if n:
        pnl = trades["PnL"].astype(float)
        wins = pnl[pnl > 0]
        losses = pnl[pnl < 0]
        win_rate = float(len(wins) / n)
        gross_loss = abs(float(losses.sum())) if len(losses) else 0.0
        profit_factor = float(wins.sum() / gross_loss) if gross_loss else float(wins.sum() > 0)
        if "Entry Timestamp" in trades.columns and "Exit Timestamp" in trades.columns:
            entry_ts = pd.to_datetime(trades["Entry Timestamp"], utc=True)
            exit_ts = pd.to_datetime(trades["Exit Timestamp"], utc=True)
            avg_hold = float((exit_ts - entry_ts).dt.total_seconds().mean() / 3600)
        else:
            avg_hold = 0.0
    else:
        win_rate = 0.0
        profit_factor = 0.0
        avg_hold = 0.0
    return RunResult(total, bench_ret, dd, sharpe, win_rate, n, profit_factor, avg_hold, equity)


def metrics_of(result: RunResult, split: str, coin: str, horizon: str, kind: str, threshold: float, atr_mult: float) -> dict:
    return {
        "coin": coin,
        "horizon": horizon,
        "kind": kind,
        "threshold": threshold,
        "atr_mult": atr_mult,
        "split": split,
        "total_return": round(result.total_return, 4),
        "bench_return": round(result.bench_return, 4),
        "max_drawdown": round(result.max_drawdown, 4),
        "sharpe": round(result.sharpe, 3),
        "win_rate": round(result.win_rate, 4),
        "trades": result.trades,
        "profit_factor": round(result.profit_factor, 3) if math.isfinite(result.profit_factor) else None,
        "avg_hold_hours": round(result.avg_hold_hours, 2),
    }


def objective(row: dict) -> float:
    if row["trades"] < 8:
        return -1e9
    return row["sharpe"]


def align_composite(frames: dict[str, pd.DataFrame], fng: pd.DataFrame, funding: pd.Series) -> pd.DataFrame:
    """把各周期分数对齐到 1 小时，得到和页面相近的综合分。新闻和清算没有历史，不计入。"""
    base = frames["1h"].copy()
    out = pd.DataFrame(index=base.index)
    out["close"] = base["close"]
    out["high"] = base["high"]
    out["low"] = base["low"]
    out["atr"] = base["atr"]
    out["s1"] = base["score"]
    # K 线时间戳是开盘时间。高周期分数要等这根 K 线收盘才知道，所以先把时间挪到收盘再向前填充，避免用到未来价格。
    shift = {"15m": pd.Timedelta(minutes=15), "4h": pd.Timedelta(hours=4), "1d": pd.Timedelta(days=1)}
    for key, col in (("15m", "s15"), ("4h", "s4"), ("1d", "sd")):
        src = frames[key]["score"].copy()
        src.index = frames[key].index + shift[key]
        out[col] = src.reindex(base.index, method="ffill")
    if fng is not None and len(fng):
        out["fng"] = fng["value"].reindex(base.index, method="ffill")
    else:
        out["fng"] = np.nan
    if funding is not None and len(funding):
        out["funding"] = funding.reindex(base.index, method="ffill")
    else:
        out["funding"] = np.nan
    scores = []
    for _, row in out.iterrows():
        scores.append(composite_row(
            None if pd.isna(row["s15"]) else row["s15"],
            None if pd.isna(row["s1"]) else row["s1"],
            None if pd.isna(row["s4"]) else row["s4"],
            None if pd.isna(row["sd"]) else row["sd"],
            0 if pd.isna(row["fng"]) else fng_adjust(row["fng"]),
            0 if pd.isna(row["funding"]) else funding_adjust(row["funding"]),
        ))
    out["score"] = scores
    return out.dropna(subset=["score"])


def sweep(df: pd.DataFrame, funding: pd.Series | None, bar_hours: float, coin: str, horizon: str):
    split = int(len(df) * 0.7)
    train, test = df.iloc[:split], df.iloc[split:]
    fund_train = None if funding is None else funding.reindex(train.index, method="ffill")
    fund_test = None if funding is None else funding.reindex(test.index, method="ffill")
    best = None
    best_key = (3.0, 1.5)
    for th in THRESHOLDS:
        for mult in ATR_MULTS:
            res = run_vectorbt(train["close"], train["high"], train["low"], train["score"], train["atr"], th, mult, fund_train, bar_hours)
            row = metrics_of(res, "train", coin, horizon, "sweep", th, mult)
            if best is None or objective(row) > objective(best):
                best = row
                best_key = (th, mult)
    default_train = run_vectorbt(train["close"], train["high"], train["low"], train["score"], train["atr"], 3, 1.5, fund_train, bar_hours)
    default_test = run_vectorbt(test["close"], test["high"], test["low"], test["score"], test["atr"], 3, 1.5, fund_test, bar_hours)
    best_test = run_vectorbt(test["close"], test["high"], test["low"], test["score"], test["atr"], best_key[0], best_key[1], fund_test, bar_hours)
    full_default = run_vectorbt(df["close"], df["high"], df["low"], df["score"], df["atr"], 3, 1.5, funding, bar_hours)
    bench_test = test["close"] / test["close"].iloc[0]
    return {
        "default_train": metrics_of(default_train, "train", coin, horizon, "default", 3, 1.5),
        "default_test": metrics_of(default_test, "test", coin, horizon, "default", 3, 1.5),
        "best_train": best,
        "best_test": metrics_of(best_test, "test", coin, horizon, "best", best_key[0], best_key[1]),
        "equity_default": full_default.equity,
        "equity_best": best_test.equity,
        "bench": df["close"] / df["close"].iloc[0],
        "bench_test": bench_test,
    }


def downsample(series: pd.Series, n: int = 180):
    if series is None or len(series) == 0:
        return []
    step = max(1, len(series) // n)
    picked = series.iloc[::step]
    return [[int(ts.timestamp() * 1000), round(float(val), 4)] for ts, val in picked.items()]
