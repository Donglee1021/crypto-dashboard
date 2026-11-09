#!/usr/bin/env python3
"""抓取新闻 RSS、恐惧贪婪指数、美股宏观，以及浏览器无法跨域读取的 OKX 统计。

写出 data/news.json、data/macro.json、data/derivatives.json。
内容与上次提交相同时不改文件（由工作流据此跳过提交）。
"""
import datetime
import gzip
import html
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from email.utils import parsedate_to_datetime
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
TZ = ZoneInfo("Europe/Vienna")
NY = ZoneInfo("America/New_York")
UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "application/rss+xml, application/xml, text/xml, application/json, */*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

FEEDS = [
    ("CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/", "crypto"),
    ("Cointelegraph", "https://cointelegraph.com/rss", "crypto"),
    ("The Block", "https://www.theblock.co/rss.xml", "crypto"),
    ("Decrypt", "https://decrypt.co/feed", "crypto"),
    ("Investing.com 加密", "https://www.investing.com/rss/news_301.rss", "crypto"),
    ("CNBC 头条", "https://www.cnbc.com/id/100003114/device/rss/rss.html", "macro"),
    ("CNBC 经济", "https://www.cnbc.com/id/20910258/device/rss/rss.html", "macro"),
    ("CNBC 金融", "https://www.cnbc.com/id/10000664/device/rss/rss.html", "macro"),
    ("MarketWatch", "https://feeds.marketwatch.com/marketwatch/topstories/", "macro"),
    ("Investing.com 股市", "https://www.investing.com/rss/news_25.rss", "macro"),
    ("Yahoo Finance", "https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5EGSPC,BTC-USD&region=US&lang=en-US", "macro"),
    ("美联储", "https://www.federalreserve.gov/feeds/press_all.xml", "macro"),
]

MACRO_REL = re.compile(
    r"(s&p|nasdaq|\bdow\b|wall street|\bstocks\b|stock market|\bfed\b|fomc|powell|rate cut|rate hike|"
    r"interest rate|inflation|\bcpi\b|\bppi\b|jobs report|payroll|treasur|\byields?\b|dollar|tariff|"
    r"recession|economy|\bgdp\b|nvidia|\bai trade|crypto|bitcoin|ether)",
    re.I,
)
BULL = [
    ("surge", "大涨"), ("soar", "飙升"), ("rally", "反弹/上涨"), ("jump", "跳涨"), ("gain", "上涨"),
    ("rise", "上升"), ("rises", "上升"), ("climb", "攀升"), ("rebound", "反弹"), ("record high", "创新高"),
    ("all-time high", "创新高"), ("inflow", "资金流入"), ("approv", "获批"), ("bullish", "看涨"),
    ("rate cut", "降息"), ("cut rates", "降息"), ("easing", "宽松"), ("beats", "超预期"),
    ("upgrade", "上调评级"), ("adopt", "采用"), ("accumulat", "增持"), ("buys", "买入"), ("buy", "买入"),
    ("recover", "回升"), ("cool", "降温"), ("eases", "缓和"), ("deal", "达成协议"),
]
BEAR = [
    ("plunge", "暴跌"), ("crash", "崩跌"), ("tumble", "大跌"), ("slide", "下滑"), ("slump", "下挫"),
    ("sink", "下沉"), ("drop", "下跌"), ("fall", "下跌"), ("falls", "下跌"), ("decline", "下降"),
    ("selloff", "抛售"), ("sell-off", "抛售"), ("outflow", "资金流出"), ("liquidat", "爆仓"),
    ("hack", "被黑"), ("exploit", "漏洞攻击"), ("heist", "被盗"), ("ban", "禁令"), ("lawsuit", "诉讼"),
    ("sues", "起诉"), ("probe", "调查"), ("investigation", "调查"), ("rate hike", "加息"), ("hike", "加息"),
    ("hawkish", "鹰派"), ("bearish", "看跌"), ("fear", "恐慌"), ("recession", "衰退"), ("tariff", "关税"),
    ("lowest", "新低"), ("weak", "疲弱"), ("loses", "失守"), ("losses", "亏损"), ("warn", "警告"),
    ("crackdown", "打压"), ("downgrade", "下调评级"), ("hot inflation", "通胀过热"),
]
MACRO_SYMS = [
    ("^GSPC", "标普 500", ""),
    ("^IXIC", "纳斯达克", ""),
    ("DX-Y.NYB", "美元指数 DXY", ""),
    ("^TNX", "美10年期国债收益率", "%"),
]
COINS = ["BTC", "ETH"]
IGNORE_KEYS = {"updated", "updated_unix"}


