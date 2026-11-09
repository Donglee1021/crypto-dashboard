/* 指标与规则打分。移植自原先的 monitor.py / server.py，计算方式保持一致。 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Ind = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function ema(xs, n) {
    const k = 2 / (n + 1);
    const out = [];
    let e = null;
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i];
      if (i < n - 1) { out.push(null); continue; }
      if (e === null) {
        let s = 0;
        for (let j = 0; j < n; j++) s += xs[j];
        e = s / n;
      } else {
        e = x * k + e * (1 - k);
      }
      out.push(e);
    }
    return out;
  }

  function sma(xs, n) {
    const out = [];
    for (let i = 0; i < xs.length; i++) {
      if (i < n - 1) { out.push(null); continue; }
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += xs[j];
      out.push(s / n);
    }
    return out;
  }

  function rsi(xs, n) {
    n = n || 14;
    const gains = [0];
    const losses = [0];
    for (let i = 1; i < xs.length; i++) {
      const d = xs[i] - xs[i - 1];
      gains.push(Math.max(d, 0));
      losses.push(Math.max(-d, 0));
    }
    if (xs.length <= n) return xs.map(() => null);
    let ag = 0;
    let al = 0;
    for (let i = 1; i <= n; i++) { ag += gains[i]; al += losses[i]; }
    ag /= n; al /= n;
    const out = Array(n + 1).fill(null);
    out[n] = al ? 100 - 100 / (1 + ag / al) : 100;
    for (let i = n + 1; i < xs.length; i++) {
      ag = (ag * (n - 1) + gains[i]) / n;
      al = (al * (n - 1) + losses[i]) / n;
      out.push(al ? 100 - 100 / (1 + ag / al) : 100);
    }
    return out.slice(0, xs.length);
  }

  function macd(xs) {
    const e12 = ema(xs, 12);
    const e26 = ema(xs, 26);
    const line = e12.map((a, i) => (a != null && e26[i] != null ? a - e26[i] : null));
    const valid = line.filter(v => v != null);
    const sigV = ema(valid, 9);
    const pad = line.length - valid.length;
    const sig = Array(pad).fill(null).concat(sigV);
    const hist = line.map((l, i) => (l != null && sig[i] != null ? l - sig[i] : null));
    return [line, sig, hist];
  }

  function boll(xs, n, k) {
    n = n || 20; k = k == null ? 2 : k;
    const mid = sma(xs, n);
    const up = [];
    const lo = [];
    for (let i = 0; i < xs.length; i++) {
      if (mid[i] == null) { up.push(null); lo.push(null); continue; }
      const w = xs.slice(i - n + 1, i + 1);
      let ss = 0;
      for (let j = 0; j < w.length; j++) ss += (w[j] - mid[i]) ** 2;
      const sd = Math.sqrt(ss / n);
      up.push(mid[i] + k * sd);
      lo.push(mid[i] - k * sd);
    }
    return [mid, up, lo];
  }

  function kdj(h, l, c, n) {
    n = n || 9;
    let K = 50;
    let D = 50;
    const ks = [];
    const ds = [];
    const js = [];
    for (let i = 0; i < c.length; i++) {
      if (i < n - 1) { ks.push(null); ds.push(null); js.push(null); continue; }
      let hh = -Infinity;
      let ll = Infinity;
      for (let j = i - n + 1; j <= i; j++) {
        if (h[j] > hh) hh = h[j];
        if (l[j] < ll) ll = l[j];
      }
      const rsv = hh !== ll ? (c[i] - ll) / (hh - ll) * 100 : 50;
      K = 2 / 3 * K + 1 / 3 * rsv;
      D = 2 / 3 * D + 1 / 3 * K;
      ks.push(K); ds.push(D); js.push(3 * K - 2 * D);
    }
    return [ks, ds, js];
  }

  function atr(h, l, c, n) {
    n = n || 14;
    if (c.length < n) return c.map(() => null);
    const tr = [h[0] - l[0]];
    for (let i = 1; i < c.length; i++) {
      tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
    }
    const out = Array(n - 1).fill(null);
    let a = 0;
    for (let i = 0; i < n; i++) a += tr[i];
    a /= n;
    out.push(a);
    for (let i = n; i < c.length; i++) {
      a = (a * (n - 1) + tr[i]) / n;
      out.push(a);
    }
    return out;
  }

  function swings(h, l, c, look, window) {
    look = look || 5;
    window = window || 120;
    const start = Math.max(look, c.length - window);
    const highs = [];
    const lows = [];
    for (let i = start; i < c.length - look; i++) {
      let maxH = -Infinity;
      let minL = Infinity;
      for (let j = i - look; j <= i + look; j++) {
        if (h[j] > maxH) maxH = h[j];
        if (l[j] < minL) minL = l[j];
      }
      if (h[i] === maxH) highs.push(h[i]);
      if (l[i] === minL) lows.push(l[i]);
    }
    const p = c[c.length - 1];
    let res = highs.filter(x => x > p).sort((a, b) => a - b).slice(0, 2);
    let sup = lows.filter(x => x < p).sort((a, b) => b - a).slice(0, 2);
    const sliceH = h.slice(-window);
    const sliceL = l.slice(-window);
    if (!res.length) res = [Math.max.apply(null, sliceH)];
    if (!sup.length) sup = [Math.min.apply(null, sliceL)];
    return [sup, res];
  }

  function scoreTf(ind) {
    const f = [];
    const p = ind.close, e20 = ind.ema20, e50 = ind.ema50, e200 = ind.ema200;
    if (e20 > e50 && e50 > e200) f.push(['EMA 排列', 2, 'EMA20>50>200 多头排列']);
    else if (e20 < e50 && e50 < e200) f.push(['EMA 排列', -2, 'EMA20<50<200 空头排列']);
    else f.push(['EMA 排列', 0, '均线交织，无明确排列']);
    f.push(['价格 vs EMA200', p > e200 ? 1 : -1, '价格' + (p > e200 ? '高于' : '低于') + ' EMA200']);
    f.push(['价格 vs EMA20', p > e20 ? 1 : -1, '价格' + (p > e20 ? '站上' : '跌破') + ' EMA20']);
    const m = ind.macd, s = ind.macd_signal, hst = ind.macd_hist, hprev = ind.macd_hist_prev;
    const v = (m > s ? 1 : -1) + (hst > hprev ? 1 : -1);
    const barTxt = hst > hprev
      ? (hst < 0 ? '绿柱缩短' : '红柱放大')
      : (hst > 0 ? '红柱缩短' : '绿柱放大');
    f.push(['MACD', v, 'DIF在DEA' + (m > s ? '上方' : '下方') + '，' + barTxt]);
    const r = ind.rsi;
    if (r >= 70) f.push(['RSI', -1, 'RSI ' + r.toFixed(0) + ' 超买']);
    else if (r <= 30) f.push(['RSI', 1, 'RSI ' + r.toFixed(0) + ' 超卖']);
    else if (r > 55) f.push(['RSI', 1, 'RSI ' + r.toFixed(0) + ' 偏强']);
    else if (r < 45) f.push(['RSI', -1, 'RSI ' + r.toFixed(0) + ' 偏弱']);
    else f.push(['RSI', 0, 'RSI ' + r.toFixed(0) + ' 中性']);
    const k = ind.k, d = ind.d, j = ind.j;
    if (j > 100) f.push(['KDJ', -1, 'J=' + j.toFixed(0) + ' 超买']);
    else if (j < 0) f.push(['KDJ', 1, 'J=' + j.toFixed(0) + ' 超卖']);
    else f.push(['KDJ', k > d ? 1 : -1, 'K' + (k > d ? '>' : '<') + 'D']);
    const bu = ind.boll_up, bl = ind.boll_lo;
    const pb = bu !== bl ? (p - bl) / (bu - bl) : 0.5;
    if (pb > 1) f.push(['布林带', -1, '突破上轨，短线过热']);
    else if (pb < 0) f.push(['布林带', 1, '跌破下轨，短线超跌']);
    else if (pb > 0.5) f.push(['布林带', 1, '位于中轨上方 (%B ' + pb.toFixed(2) + ')']);
    else f.push(['布林带', -1, '位于中轨下方 (%B ' + pb.toFixed(2) + ')']);
    const vr = ind.vol_ratio, up = ind.vol_bull;
    if (vr > 1.3) f.push(['成交量', up ? 1 : -1, '放量 ' + vr.toFixed(1) + 'x，' + (up ? '阳线' : '阴线') + '确认']);
    else f.push(['成交量', 0, '量能 ' + vr.toFixed(1) + 'x 均量']);
    let sc = 0;
    for (let i = 0; i < f.length; i++) sc += f[i][1];
    return [sc, f];
  }

  function label(s) {
    if (s >= 6) return '强烈做多';
    if (s >= 3) return '做多';
    if (s <= -6) return '强烈做空';
    if (s <= -3) return '做空';
    return '观望';
  }

  function sentimentAdj(fng, der) {
    const f = [];
    const v = fng;
    if (v <= 20) f.push(['恐惧贪婪指数', 1, v + ' 极度恐惧，逆向偏多']);
    else if (v >= 80) f.push(['恐惧贪婪指数', -1, v + ' 极度贪婪，逆向偏空']);
    else f.push(['恐惧贪婪指数', 0, v + '，未到极端']);
    const fr = der && der.funding;
    if (fr != null) {
      const pct = (fr * 100).toFixed(4) + '%';
      if (fr > 0.0003) f.push(['资金费率', -1, pct + ' 偏高，多头拥挤']);
      else if (fr < 0) f.push(['资金费率', 1, pct + ' 为负，空头付费']);
      else f.push(['资金费率', 0, pct + ' 正常']);
    }
    const ls = der && der.ls_ratio;
    if (ls != null) {
      const t = Number(ls).toFixed(2);
      if (ls > 2.5) f.push(['多空人数比', -1, t + ' 多头人数过多，反向偏空']);
      else if (ls < 0.8) f.push(['多空人数比', 1, t + ' 空头人数过多，反向偏多']);
      else f.push(['多空人数比', 0, t + ' 未到极端']);
    }
    return f;
  }

  function newsAdj(coin, news, nowSec) {
    const cut = nowSec - 12 * 3600;
    const rel = (news || []).filter(x => x.ts >= cut && (!x.coins || !x.coins.length || x.coins.indexOf(coin) >= 0));
    let bull = 0, bear = 0;
    for (let i = 0; i < rel.length; i++) {
      if (rel[i].tag === '利多') bull++;
      else if (rel[i].tag === '利空') bear++;
    }
    const net = bull - bear;
    const adj = net >= 6 ? 2 : net >= 3 ? 1 : net <= -6 ? -2 : net <= -3 ? -1 : 0;
    return [adj, { bull: bull, bear: bear, neutral: rel.length - bull - bear, net: net }];
  }

  function analyzeRows(rows) {
    if (!rows || rows.length < 60) return null;
    const ts = [], o = [], h = [], l = [], c = [], v = [], confirm = [];
    for (let i = 0; i < rows.length; i++) {
      const x = rows[i];
      ts.push(Number(x[0]));
      o.push(Number(x[1]));
      h.push(Number(x[2]));
      l.push(Number(x[3]));
      c.push(Number(x[4]));
      v.push(Number(x[5]));
      confirm.push(String(x[8]));
    }
    let closed = -1;
    for (let i = 0; i < confirm.length; i++) if (confirm[i] === '1') closed = i;
    if (closed < 20) closed = Math.max(0, c.length - 2);
    const e20 = ema(c, 20), e50 = ema(c, 50), e200 = ema(c, 200);
    const md = macd(c), rs = rsi(c), bb = boll(c), kd = kdj(h, l, c), at = atr(h, l, c);
    const ml = md[0], ms = md[1], mh = md[2];
    const bm = bb[0], bu = bb[1], bl = bb[2];
    const ks = kd[0], ds = kd[1], js = kd[2];
    const vavg = sma(v, 20);
    if (e200[e200.length - 1] == null || ml[ml.length - 1] == null || ms[ms.length - 1] == null ||
        mh[mh.length - 1] == null || mh[mh.length - 2] == null || rs[rs.length - 1] == null ||
        ks[ks.length - 1] == null || at[at.length - 1] == null || vavg[closed] == null || !vavg[closed]) {
      return null;
    }
    const sr = swings(h, l, c);
    const levelBook = buildLevelBook(h, l, c, v, at[at.length - 1], closed);
    const ind = {
      close: c[c.length - 1], open: o[o.length - 1],
      ema20: e20[e20.length - 1], ema50: e50[e50.length - 1], ema200: e200[e200.length - 1],
      macd: ml[ml.length - 1], macd_signal: ms[ms.length - 1],
      macd_hist: mh[mh.length - 1], macd_hist_prev: mh[mh.length - 2],
      rsi: rs[rs.length - 1], k: ks[ks.length - 1], d: ds[ds.length - 1], j: js[js.length - 1],
      boll_up: bu[bu.length - 1], boll_mid: bm[bm.length - 1], boll_lo: bl[bl.length - 1],
      atr: at[at.length - 1],
      vol_ratio: v[closed] / vavg[closed],
      vol_bull: c[closed] > o[closed]
    };
    const scored = scoreTf(ind);
    const t = ts.map(ms => Math.floor(ms / 1000));
    return {
      score: scored[0],
      signal: label(scored[0]),
      factors: scored[1],
      ind: ind,
      support: sr[0],
      resistance: sr[1],
      levels: levelBook,
      closedIndex: closed,
      stop_long: c[c.length - 1] - 1.5 * at[at.length - 1],
      stop_short: c[c.length - 1] + 1.5 * at[at.length - 1],
      chart: {
        t: t, o: o, h: h, l: l, c: c, v: v,
        ema20: e20, ema50: e50, ema200: e200,
        bu: bu, bm: bm, bl: bl,
        macd: ml, sig: ms, hist: mh,
        rsi: rs, k: ks, d: ds, j: js
      }
    };
  }

  function buildLevelBook(h, l, c, v, atrValue, closed) {
    const price = c[c.length - 1];
    const look = 5;
    const window = 120;
    const thresh = Math.max(price * 0.0015, (atrValue || 0) * 0.25);
    const candidates = [];
    function add(px, source, priority) {
      if (px == null || !isFinite(px) || px <= 0) return;
      candidates.push({ price: px, source: source, priority: priority });
    }
    const start = Math.max(look, c.length - window);
    for (let i = start; i < c.length - look; i++) {
      let maxH = -Infinity, minL = Infinity;
      for (let j = i - look; j <= i + look; j++) {
        if (h[j] > maxH) maxH = h[j];
        if (l[j] < minL) minL = l[j];
      }
      if (h[i] === maxH) add(h[i], '摆动高点', 4);
      if (l[i] === minL) add(l[i], '摆动低点', 4);
    }
    const H = h[closed], L = l[closed], C = c[closed];
    const P = (H + L + C) / 3;
    [
      ['枢轴 P', P],
      ['枢轴 R1', 2 * P - L],
      ['枢轴 S1', 2 * P - H],
      ['枢轴 R2', P + (H - L)],
      ['枢轴 S2', P - (H - L)],
      ['枢轴 R3', H + 2 * (P - L)],
      ['枢轴 S3', L - 2 * (H - P)]
    ].forEach(x => add(x[1], x[0], 3));

    const w0 = Math.max(0, c.length - window);
    let hi = -Infinity, lo = Infinity;
    for (let i = w0; i < c.length; i++) {
      if (h[i] > hi) hi = h[i];
      if (l[i] < lo) lo = l[i];
    }
    if (hi > lo) {
      const bins = 24;
      const step = (hi - lo) / bins;
      const vol = Array(bins).fill(0);
      for (let i = w0; i < c.length; i++) {
        const tp = (h[i] + l[i] + c[i]) / 3;
        let b = Math.floor((tp - lo) / step);
        if (b < 0) b = 0;
        if (b >= bins) b = bins - 1;
        vol[b] += v[i];
      }
      const nodes = [];
      for (let b = 1; b < bins - 1; b++) {
        if (vol[b] > 0 && vol[b] >= vol[b - 1] && vol[b] > vol[b + 1]) {
          nodes.push({ price: lo + (b + 0.5) * step, vol: vol[b] });
        }
      }
      nodes.sort((a, b) => b.vol - a.vol);
      nodes.slice(0, 3).forEach(n => {
        if (Math.abs(n.price - price) / price > 0.0015) add(n.price, '成交密集', 2);
      });
    }

    let major, minor;
    if (price >= 10000) { major = 1000; minor = 500; }
    else if (price >= 1000) { major = 100; minor = 50; }
    else if (price >= 100) { major = 10; minor = 5; }
    else { major = 1; minor = 0.5; }
    const n0 = Math.ceil((price * 0.96) / major);
    const n1 = Math.floor((price * 1.04) / major);
    for (let n = n0; n <= n1; n++) add(n * major, '整数关口', 1);
    const m0 = Math.ceil((price * 0.98) / minor);
    const m1 = Math.floor((price * 1.02) / minor);
    for (let n = m0; n <= m1; n++) {
      const px = n * minor;
      if (Math.abs(px / major - Math.round(px / major)) > 1e-6) add(px, '半数关口', 1);
    }

    candidates.sort((a, b) => a.price - b.price);
    const clusters = [];
    candidates.forEach(item => {
      const last = clusters[clusters.length - 1];
      if (last && item.price - last.minPrice <= thresh) {
        last.items.push(item);
        last.maxPrice = item.price;
      } else {
        clusters.push({ items: [item], minPrice: item.price, maxPrice: item.price });
      }
    });
    const outClusters = clusters.map(cl => {
      let bestPri = -1;
      cl.items.forEach(it => { if (it.priority > bestPri) bestPri = it.priority; });
      const same = cl.items.filter(it => it.priority === bestPri);
      let sum = 0;
      same.forEach(it => { sum += it.price; });
      const px = sum / same.length;
      const src = [];
      cl.items.forEach(it => { if (src.indexOf(it.source) < 0) src.push(it.source); });
      src.sort((a, b) => {
        const pa = cl.items.find(it => it.source === a).priority;
        const pb = cl.items.find(it => it.source === b).priority;
        return pb - pa;
      });
      let touches = 0;
      for (let i = w0; i < c.length; i++) {
        if (l[i] <= px + thresh && h[i] >= px - thresh) touches++;
      }
      let crossed = null;
      for (let i = Math.max(1, c.length - 3); i < c.length; i++) {
        if (c[i - 1] <= px && c[i] > px) crossed = 'up';
        else if (c[i - 1] >= px && c[i] < px) crossed = 'down';
      }
      return { price: px, sources: src, touches: touches, crossed: crossed };
    });

    function ensureExtreme(list, px, source) {
      if (list.some(cl => Math.abs(cl.price - px) <= thresh)) return;
      list.push({ price: px, sources: [source], touches: 1, crossed: null });
    }
    const below = outClusters.filter(cl => cl.price < price);
    const above = outClusters.filter(cl => cl.price > price);
    if (!below.length) ensureExtreme(outClusters, Math.min.apply(null, l.slice(-window)), '区间低点');
    if (!above.length) ensureExtreme(outClusters, Math.max.apply(null, h.slice(-window)), '区间高点');

    const rStart = Math.max(0, closed - 19);
    let rh = -Infinity, rl = Infinity;
    for (let i = rStart; i <= closed; i++) {
      if (h[i] > rh) rh = h[i];
      if (l[i] < rl) rl = l[i];
    }
    return {
      clusters: outClusters,
      atr: atrValue,
      rangeHeight: rh - rl,
      prevClose: c[closed],
      thresh: thresh
    };
  }

  function presentLevels(book, price) {
    const empty = { supports: [], resistances: [], testing: [], rangeHeight: 0, atr: null };
    if (!book || !book.clusters || price == null || !isFinite(price)) return empty;
    const atrValue = book.atr;
    const rangeHeight = book.rangeHeight;
    const thresh = book.thresh || price * 0.0015;
    const band = price * 0.0005;
    const supports = [];
    const resistances = [];
    const testing = [];
    book.clusters.forEach(cl => {
      const distPct = (cl.price - price) / price * 100;
      const gap = Math.abs(price - cl.price) / cl.price;
      let breakFlag = null;
      if (cl.crossed === 'up' && price > cl.price && gap <= 0.015) breakFlag = '刚刚突破';
      else if (cl.crossed === 'down' && price < cl.price && gap <= 0.015) breakFlag = '刚刚跌破';
      else if (book.prevClose != null && gap <= 0.015) {
        if (book.prevClose <= cl.price && price > cl.price) breakFlag = '刚刚突破';
        else if (book.prevClose >= cl.price && price < cl.price) breakFlag = '刚刚跌破';
      }
      const row = {
        price: cl.price,
        sources: cl.sources,
        touches: cl.touches,
        distPct: distPct,
        proximity: Math.abs(distPct) <= 0.5,
        breakFlag: breakFlag
      };
      if (cl.price < price - band) supports.push(row);
      else if (cl.price > price + band) resistances.push(row);
      else testing.push(row);
    });
    supports.sort((a, b) => b.price - a.price);
    resistances.sort((a, b) => a.price - b.price);

    function decorate(list, side) {
      return list.slice(0, 3).map((cl, idx) => {
        const id = (side === 'support' ? 'S' : 'R') + (idx + 1);
        const next = list[idx + 1] || null;
        let measured = null;
        let atrTarget = null;
        if (side === 'support') {
          const mpx = cl.price - rangeHeight;
          if (rangeHeight > 0 && mpx > 0 && mpx < cl.price - thresh) measured = { price: mpx, distPct: (mpx - price) / price * 100 };
          const apx = cl.price - 1.5 * atrValue;
          if (atrValue > 0 && apx > 0 && apx < cl.price) atrTarget = { price: apx, distPct: (apx - price) / price * 100 };
        } else {
          const mpx = cl.price + rangeHeight;
          if (rangeHeight > 0 && mpx > cl.price + thresh) measured = { price: mpx, distPct: (mpx - price) / price * 100 };
          const apx = cl.price + 1.5 * atrValue;
          if (atrValue > 0 && apx > cl.price) atrTarget = { price: apx, distPct: (apx - price) / price * 100 };
        }
        let nextLabel = null;
        if (next) nextLabel = idx < 2 ? ((side === 'support' ? 'S' : 'R') + (idx + 2)) : (side === 'support' ? '更低一档' : '更高一档');
        return {
          id: id,
          side: side,
          price: cl.price,
          distPct: cl.distPct,
          sources: cl.sources,
          touches: cl.touches,
          nearest: idx === 0,
          proximity: cl.proximity,
          breakFlag: cl.breakFlag,
          next: next ? { price: next.price, distPct: (next.price - price) / price * 100, label: nextLabel } : null,
          measured: measured,
          atrTarget: atrTarget
        };
      });
    }
    return {
      supports: decorate(supports, 'support'),
      resistances: decorate(resistances, 'resistance'),
      testing: testing,
      rangeHeight: rangeHeight,
      atr: atrValue
    };
  }

  function swingIndexes(h, l, look, startAt) {
    const highs = [], lows = [];
    const start = Math.max(look, startAt);
    for (let i = start; i < h.length - look; i++) {
      let maxH = -Infinity, minL = Infinity;
      for (let j = i - look; j <= i + look; j++) {
        if (h[j] > maxH) maxH = h[j];
        if (l[j] < minL) minL = l[j];
      }
      if (h[i] === maxH) highs.push(i);
      if (l[i] === minL) lows.push(i);
    }
    return { highs: highs, lows: lows };
  }

  function bullishDivergence(idxs, series, priceAt, n) {
    const pts = idxs.filter(i => i >= n - 70 && series[i] != null);
    if (pts.length < 2) return false;
    const i2 = pts[pts.length - 1], i1 = pts[pts.length - 2];
    if (n - 1 - i2 > 30) return false;
    return priceAt(i2) < priceAt(i1) && series[i2] > series[i1];
  }

  function bearishDivergence(idxs, series, priceAt, n) {
    const pts = idxs.filter(i => i >= n - 70 && series[i] != null);
    if (pts.length < 2) return false;
    const i2 = pts[pts.length - 1], i1 = pts[pts.length - 2];
    if (n - 1 - i2 > 30) return false;
    return priceAt(i2) > priceAt(i1) && series[i2] < series[i1];
  }

  function structureShift(h, l, c, dir) {
    const sw = swingIndexes(h, l, 5, Math.max(0, c.length - 90));
    const n = c.length;
    function judge(i1, i2, laterExtreme, pivotOf) {
      if (n - 1 - i2 > 20) return { state: 'none' };
      let pivot = pivotOf(i1, i2);
      let brokeAt = -1;
      for (let i = i2 + 1; i < n; i++) {
        if ((dir === 'up' && c[i] > pivot) || (dir === 'down' && c[i] < pivot)) { brokeAt = i; break; }
      }
      if (brokeAt >= 0 && n - 1 - brokeAt <= 10) return { state: 'confirmed' };
      if (brokeAt < 0) return { state: 'forming' };
      return { state: 'none' };
    }
    if (dir === 'up') {
      const lows = sw.lows.filter(i => i >= n - 80);
      if (lows.length < 2) return { state: 'none' };
      const i1 = lows[lows.length - 2], i2 = lows[lows.length - 1];
      if (!(l[i2] > l[i1])) return { state: 'none' };
      return judge(i1, i2, l[i2], (a, b) => {
        let pivot = -Infinity;
        for (let i = a; i <= b; i++) if (h[i] > pivot) pivot = h[i];
        return pivot;
      });
    }
    const highs = sw.highs.filter(i => i >= n - 80);
    if (highs.length < 2) return { state: 'none' };
    const i1 = highs[highs.length - 2], i2 = highs[highs.length - 1];
    if (!(h[i2] < h[i1])) return { state: 'none' };
    return judge(i1, i2, h[i2], (a, b) => {
      let pivot = Infinity;
      for (let i = a; i <= b; i++) if (l[i] < pivot) pivot = l[i];
      return pivot;
    });
  }

  function wickShape(o, h, l, c, dir) {
    const range = h - l;
    if (!(range > 0)) return false;
    const body = Math.abs(c - o);
    if (dir === 'lower') {
      const w = Math.min(o, c) - l;
      return w >= body * 2 && w >= range * 0.5;
    }
    const w = h - Math.max(o, c);
    return w >= body * 2 && w >= range * 0.5;
  }

  function bandReclaim(ch, side) {
    const band = side === 'lower' ? ch.bl : ch.bu;
    const n = ch.c.length;
    if (band[n - 1] == null) return false;
    const insideNow = side === 'lower' ? ch.c[n - 1] > band[n - 1] : ch.c[n - 1] < band[n - 1];
    if (!insideNow) return false;
    for (let i = Math.max(0, n - 8); i < n - 1; i++) {
      if (band[i] == null) continue;
      const outside = side === 'lower' ? ch.c[i] <= band[i] : ch.c[i] >= band[i];
      if (!outside) continue;
      for (let k = i + 1; k < Math.min(n, i + 4); k++) {
        if (band[k] == null) continue;
        const back = side === 'lower' ? ch.c[k] > band[k] : ch.c[k] < band[k];
        if (back) return true;
      }
    }
    return false;
  }

  function tfName(tf) { return tf === '1H' ? '1小时' : tf === '4H' ? '4小时' : '日线'; }

  function levelPool(tfMap, price, side) {
    const out = [];
    ['1H', '4H'].forEach(tf => {
      const an = tfMap[tf];
      if (!an || !an.levels) return;
      const view = presentLevels(an.levels, price);
      const arr = side === 'long' ? view.supports : view.resistances;
      arr.forEach(lv => out.push({
        price: lv.price, id: lv.id, tf: tfName(tf), distPct: lv.distPct, breakFlag: lv.breakFlag
      }));
    });
    out.sort((a, b) => side === 'long' ? b.price - a.price : a.price - b.price);
    return out;
  }

  function chooseInvalidation(pool, price, side) {
    const inBand = pool.filter(lv => {
      const d = side === 'long' ? (price - lv.price) / price : (lv.price - price) / price;
      return d >= 0.0015 && d <= 0.025;
    });
    return inBand[0] || pool[0] || null;
  }

  function collectTriggers(tfMap, price, dir) {
    const found = [];
    ['1H', '4H'].forEach(tf => {
      const an = tfMap[tf];
      if (!an || !an.chart) return;
      const ch = an.chart;
      const zh = tfName(tf);
      const hist = ch.hist;
      for (let i = hist.length - 1; i >= Math.max(1, hist.length - 5); i--) {
        if (hist[i] == null || hist[i - 1] == null) continue;
        if (dir === 'long' && hist[i - 1] <= 0 && hist[i] > 0) { found.push(zh + ' MACD 金叉'); break; }
        if (dir === 'short' && hist[i - 1] >= 0 && hist[i] < 0) { found.push(zh + ' MACD 死叉'); break; }
      }
      const rsi = ch.rsi;
      const cur = rsi[rsi.length - 1];
      let mn = Infinity, mx = -Infinity;
      for (let i = Math.max(0, rsi.length - 5); i < rsi.length; i++) {
        if (rsi[i] == null) continue;
        if (rsi[i] < mn) mn = rsi[i];
        if (rsi[i] > mx) mx = rsi[i];
      }
      if (dir === 'long' && mn <= 35 && cur >= 45) found.push(zh + ' RSI 从超卖区收回');
      if (dir === 'short' && mx >= 65 && cur <= 55) found.push(zh + ' RSI 从超买区回落');
      for (let i = rsi.length - 1; i >= Math.max(1, rsi.length - 5); i--) {
        if (rsi[i] == null || rsi[i - 1] == null) continue;
        if (dir === 'long' && rsi[i - 1] < 50 && rsi[i] >= 50) { found.push(zh + ' RSI 上穿 50'); break; }
        if (dir === 'short' && rsi[i - 1] > 50 && rsi[i] <= 50) { found.push(zh + ' RSI 下穿 50'); break; }
      }
      const view = presentLevels(an.levels, price);
      if (dir === 'long') {
        if (view.supports.some(lv => lv.breakFlag === '刚刚突破')) {
          const retest = view.supports.some(lv => lv.breakFlag === '刚刚突破' && (price - lv.price) / price <= 0.006);
          found.push(zh + (retest ? ' 突破阻力后回踩' : ' 刚刚突破阻力'));
        }
        const s1 = view.supports[0];
        if (s1 && price > s1.price && (price - s1.price) / price <= 0.006) {
          let bounce = false;
          for (let i = Math.max(0, ch.c.length - 3); i < ch.c.length; i++) {
            if (ch.c[i] > ch.o[i] || wickShape(ch.o[i], ch.h[i], ch.l[i], ch.c[i], 'lower')) bounce = true;
          }
          if (bounce) found.push(zh + ' 支撑附近反弹');
        }
      } else {
        if (view.resistances.some(lv => lv.breakFlag === '刚刚跌破')) {
          const retest = view.resistances.some(lv => lv.breakFlag === '刚刚跌破' && (lv.price - price) / price <= 0.006);
          found.push(zh + (retest ? ' 跌破支撑后反抽' : ' 刚刚跌破支撑'));
        }
        const r1 = view.resistances[0];
        if (r1 && price < r1.price && (r1.price - price) / price <= 0.006) {
          let reject = false;
          for (let i = Math.max(0, ch.c.length - 3); i < ch.c.length; i++) {
            if (ch.c[i] < ch.o[i] || wickShape(ch.o[i], ch.h[i], ch.l[i], ch.c[i], 'upper')) reject = true;
          }
          if (reject) found.push(zh + ' 阻力附近受阻');
        }
      }
    });
    ['4H', '1D'].forEach(tf => {
      const an = tfMap[tf];
      if (!an || !an.chart) return;
      const st = structureShift(an.chart.h, an.chart.l, an.chart.c, dir === 'long' ? 'up' : 'down');
      if (st.state === 'confirmed') found.push(tfName(tf) + (dir === 'long' ? ' 更高低点已确认' : ' 更低高点已确认'));
    });
    return found.filter((x, i) => found.indexOf(x) === i);
  }

  function assessEntry(tfMap, price) {
    const emptySide = {
      trend: { ok: false, detail: '周期数据未齐' },
      trigger: { ok: false, detail: '没有触发' },
      location: { ok: false, detail: '没有可用价位' },
      invalidation: null, target: null, rr: null, riskPct: null, rewardPct: null
    };
    if (!tfMap['1H'] || !tfMap['4H'] || !tfMap['1D'] || price == null) {
      return { verdict: '暂不入场（观望）', long: emptySide, short: emptySide, ready: false };
    }
    function trend(dir) {
      let up = 0, down = 0;
      const bits = ['1H', '4H', '1D'].map(tf => {
        const s = tfMap[tf].score;
        if (s >= 3) up++;
        else if (s <= -3) down++;
        const word = s >= 3 ? '做多' : s <= -3 ? '做空' : '观望';
        return tfName(tf) + ' ' + (s > 0 ? '+' : '') + s + ' ' + word;
      });
      const ok = dir === 'long' ? (up >= 2 && down === 0) : (down >= 2 && up === 0);
      const need = dir === 'long'
        ? '要至少两个周期分数 ≥ 3，且没有周期 ≤ −3。'
        : '要至少两个周期分数 ≤ −3，且没有周期 ≥ 3。';
      return { ok: ok, detail: bits.join('，') + '。' + (ok ? '方向一致。' : need) };
    }
    function geometry(dir) {
      const opp = dir === 'long' ? 'short' : 'long';
      const mine = levelPool(tfMap, price, dir);
      const other = levelPool(tfMap, price, opp);
      const inv = chooseInvalidation(mine, price, dir);
      const target = other[0] || null;
      const nearestOpp = other[0] || null;
      const block = nearestOpp && Math.abs(nearestOpp.distPct) <= 0.5;
      const dist = inv ? Math.abs(inv.distPct) / 100 : null;
      let ok = false;
      let detail;
      if (!inv) detail = dir === 'long' ? '下方没有支撑，缺少失效位。' : '上方没有阻力，缺少失效位。';
      else if (block) detail = '现价距离' + nearestOpp.tf + nearestOpp.id + ' 只有 ' + Math.abs(nearestOpp.distPct).toFixed(2) + '%，贴着' + (dir === 'long' ? '阻力' : '支撑') + '，不做这一侧。';
      else if (dist < 0.0015) detail = '最近的' + inv.tf + inv.id + ' 离现价不足 0.15%，失效距离太近。';
      else if (dist > 0.025) detail = '最近合适的失效位 ' + inv.tf + inv.id + ' 离现价 ' + (dist * 100).toFixed(2) + '%，超过 2.5%。';
      else { ok = true; detail = '失效位用 ' + inv.tf + ' ' + inv.id + '，距离 ' + (dist * 100).toFixed(2) + '%。'; }
      let riskPct = null, rewardPct = null, rr = null;
      if (inv && target) {
        if (dir === 'long') {
          riskPct = (price - inv.price) / price * 100;
          rewardPct = (target.price - price) / price * 100;
        } else {
          riskPct = (inv.price - price) / price * 100;
          rewardPct = (price - target.price) / price * 100;
        }
        if (riskPct > 0 && rewardPct > 0) rr = rewardPct / riskPct;
      }
      return {
        location: { ok: ok, detail: detail },
        invalidation: inv,
        target: target,
        rr: rr,
        riskPct: riskPct,
        rewardPct: rewardPct
      };
    }
    function side(dir) {
      const tr = trend(dir);
      const triggers = collectTriggers(tfMap, price, dir);
      const geo = geometry(dir);
      return {
        trend: tr,
        trigger: { ok: triggers.length > 0, detail: triggers.length ? triggers.join('；') : '近 5 根没有金叉/死叉、RSI 收回、突破回踩或结构确认。' },
        location: geo.location,
        invalidation: geo.invalidation,
        target: geo.target,
        rr: geo.rr,
        riskPct: geo.riskPct,
        rewardPct: geo.rewardPct
      };
    }
    const long = side('long');
    const short = side('short');
    const longOk = long.trend.ok && long.trigger.ok && long.location.ok;
    const shortOk = short.trend.ok && short.trigger.ok && short.location.ok;
    let verdict = '暂不入场（观望）';
    if (longOk && !shortOk) verdict = '可以做多';
    else if (shortOk && !longOk) verdict = '可以做空';
    return { verdict: verdict, long: long, short: short, ready: true };
  }

  function item(name, ok, points, detail) {
    return { name: name, ok: !!ok, points: ok ? points : 0, detail: detail };
  }

  function assessExtreme(tfMap, price, ctx) {
    ctx = ctx || {};
    function pack(dir) {
      const items = [];
      const up = dir === 'bottom';
      ['4H', '1D'].forEach(tf => {
        const an = tfMap[tf];
        const zh = tfName(tf);
        if (!an) {
          items.push(item(zh + (up ? ' RSI≤30' : ' RSI≥70'), false, 1, '无数据'));
          items.push(item(zh + (up ? ' RSI 底背离' : ' RSI 顶背离'), false, 2, '无数据'));
          items.push(item(zh + (up ? ' MACD 底背离' : ' MACD 顶背离'), false, 2, '无数据'));
          return;
        }
        const rsi = an.ind.rsi;
        if (up) items.push(item(zh + ' RSI≤30', rsi <= 30, 1, 'RSI ' + rsi.toFixed(1)));
        else items.push(item(zh + ' RSI≥70', rsi >= 70, 1, 'RSI ' + rsi.toFixed(1)));
        const sw = swingIndexes(an.chart.h, an.chart.l, 5, Math.max(0, an.chart.c.length - 80));
        const n = an.chart.c.length;
        const rsiDiv = up
          ? bullishDivergence(sw.lows, an.chart.rsi, i => an.chart.l[i], n)
          : bearishDivergence(sw.highs, an.chart.rsi, i => an.chart.h[i], n);
        const macDiv = up
          ? bullishDivergence(sw.lows, an.chart.macd, i => an.chart.l[i], n)
          : bearishDivergence(sw.highs, an.chart.macd, i => an.chart.h[i], n);
        items.push(item(zh + (up ? ' RSI 底背离' : ' RSI 顶背离'), rsiDiv, 2, rsiDiv ? '价格新低/新高，RSI 没有跟随' : '最近两个摆动点没有背离'));
        items.push(item(zh + (up ? ' MACD 底背离' : ' MACD 顶背离'), macDiv, 2, macDiv ? '价格新低/新高，MACD 没有跟随' : '最近两个摆动点没有背离'));
      });
      let bands = 0;
      const bandNotes = [];
      ['4H', '1D'].forEach(tf => {
        const an = tfMap[tf];
        if (!an) return;
        const hit = bandReclaim(an.chart, up ? 'lower' : 'upper');
        if (hit) { bands++; bandNotes.push(tfName(tf)); }
      });
      const bandPts = bands === 0 ? 0 : bands === 1 ? 2 : 3;
      items.push(item(up ? '布林轨外收回' : '布林轨外收回', bands > 0, bandPts, bands ? bandNotes.join('、') + (up ? ' 下轨外后收回' : ' 上轨外后收回') : '近 6 根没有出现刺出后收回'));

      let wick = false;
      const wickNotes = [];
      ['1H', '4H', '1D'].forEach(tf => {
        const an = tfMap[tf];
        if (!an) return;
        const view = presentLevels(an.levels, price);
        const levels = up ? view.supports.concat(view.testing) : view.resistances.concat(view.testing);
        const ch = an.chart;
        for (let i = Math.max(0, ch.c.length - 3); i < ch.c.length; i++) {
          const shaped = wickShape(ch.o[i], ch.h[i], ch.l[i], ch.c[i], up ? 'lower' : 'upper');
          const px = up ? ch.l[i] : ch.h[i];
          const near = levels.some(lv => Math.abs(px - lv.price) / price <= 0.004);
          if (shaped && near) { wick = true; wickNotes.push(tfName(tf)); break; }
        }
      });
      items.push(item(up ? '支撑位长下影' : '阻力位长上影', wick, 2, wick ? wickNotes.filter((x, i, a) => a.indexOf(x) === i).join('、') + ' 影线至少是实体的 2 倍，且碰到价位' : '近 3 根没有这种 K 线'));

      let volHit = null;
      ['4H', '1H'].forEach(tf => {
        if (volHit) return;
        const an = tfMap[tf];
        if (!an || an.closedIndex == null) return;
        const ci = an.closedIndex;
        const ch = an.chart;
        const spike = an.ind.vol_ratio >= 2;
        const climax = up
          ? (ch.c[ci] < ch.o[ci] || wickShape(ch.o[ci], ch.h[ci], ch.l[ci], ch.c[ci], 'lower'))
          : (ch.c[ci] > ch.o[ci] || wickShape(ch.o[ci], ch.h[ci], ch.l[ci], ch.c[ci], 'upper'));
        if (spike && climax) volHit = tfName(tf) + ' 量比 ' + an.ind.vol_ratio.toFixed(2);
      });
      items.push(item(up ? '放量下跌或长下影' : '放量上涨或长上影', !!volHit, 2, volHit || '已收盘 K 线量比未到 2'));

      const funding = ctx.funding, avg = ctx.fundingAvg;
      if (up) {
        const neg = funding != null && funding < 0;
        const turning = neg && avg != null && funding < avg;
        const pts = neg ? (turning ? 2 : 1) : 0;
        items.push(item('资金费率转负', neg, pts, funding == null ? '暂无' : ((funding * 100).toFixed(4) + '%' + (turning ? '，低于近 7 天均值' : ''))));
        const lsOk = ctx.ls != null && ctx.ls < 0.8;
        items.push(item('多空人数比 < 0.8', lsOk, 1, ctx.ls == null ? '暂无' : Number(ctx.ls).toFixed(2)));
        const fOk = ctx.fng != null && ctx.fng < 20;
        items.push(item('恐惧贪婪 < 20', fOk, 1, ctx.fng == null ? '暂无' : String(ctx.fng)));
      } else {
        const hot = funding != null && funding > 0.0003;
        const turning = hot && avg != null && funding > avg;
        const pts = hot ? (turning ? 2 : 1) : 0;
        items.push(item('资金费率偏高', hot, pts, funding == null ? '暂无' : ((funding * 100).toFixed(4) + '%' + (turning ? '，高于近 7 天均值' : ''))));
        const lsOk = ctx.ls != null && ctx.ls > 2.5;
        items.push(item('多空人数比 > 2.5', lsOk, 1, ctx.ls == null ? '暂无' : Number(ctx.ls).toFixed(2)));
        const fOk = ctx.fng != null && ctx.fng >= 80;
        items.push(item('恐惧贪婪 ≥ 80', fOk, 1, ctx.fng == null ? '暂无' : String(ctx.fng)));
      }

      let confirmed = false, forming = false;
      const structNotes = [];
      ['4H', '1D'].forEach(tf => {
        const an = tfMap[tf];
        if (!an) return;
        const st = structureShift(an.chart.h, an.chart.l, an.chart.c, up ? 'up' : 'down');
        if (st.state === 'confirmed') { confirmed = true; structNotes.push(tfName(tf) + ' 已突破中间' + (up ? '高点' : '低点')); }
        else if (st.state === 'forming') { forming = true; structNotes.push(tfName(tf) + ' 结构正在形成'); }
      });
      const stPts = confirmed ? 3 : forming ? 1 : 0;
      items.push(item(up ? '更高低点确认' : '更低高点确认', confirmed || forming, stPts, structNotes.length ? structNotes.join('；') : '最近两个摆动点还没有这种结构'));

      let score = 0;
      items.forEach(it => { score += it.points; });
      let labelText;
      if (up) {
        if (score >= 6 && confirmed) labelText = '底部已确认';
        else if (score >= 6) labelText = '底部信号较强';
        else if (score >= 3) labelText = '可能在筑底';
        else labelText = '未见底';
      } else if (score >= 6 && confirmed) labelText = '顶部已确认';
      else if (score >= 6) labelText = '顶部信号较强';
      else if (score >= 3) labelText = '可能在筑顶';
      else labelText = '未见顶';
      return { label: labelText, score: score, confirmed: confirmed, items: items };
    }
    return { bottom: pack('bottom'), top: pack('top') };
  }

  return {
    ema: ema, sma: sma, rsi: rsi, macd: macd, boll: boll, kdj: kdj, atr: atr, swings: swings,
    scoreTf: scoreTf, label: label, sentimentAdj: sentimentAdj, newsAdj: newsAdj,
    analyzeRows: analyzeRows, presentLevels: presentLevels, assessEntry: assessEntry, assessExtreme: assessExtreme
  };
});
