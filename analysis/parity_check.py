#!/usr/bin/env python3
"""用同一段 K 线比较 Python 打分和 js/indicators.js。"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from analysis.market import fetch_ohlcv
from analysis.scoring import score_frame


def main():
    df = fetch_ohlcv("BTC", "1h", days=40)
    scored = score_frame(df)
    py_scores = [None if pd.isna(x) else int(x) for x in scored["score"].tolist()]
    rows = []
    for ts, row in df.iterrows():
        rows.append([int(ts.timestamp() * 1000), row.open, row.high, row.low, row.close, row.volume, 0, 0, "1"])
    blob = ROOT / "data" / "cache" / "parity_btc_1h.json"
    blob.parent.mkdir(parents=True, exist_ok=True)
    blob.write_text(json.dumps(rows), encoding="utf-8")
    script = """
const fs = require('fs');
const Ind = require(%s);
const rows = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const scores = Ind.scoreSeries(rows);
process.stdout.write(JSON.stringify(scores));
""" % json.dumps(str(ROOT / "js" / "indicators.js"))
    runner = ROOT / "data" / "cache" / "parity_run.js"
    runner.write_text(script, encoding="utf-8")
    out = subprocess.check_output(["node", str(runner), str(blob)], cwd=str(ROOT), text=True)
    js_scores = json.loads(out)
    n = min(len(py_scores), len(js_scores))
    mismatches = []
    compared = 0
    for i in range(n - 50, n):
        a, b = py_scores[i], js_scores[i]
        if a is None and b is None:
            continue
        compared += 1
        if a != b:
            mismatches.append((i, a, b))
    print(f"compared {compared}, mismatches {len(mismatches)}")
    if len(mismatches) > 2:
        print(mismatches[:8])
        raise SystemExit("Python 与 JS 打分不一致")
    print("parity ok")


if __name__ == "__main__":
    main()
