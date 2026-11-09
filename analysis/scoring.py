"""与 js/indicators.js 同一套规则的打分。回测用这份，不用 TA-Lib 的默认口径，方便和页面对照。"""
from __future__ import annotations

import math
from typing import List, Optional

import numpy as np
import pandas as pd


def _ema(xs: np.ndarray, n: int) -> np.ndarray:
    out = np.full(len(xs), np.nan)
    if len(xs) < n:
        return out
    e = float(np.sum(xs[:n]) / n)
    out[n - 1] = e
    k = 2 / (n + 1)
    for i in range(n, len(xs)):
        e = xs[i] * k + e * (1 - k)
        out[i] = e
    return out


def _sma(xs: np.ndarray, n: int) -> np.ndarray:
    out = np.full(len(xs), np.nan)
    if len(xs) < n:
        return out
    s = float(np.sum(xs[:n]))
    out[n - 1] = s / n
    for i in range(n, len(xs)):
        s += xs[i] - xs[i - n]
        out[i] = s / n
    return out


def _rsi(xs: np.ndarray, n: int = 14) -> np.ndarray:
    out = np.full(len(xs), np.nan)
    if len(xs) <= n:
        return out
    gains = np.zeros(len(xs))
    losses = np.zeros(len(xs))
    for i in range(1, len(xs)):
        d = xs[i] - xs[i - 1]
        gains[i] = max(d, 0)
        losses[i] = max(-d, 0)
    ag = float(np.sum(gains[1:n + 1]) / n)
    al = float(np.sum(losses[1:n + 1]) / n)
    out[n] = 100 if al == 0 else 100 - 100 / (1 + ag / al)
    for i in range(n + 1, len(xs)):
        ag = (ag * (n - 1) + gains[i]) / n
        al = (al * (n - 1) + losses[i]) / n
        out[i] = 100 if al == 0 else 100 - 100 / (1 + ag / al)
    return out


def _macd(xs: np.ndarray):
    e12, e26 = _ema(xs, 12), _ema(xs, 26)
    line = np.where(np.isnan(e12) | np.isnan(e26), np.nan, e12 - e26)
    valid = line[~np.isnan(line)]
    sig_v = _ema(valid, 9)
    sig = np.full(len(xs), np.nan)
    sig[len(xs) - len(valid):] = sig_v
    hist = np.where(np.isnan(line) | np.isnan(sig), np.nan, line - sig)
    return line, sig, hist


def _boll(xs: np.ndarray, n: int = 20, k: float = 2.0):
    mid = _sma(xs, n)
    up = np.full(len(xs), np.nan)
    lo = np.full(len(xs), np.nan)
    for i in range(n - 1, len(xs)):
        w = xs[i - n + 1:i + 1]
        sd = math.sqrt(float(np.sum((w - mid[i]) ** 2) / n))
        up[i] = mid[i] + k * sd
        lo[i] = mid[i] - k * sd
    return mid, up, lo


def _kdj(h, l, c, n: int = 9):
    ks = np.full(len(c), np.nan)
    ds = np.full(len(c), np.nan)
    js = np.full(len(c), np.nan)
    K = 50.0
    D = 50.0
    for i in range(n - 1, len(c)):
        hh = float(np.max(h[i - n + 1:i + 1]))
        ll = float(np.min(l[i - n + 1:i + 1]))
        rsv = 50 if hh == ll else (c[i] - ll) / (hh - ll) * 100
        K = 2 / 3 * K + 1 / 3 * rsv
        D = 2 / 3 * D + 1 / 3 * K
        ks[i] = K
        ds[i] = D
        js[i] = 3 * K - 2 * D
    return ks, ds, js


def _atr(h, l, c, n: int = 14) -> np.ndarray:
    out = np.full(len(c), np.nan)
    if len(c) < n:
        return out
    tr = np.zeros(len(c))
    tr[0] = h[0] - l[0]
    for i in range(1, len(c)):
        tr[i] = max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1]))
    a = float(np.sum(tr[:n]) / n)
    out[n - 1] = a
    for i in range(n, len(c)):
        a = (a * (n - 1) + tr[i]) / n
        out[i] = a
    return out