def short_err(e):
    msg = re.sub(r"\s+", " ", str(e).replace("\n", " "))
    msg = re.sub(r"[0-9a-f]{8,}", "", msg, flags=re.I)
    return f"{type(e).__name__}: {msg[:160]}"


def get_bytes(url, timeout=20):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read()
    if len(data) > 5_000_000:
        raise ValueError("响应过大")
    if data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
    return data


def get_json(url, timeout=20):
    return json.loads(get_bytes(url, timeout).decode("utf-8", "replace"))


def strip_html(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()


def local_name(tag):
    return tag.split("}")[-1] if tag else ""


def child_text(el, names):
    want = set(names)
    for c in list(el):
        if local_name(c.tag) in want and c.text and c.text.strip():
            return c.text.strip()
    return ""


def link_of(el):
    direct = child_text(el, ("link",))
    if direct:
        return direct
    for c in list(el):
        if local_name(c.tag) == "link":
            href = (c.attrib.get("href") or "").strip()
            if href:
                return href
            if c.text and c.text.strip():
                return c.text.strip()
    return ""


def parse_dt(s):
    s = (s or "").strip()
    if not s:
        return None
    if re.match(r"\d{4}-", s):
        dt = datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
    else:
        dt = parsedate_to_datetime(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt


def date_of(el):
    for c in list(el):
        if local_name(c.tag) in ("pubDate", "published", "updated", "date"):
            dt = parse_dt(c.text or "")
            if dt:
                return dt
    return None


def parse_xml(data):
    text = data.decode("utf-8", "replace")
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", text)
    return ET.fromstring(text.encode("utf-8"))


def tag_news(title, desc):
    text = f" {title} {desc[:300]} ".lower()
    tl = title.lower()
    pos, neg = [], []
    ps = ns = 0
    for en, zh in BULL:
        if re.search(r"\b" + re.escape(en), text):
            pos.append(zh)
            ps += 2 if re.search(r"\b" + re.escape(en), tl) else 1
    for en, zh in BEAR:
        if re.search(r"\b" + re.escape(en), text):
            neg.append(zh)
            ns += 2 if re.search(r"\b" + re.escape(en), tl) else 1
    if ps - ns >= 2:
        tag = "利多"
    elif ns - ps >= 2:
        tag = "利空"
    else:
        tag = "中性"
    pos = list(dict.fromkeys(pos))
    neg = list(dict.fromkeys(neg))
    parts = []
    if pos:
        parts.append("利多词: " + "、".join(pos[:4]))
    if neg:
        parts.append("利空词: " + "、".join(neg[:4]))
    reason = "；".join(parts) if parts else "未命中方向关键词"
    if tag == "中性" and pos and neg:
        reason += "（多空相抵）"
    low = f"{title} {desc}".lower()
    coins = []
    if re.search(r"bitcoin|\bbtc\b", low):
        coins.append("BTC")
    if re.search(r"ether|ethereum|\beth\b", low):
        coins.append("ETH")
    return tag, reason, ps - ns, coins


def parse_feed(name, url, kind):
    root = parse_xml(get_bytes(url))
    items = []
    for el in root.iter():
        if local_name(el.tag) not in ("item", "entry"):
            continue
        title = strip_html(child_text(el, ("title",)))
        link = link_of(el).strip()
        desc = strip_html(child_text(el, ("description", "summary", "content", "encoded")))
        dt = date_of(el)
        if not title or not link or dt is None:
            continue
        if kind == "macro" and not MACRO_REL.search(f"{title} {desc}"):
            continue
        items.append(dict(title=title, link=link, desc=desc[:240], source=name, kind=kind, ts=dt.timestamp()))
    return items


def fetch_feed(name, url, kind):
    try:
        items = parse_feed(name, url, kind)
        return name, items, f"ok {len(items)}"
    except Exception as e:
        return name, [], f"失败: {short_err(e)}"


def load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def canon(obj):
    def strip(x):
        if isinstance(x, dict):
            return {k: strip(v) for k, v in sorted(x.items()) if k not in IGNORE_KEYS}
        if isinstance(x, list):
            return [strip(v) for v in x]
        return x
    return strip(obj)


def write_if_changed(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    old = load_json(path)
    if old is not None and canon(old) == canon(obj):
        return False
    now = datetime.datetime.now(TZ)
    obj["updated"] = now.isoformat(timespec="seconds")
    obj["updated_unix"] = int(time.time())
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")
    os.replace(tmp, path)
    return True


def build_news():
    old = load_json(os.path.join(DATA, "news.json")) or {}
    old_items = {x.get("key"): x for x in old.get("items") or [] if x.get("key")}
    had_old = bool(old_items)
    all_items = []
    status = {}
    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = [ex.submit(fetch_feed, n, u, k) for n, u, k in FEEDS]
        for fut in as_completed(futs):
            name, items, st = fut.result()
            status[name] = st
            all_items.extend(items)
    now = time.time()
    cutoff = now - 48 * 3600
    seen = set()
    out = []
    failed = sum(1 for v in status.values() if v.startswith("失败"))
    for it in sorted(all_items, key=lambda x: (-x["ts"], x["title"])):
        if it["ts"] < cutoff or it["ts"] > now + 600:
            continue
        key = re.sub(r"[^a-z0-9]", "", it["title"].lower())[:80]
        if not key or key in seen:
            continue
        seen.add(key)
        tag, reason, score, coins = tag_news(it["title"], it["desc"])
        if key in old_items:
            first_seen = old_items[key].get("first_seen") or it["ts"]
        else:
            first_seen = it["ts"] if not had_old else now
        out.append({
            "coins": coins,
            "desc": it["desc"],
            "first_seen": int(first_seen),
            "key": key,
            "kind": it["kind"],
            "link": it["link"],
            "reason": reason,
            "score": score,
            "source": it["source"],
            "tag": tag,
            "title": it["title"],
            "ts": int(it["ts"]),
        })
        if len(out) >= 30:
            break
    kept = False
    if not out and failed == len(FEEDS) and old.get("items"):
        out = old["items"]
        kept = True
    errors = [f"{k}: {v}" for k, v in sorted(status.items()) if str(v).startswith("失败")]
    obj = {
        "errors": errors,
        "items": out,
        "meta": {
            "count": len(out),
            "kept_previous": kept,
            "sources": {k: status[k] for k in sorted(status)},
        },
    }
    changed = write_if_changed(os.path.join(DATA, "news.json"), obj)
    return changed, len(out), failed, errors


def fetch_fng():
    fg = get_json("https://api.alternative.me/fng/?limit=30")["data"]
    rows = []
    for x in reversed(fg):
        rows.append({"cls": x.get("value_classification") or "", "t": int(x["timestamp"]), "value": int(x["value"])})
    return rows


def fetch_one_macro(sym, name, unit):
    last_err = None
    j = None
    q = urllib.parse.quote(sym, safe="")
    for host in ("query1.finance.yahoo.com", "query2.finance.yahoo.com"):
        url = f"https://{host}/v8/finance/chart/{q}?range=5d&interval=1d"
        try:
            req = urllib.request.Request(url, headers={**UA, "Referer": "https://finance.yahoo.com/"})
            with urllib.request.urlopen(req, timeout=20) as r:
                j = json.loads(r.read().decode("utf-8", "replace"))
            if j.get("chart", {}).get("result"):
                break
            j = None
        except Exception as e:
            last_err = e
            j = None
    if not j or not j.get("chart", {}).get("result"):
        raise RuntimeError(f"{sym}: {short_err(last_err) if last_err else '无行情'}")
    res = j["chart"]["result"][0]
    m = res["meta"]
    last = m["regularMarketPrice"]
    quote = res["indicators"]["quote"][0]["close"]
    tss = res["timestamp"]
    day_now = datetime.datetime.fromtimestamp(m["regularMarketTime"], NY).date()
    prev = None
    for t_, x in zip(tss, quote):
        if x is not None and datetime.datetime.fromtimestamp(t_, NY).date() < day_now:
            prev = x
    closes = [x for x in quote if x is not None]
    if prev is None:
        prev = m.get("chartPreviousClose") or (closes[-2] if len(closes) >= 2 else last)
    return name, {
        "chg": round((last / prev - 1) * 100, 2),
        "last": round(float(last), 3),
        "time_unix": int(m["regularMarketTime"]),
        "unit": unit,
    }


def build_macro():
    errors = []
    markets = {}
    fng = []
    try:
        fng = fetch_fng()
    except Exception as e:
        errors.append(f"恐惧贪婪: {short_err(e)}")
    with ThreadPoolExecutor(max_workers=4) as ex:
        futs = [ex.submit(fetch_one_macro, s, n, u) for s, n, u in MACRO_SYMS]
        for fut in as_completed(futs):
            try:
                name, row = fut.result()
                markets[name] = row
            except Exception as e:
                errors.append(f"宏观: {short_err(e)}")
    errors = sorted(set(errors))
    old = load_json(os.path.join(DATA, "macro.json")) or {}
    if not fng and old.get("fng"):
        fng = old["fng"]
        errors.append("恐惧贪婪: 沿用上次结果")
    if len(markets) < len(MACRO_SYMS) and old.get("markets"):
        for k, v in old["markets"].items():
            markets.setdefault(k, v)
        if len(markets) == len(old.get("markets") or {}):
            errors.append("宏观: 部分沿用上次结果")
    errors = sorted(set(errors))
    obj = {"errors": errors, "fng": fng, "markets": markets}
    changed = write_if_changed(os.path.join(DATA, "macro.json"), obj)
    return changed, fng[-1]["value"] if fng else None, list(markets), errors


def build_derivatives():
    errors = []
    coins = {}

    def one(ccy):
        out = {}
        inst_err = []
        try:
            ls = get_json(
                f"https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy={ccy}&period=1H"
            )["data"]
            if not ls:
                raise RuntimeError("空数据")
            chrono = list(reversed(ls))[-24:]
            out["ls_ratio"] = float(chrono[-1][1])
            out["ls_hist"] = [[int(x[0]) // 1000, float(x[1])] for x in chrono]
        except Exception as e:
            inst_err.append(f"多空比 {ccy}: {short_err(e)}")
        try:
            oih = get_json(
                f"https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy={ccy}&period=1H"
            )["data"]
            if len(oih) > 24:
                out["oi_all_usd"] = float(oih[0][1])
                out["oi_chg24h"] = round((float(oih[0][1]) / float(oih[24][1]) - 1) * 100, 2)
        except Exception as e:
            inst_err.append(f"持仓变化 {ccy}: {short_err(e)}")
        return ccy, out, inst_err

    with ThreadPoolExecutor(max_workers=2) as ex:
        for ccy, out, inst_err in ex.map(one, COINS):
            coins[ccy] = out
            errors.extend(inst_err)
    errors = sorted(set(errors))
    old = load_json(os.path.join(DATA, "derivatives.json")) or {}
    for ccy in COINS:
        if not coins.get(ccy) and (old.get("coins") or {}).get(ccy):
            coins[ccy] = old["coins"][ccy]
            errors.append(f"{ccy}: 沿用上次结果")
    errors = sorted(set(errors))
    obj = {"coins": coins, "errors": errors}
    changed = write_if_changed(os.path.join(DATA, "derivatives.json"), obj)
    return changed, coins, errors


def build_liquidations():
    """OKX 每次只返回最近约 100 笔。每 10 分钟合并，保留约 26 小时。"""
    path = os.path.join(DATA, "liquidations.json")
    old = load_json(path) or {}
    now_ms = int(time.time() * 1000)
    cutoff = now_ms - 26 * 3600 * 1000
    coins = {}
    errors = []
    for ccy in COINS:
        try:
            fam = f"{ccy}-USDT"
            raw = get_json(
                f"https://www.okx.com/api/v5/public/liquidation-orders?instType=SWAP&instFamily={fam}&state=filled&limit=100"
            )["data"]
            inst = get_json(
                f"https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId={ccy}-USDT-SWAP"
            )["data"][0]
            ct = float(inst["ctVal"])
            fresh = []
            for block in raw:
                for d in block.get("details") or []:
                    px = float(d["bkPx"])
                    sz = float(d["sz"])
                    fresh.append({
                        "posSide": "short" if d.get("posSide") == "short" else "long",
                        "px": px,
                        "sz": sz,
                        "ts": int(d["ts"]),
                        "usd": round(sz * ct * px, 2),
                    })
            prev = ((old.get("coins") or {}).get(ccy) or {}).get("events") or []
            merged = {}
            for ev in list(prev) + fresh:
                if int(ev["ts"]) < cutoff:
                    continue
                key = f"{ev['ts']}|{ev['px']}|{ev['sz']}|{ev['posSide']}"
                merged[key] = {
                    "posSide": ev["posSide"],
                    "px": float(ev["px"]),
                    "sz": float(ev["sz"]),
                    "ts": int(ev["ts"]),
                    "usd": round(float(ev["usd"]), 2),
                }
            events = sorted(merged.values(), key=lambda x: (x["ts"], x["px"], x["sz"]))[-4000:]
            coins[ccy] = {"ctVal": ct, "events": events}
        except Exception as e:
            errors.append(f"清算 {ccy}: {short_err(e)}")
            prev_coin = (old.get("coins") or {}).get(ccy)
            if prev_coin:
                coins[ccy] = prev_coin
                errors.append(f"清算 {ccy}: 沿用上次结果")
    errors = sorted(set(errors))
    obj = {"coins": coins, "errors": errors}
    changed = write_if_changed(path, obj)
    return changed, {k: len((v or {}).get("events") or []) for k, v in coins.items()}, errors


def step_summary(lines):
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def main():
    os.makedirs(DATA, exist_ok=True)
    n_changed, n_count, n_failed, n_err = build_news()
    m_changed, fng, names, m_err = build_macro()
    d_changed, coins, d_err = build_derivatives()
    l_changed, l_counts, l_err = build_liquidations()
    print(f"news changed={n_changed} count={n_count} failed_feeds={n_failed}")
    print(f"macro changed={m_changed} fng={fng} markets={names}")
    for ccy, row in coins.items():
        print(f"der {ccy} ls={row.get('ls_ratio')} oi_chg={row.get('oi_chg24h')}")
    print(f"liq changed={l_changed} counts={l_counts}")
    errs = n_err + m_err + d_err + l_err
    if errs:
        print("errors:")
        for e in errs:
            print(" -", e)
    step_summary([
        "## 新闻与宏观",
        f"- 新闻 {n_count} 条，源失败 {n_failed}，文件{'已更新' if n_changed else '无变化'}",
        f"- 恐惧贪婪 {fng if fng is not None else '无'}，宏观 {('、'.join(names) if names else '无')}",
        f"- 合约统计 {'已更新' if d_changed else '无变化'}",
        f"- 清算记录 {l_counts}，文件{'已更新' if l_changed else '无变化'}",
    ])
    if n_count == 0 and not names and not any(coins.get(c) for c in COINS):
        raise SystemExit("所有数据源都失败了")


if __name__ == "__main__":
    main()
