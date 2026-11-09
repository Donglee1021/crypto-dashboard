"""只读拉取 OKX 公共行情。不下单，不读账户。"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import ccxt
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "data" / "cache"

SYMBOLS = {"BTC": "BTC/USDT:USDT", "ETH": "ETH/USDT:USDT"}
# 15 分钟只取近一年，其余取近两年，避免每次任务拉太久。
# 1 小时 / 4 小时 / 日线取近两年。15 分钟每页只有约 100 根，两年会太慢，取近 180 天。
HISTORY = {"15m": 180, "1h": 730, "4h": 730, "1d": 800}
BARS_MS = {"15m": 15 * 60 * 1000, "1h": 60 * 60 * 1000, "4h": 4 * 60 * 60 * 1000, "1d": 24 * 60 * 60 * 1000}


def exchange():
    return ccxt.okx({"enableRateLimit": True, "options": {"defaultType": "swap"}})


def _read_cache(path: Path):
    if not path.exists():
        return None
    try:
        old = pd.read_parquet(path)
    except Exception:
        return None
    if not isinstance(old.index, pd.RangeIndex):
        old = old.reset_index(drop=True)
    if "ts" not in old.columns or not len(old):
        return None
    return old.sort_values("ts")


def _paginate(ex, symbol: str, timeframe: str, since: int, until: int) -> list:
    rows = []
    step = BARS_MS[timeframe]
    while since < until:
        batch = ex.fetch_ohlcv(symbol, timeframe, since=since, limit=100)
        if not batch:
            break
        rows.extend(row for row in batch if row[0] < until)
        nxt = batch[-1][0] + step
        if nxt <= since:
            break
        since = nxt
        if len(batch) < 100 or batch[-1][0] >= until:
            break
    return rows


def fetch_ohlcv(coin: str, timeframe: str, days: int | None = None) -> pd.DataFrame:
    ex = exchange()
    symbol = SYMBOLS[coin]
    days = days if days is not None else HISTORY[timeframe]
    start = int((datetime.now(timezone.utc) - timedelta(days=days)).timestamp() * 1000)
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    path = CACHE / f"{coin}_{timeframe}.parquet"
    old = _read_cache(path)
    frames = []
    if old is None:
        frames.append(pd.DataFrame(_paginate(ex, symbol, timeframe, start, now_ms + BARS_MS[timeframe]),
                                   columns=["ts", "open", "high", "low", "close", "volume"]))
    else:
        first = int(old["ts"].iloc[0])
        last = int(old["ts"].iloc[-1])
        step = BARS_MS[timeframe]
        if first > start + step * 2:
            gap = _paginate(ex, symbol, timeframe, start, first)
            if gap:
                frames.append(pd.DataFrame(gap, columns=["ts", "open", "high", "low", "close", "volume"]))
        frames.append(old[["ts", "open", "high", "low", "close", "volume"]])
        if last + step < now_ms:
            gap = _paginate(ex, symbol, timeframe, last + step, now_ms + step)
            if gap:
                frames.append(pd.DataFrame(gap, columns=["ts", "open", "high", "low", "close", "volume"]))
    frames = [f for f in frames if f is not None and len(f)]
    if not frames:
        raise RuntimeError(f"没有拉到 {coin} {timeframe}")
    df = pd.concat(frames, ignore_index=True)
    df = df.drop_duplicates("ts").sort_values("ts")
    df = df[df["ts"] >= start]
    df["time"] = pd.to_datetime(df["ts"], unit="ms", utc=True)
    df = df.set_index("time")
    CACHE.mkdir(parents=True, exist_ok=True)
    df.to_parquet(path)
    return df


def fetch_funding(coin: str, days: int = 730) -> pd.DataFrame:
    ex = exchange()
    symbol = SYMBOLS[coin]
    since = int((datetime.now(timezone.utc) - timedelta(days=days)).timestamp() * 1000)
    rows = []
    while True:
        try:
            batch = ex.fetch_funding_rate_history(symbol, since=since, limit=100)
        except Exception:
            break
        if not batch:
            break
        rows.extend(batch)
        last = batch[-1].get("timestamp") or 0
        nxt = last + 8 * 60 * 60 * 1000
        if nxt <= since:
            break
        since = nxt
        if len(batch) < 100:
            break
    if not rows:
        return pd.DataFrame(columns=["rate"])
    df = pd.DataFrame(rows)
    ts = df["timestamp"] if "timestamp" in df else df.get("fundingTime")
    rate = df["fundingRate"] if "fundingRate" in df else df.get("funding_rate")
    out = pd.DataFrame({"ts": ts, "rate": pd.to_numeric(rate, errors="coerce")})
    out = out.dropna().drop_duplicates("ts").sort_values("ts")
    out["time"] = pd.to_datetime(out["ts"], unit="ms", utc=True)
    return out.set_index("time")[["rate"]]


def fetch_fng() -> pd.DataFrame:
    import json
    import urllib.request
    req = urllib.request.Request("https://api.alternative.me/fng/?limit=0", headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.loads(r.read().decode())["data"]
    rows = [{"time": pd.to_datetime(int(x["timestamp"]), unit="s", utc=True), "value": int(x["value"])} for x in data]
    df = pd.DataFrame(rows).drop_duplicates("time").sort_values("time").set_index("time")
    return df