def score_at(i, c, o, e20, e50, e200, ml, ms, mh, rs, ks, ds, js, bu, bl, v, vavg) -> Optional[int]:
    if any(math.isnan(x) for x in (e20[i], e50[i], e200[i], ml[i], ms[i], mh[i], rs[i], ks[i], ds[i], js[i], bu[i], bl[i], vavg[i])):
        return None
    if i == 0 or math.isnan(mh[i - 1]) or vavg[i] == 0:
        return None
    p = c[i]
    sc = 0
    if e20[i] > e50[i] > e200[i]:
        sc += 2
    elif e20[i] < e50[i] < e200[i]:
        sc -= 2
    sc += 1 if p > e200[i] else -1
    sc += 1 if p > e20[i] else -1
    sc += (1 if ml[i] > ms[i] else -1) + (1 if mh[i] > mh[i - 1] else -1)
    r = rs[i]
    if r >= 70:
        sc -= 1
    elif r <= 30:
        sc += 1
    elif r > 55:
        sc += 1
    elif r < 45:
        sc -= 1
    j = js[i]
    if j > 100:
        sc -= 1
    elif j < 0:
        sc += 1
    else:
        sc += 1 if ks[i] > ds[i] else -1
    pb = 0.5 if bu[i] == bl[i] else (p - bl[i]) / (bu[i] - bl[i])
    if pb > 1:
        sc -= 1
    elif pb < 0:
        sc += 1
    elif pb > 0.5:
        sc += 1
    else:
        sc -= 1
    vr = v[i] / vavg[i]
    if vr > 1.3:
        sc += 1 if c[i] > o[i] else -1
    return int(sc)


def score_frame(df: pd.DataFrame) -> pd.Series:
    """df columns: open, high, low, close, volume. Index is time."""
    o = df["open"].to_numpy(float)
    h = df["high"].to_numpy(float)
    l = df["low"].to_numpy(float)
    c = df["close"].to_numpy(float)
    v = df["volume"].to_numpy(float)
    e20, e50, e200 = _ema(c, 20), _ema(c, 50), _ema(c, 200)
    ml, ms, mh = _macd(c)
    rs = _rsi(c)
    _mid, bu, bl = _boll(c)
    ks, ds, js = _kdj(h, l, c)
    vavg = _sma(v, 20)
    atr = _atr(h, l, c)
    scores = [score_at(i, c, o, e20, e50, e200, ml, ms, mh, rs, ks, ds, js, bu, bl, v, vavg) for i in range(len(c))]
    out = pd.DataFrame({
        "score": scores,
        "atr": atr,
        "rsi": rs,
        "close": c,
    }, index=df.index)
    return out


def fng_adjust(value: float) -> int:
    if value <= 20:
        return 1
    if value >= 80:
        return -1
    return 0


def funding_adjust(rate: float) -> int:
    if rate is None or (isinstance(rate, float) and math.isnan(rate)):
        return 0
    if rate > 0.0003:
        return -1
    if rate < 0:
        return 1
    return 0


def composite_row(s15, s1, s4, s1d, fng_adj=0, fund_adj=0) -> Optional[float]:
    parts = []
    if s15 is not None and not (isinstance(s15, float) and math.isnan(s15)):
        tech = s15 * 0.1 + s1 * 0.2 + s4 * 0.3 + s1d * 0.4
    elif None not in (s1, s4, s1d) and not any(isinstance(x, float) and math.isnan(x) for x in (s1, s4, s1d)):
        tech = s1 * 0.2 + s4 * 0.3 + s1d * 0.5
    else:
        return None
    return round(tech + fng_adj + fund_adj, 1)


def label(score: float) -> str:
    if score >= 6:
        return "强烈做多"
    if score >= 3:
        return "做多"
    if score <= -6:
        return "强烈做空"
    if score <= -3:
        return "做空"
    return "观望"


def talib_last(df: pd.DataFrame) -> dict:
    """补充计算。信号仍用上面的页面规则，这里只留一份 TA-Lib 读数。"""
    import talib
    c = df["close"].to_numpy(float)
    h = df["high"].to_numpy(float)
    l = df["low"].to_numpy(float)
    rsi = talib.RSI(c, timeperiod=14)
    macd, sig, hist = talib.MACD(c, fastperiod=12, slowperiod=26, signalperiod=9)
    ema20 = talib.EMA(c, timeperiod=20)
    upper, mid, lower = talib.BBANDS(c, timeperiod=20, nbdevup=2, nbdevdn=2)
    atr = talib.ATR(h, l, c, timeperiod=14)
    k, d = talib.STOCH(h, l, c, fastk_period=9, slowk_period=3, slowd_period=3)
    def last(arr):
        v = arr[~np.isnan(arr)]
        return None if len(v) == 0 else round(float(v[-1]), 4)
    return {
        "rsi": last(rsi), "macd": last(macd), "macd_signal": last(sig), "macd_hist": last(hist),
        "ema20": last(ema20), "bb_upper": last(upper), "bb_mid": last(mid), "bb_lower": last(lower),
        "atr": last(atr), "stoch_k": last(k), "stoch_d": last(d),
    }
