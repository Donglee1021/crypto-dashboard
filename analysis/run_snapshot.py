#!/usr/bin/env python3
"""每小时记一笔当时的分数。只用公共行情，不下单。"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from analysis.market import fetch_funding, fetch_ohlcv
from analysis.scoring import composite_row, fng_adjust, funding_adjust, label, score_frame, talib_last
from analysis.store import export_frontend, insert_signals, update_outcomes

TFS = ("15m", "1h", "4h", "1d")
NAMES = {"15m": "15分钟", "1h": "1小时", "4h": "4小时", "1d": "日线", "composite": "综合"}


def latest_fng():
    import urllib.request
    req = urllib.request.Request("https://api.alternative.me/fng/?limit=1", headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return int(json.loads(r.read().decode())["data"][0]["value"])


def main():
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    fng = None
    try:
        fng = latest_fng()
    except Exception as e:
        print("fng", e)
    rows = []
    for coin in ("BTC", "ETH"):
        frames = {}
        price = None
        talib_note = None
        snap_days = {"15m": 30, "1h": 40, "4h": 60, "1d": 420}
        for tf in TFS:
            df = fetch_ohlcv(coin, tf, days=snap_days[tf])
            scored = score_frame(df)
            frames[tf] = scored
            if tf == "1h":
                price = float(df["close"].iloc[-1])
                try:
                    talib_note = talib_last(df)
                except Exception as e:
                    talib_note = {"error": str(e)[:120]}
        fund = 0.0
        try:
            hist = fetch_funding(coin, days=30)
            if len(hist):
                fund = float(hist["rate"].iloc[-1])
        except Exception as e:
            print("funding", coin, e)
        fng_adj = 0 if fng is None else fng_adjust(fng)
        fund_adj = funding_adjust(fund)
        for tf, frame in frames.items():
            score = frame["score"].iloc[-1]
            if score is None or (isinstance(score, float) and score != score):
                continue
            rows.append({
                "ts": now,
                "coin": coin,
                "horizon": NAMES[tf],
                "score": float(score),
                "verdict": label(float(score)),
                "price": price,
                "factors": json.dumps({"talib": talib_note, "note": "单周期技术分，不含新闻和清算"}, ensure_ascii=False),
            })
        comp = composite_row(
            frames["15m"]["score"].iloc[-1],
            frames["1h"]["score"].iloc[-1],
            frames["4h"]["score"].iloc[-1],
            frames["1d"]["score"].iloc[-1],
            fng_adj,
            fund_adj,
        )
        if comp is not None:
            rows.append({
                "ts": now,
                "coin": coin,
                "horizon": "综合",
                "score": float(comp),
                "verdict": label(float(comp)),
                "price": price,
                "factors": json.dumps({
                    "15m": frames["15m"]["score"].iloc[-1],
                    "1h": frames["1h"]["score"].iloc[-1],
                    "4h": frames["4h"]["score"].iloc[-1],
                    "1d": frames["1d"]["score"].iloc[-1],
                    "fng": fng,
                    "funding": fund,
                    "dropped": ["新闻", "清算", "多空人数比"],
                }, ensure_ascii=False),
            })
        print(coin, "composite", comp, "price", price)
    insert_signals(rows)
    update_outcomes()
    export_frontend()
    print("snapshot rows", len(rows))


if __name__ == "__main__":
    main()
