/* 浏览器端行情、指标与页面。新闻 / 宏观 / 多空比读取仓库里的 JSON。 */
(function () {
  'use strict';

  const COINS = ['BTC', 'ETH'];
  const TFS = ['1H', '4H', '1D'];
  const TF_BAR = { '1H': '1H', '4H': '4H', '1D': '1Dutc' };
  const TFN = { '1H': '1小时', '4H': '4小时', '1D': '日线' };
  const TZ = 'Europe/Vienna';
  const WS_URLS = [
    'wss://ws.okx.com:8443/ws/v5/public',
    'wss://ws.okx.com/ws/v5/public'
  ];
  const FNG_ZH = {
    'Extreme Fear': '极度恐惧',
    'Fear': '恐惧',
    'Neutral': '中性',
    'Greed': '贪婪',
    'Extreme Greed': '极度贪婪'
  };

  let coin = 'BTC';
  let tf = '4H';
  let newsFilter = 'all';
  const live = {};
  const ST = {
    ticker: {},
    tf: { BTC: {}, ETH: {} },
    chart: {},
    der: { BTC: {}, ETH: {} },
    fng: [],
    macro: {},
    news: [],
    newsMeta: {},
    updated: {},
    errors: {},
    summary: {}
  };

  const $ = id => document.getElementById(id);
  const dp = c => c === 'BTC' ? 1 : 2;
  const fp = (c, v) => v == null || Number.isNaN(Number(v))
    ? '—'
    : Number(v).toLocaleString('en-US', { minimumFractionDigits: dp(c), maximumFractionDigits: dp(c) });
  const pct = v => v == null || Number.isNaN(Number(v)) ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%';
  function sgn(v) {
    if (v == null || Number.isNaN(Number(v))) return '—';
    const n = Number(v);
    const s = Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
    return (n > 0 ? '+' : '') + s;
  }
  const cls = s => !s ? 's-flat' : s.indexOf('做多') >= 0 ? 's-up' : s.indexOf('做空') >= 0 ? 's-down' : 's-flat';
  const scls = v => v > 0 ? 'up' : v < 0 ? 'down' : '';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  function safeUrl(u) {
    try {
      const x = new URL(u, location.href);
      if (x.protocol === 'http:' || x.protocol === 'https:') return x.href;
    } catch (e) {}
    return '#';
  }
  function round1(x) { return Math.round(x * 10) / 10; }
  function parts(ms) {
    const dtf = new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    return Object.fromEntries(dtf.formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  }
  function fmtFull(ms) {
    if (!ms) return '—';
    const p = parts(ms);
    return p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute + ':' + p.second;
  }
  function fmtMDHM(ms) {
    if (!ms) return '—';
    const p = parts(ms);
    return p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute;
  }
  function fmtHM(ms) {
    if (!ms) return '—';
    const p = parts(ms);
    return p.hour + ':' + p.minute;
  }
  function rel(sec) {
    const s = Date.now() / 1000 - sec;
    if (s < 0) return '刚刚';
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return Math.floor(s / 86400) + ' 天前';
  }
  function timeoutSignal(ms) {
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return AbortSignal.timeout(ms);
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
  }
  function siteUrl(path) {
    let p = location.pathname;
    if (p.endsWith('/index.html')) p = p.slice(0, -'index.html'.length);
    else if (!p.endsWith('/')) p += '/';
    return new URL(path, location.origin + p).href;
  }
  function isNew(n) {
    const now = Date.now() / 1000;
    return (now - n.ts) < 600 || (now - (n.first_seen || n.ts)) < 600;
  }

  async function okx(path) {
    let last;
    for (let i = 0; i < 2; i++) {
      try {
        const r = await fetch('https://www.okx.com' + path, { cache: 'no-store', signal: timeoutSignal(15000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        if (j.code !== '0') throw new Error(j.msg || ('OKX ' + j.code));
        return j.data;
      } catch (e) {
        last = e;
        await new Promise(res => setTimeout(res, 400 * (i + 1)));
      }
    }
    throw last;
  }

  async function loadJson(name) {
    const r = await fetch(siteUrl('data/' + name + '.json?t=' + Date.now()), { cache: 'no-store' });
    if (!r.ok) throw new Error(name + ' HTTP ' + r.status);
    return r.json();
  }

  function setErr(k, e) {
    if (e) ST.errors[k] = String(e.message || e).slice(0, 180);
    else delete ST.errors[k];
  }

  // ---------- charts ----------
  const base = {
    layout: { background: { color: '#161b22' }, textColor: '#8b949e' },
    grid: { vertLines: { color: '#21262d' }, horzLines: { color: '#21262d' } },
    localization: {
      locale: 'zh-CN',
      timeFormatter: sec => fmtMDHM(sec * 1000)
    },
    timeScale: {
      timeVisible: true,
      secondsVisible: false,
      borderColor: '#30363d',
      tickMarkFormatter: (sec, type) => {
        const p = parts(sec * 1000);
        if (type === 0) return p.year;
        if (type === 1 || type === 2) return p.month + '-' + p.day;
        return p.hour + ':' + p.minute;
      }
    },
    rightPriceScale: { borderColor: '#30363d' },
    crosshair: { mode: 0 },
    autoSize: true
  };
  let cMain, cMacd, cRsi, cKdj, candle, vol, e20, e50, e200, bu, bm, bl, mh, mdif, mdea, rl, kk, kd, kj;
  let rsiLines = [];
  let srLines = [];
  let srSig = '';
  let chartsReady = false;

  function initCharts() {
    if (typeof LightweightCharts === 'undefined') {
      $('chartNote').textContent = '图表库没有加载。';
      return;
    }
    const mk = id => LightweightCharts.createChart($(id), base);
    cMain = mk('main'); cMacd = mk('pMacd'); cRsi = mk('pRsi'); cKdj = mk('pKdj');
    candle = cMain.addCandlestickSeries({
      upColor: '#26a69a', downColor: '#ef5350', borderVisible: false,
      wickUpColor: '#26a69a', wickDownColor: '#ef5350'
    });
    vol = cMain.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    cMain.priceScale('vol').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    const L = (ch, color, w, extra) => ch.addLineSeries(Object.assign({
      color: color, lineWidth: w || 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false
    }, extra || {}));
    e20 = L(cMain, '#f0b90b');
    e50 = L(cMain, '#58a6ff');
    e200 = L(cMain, '#c678dd', 2);
    bu = L(cMain, '#8b949e', 1, { lineStyle: 2 });
    bm = L(cMain, '#8b949e', 1, { lineStyle: 1 });
    bl = L(cMain, '#8b949e', 1, { lineStyle: 2 });
    mh = cMacd.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
    mdif = L(cMacd, '#f0b90b');
    mdea = L(cMacd, '#58a6ff');
    rl = L(cRsi, '#c678dd', 1, { lastValueVisible: true });
    kk = L(cKdj, '#f0b90b');
    kd = L(cKdj, '#58a6ff');
    kj = L(cKdj, '#c678dd');
    const all = [cMain, cMacd, cRsi, cKdj];
    let syncing = false;
    all.forEach(c => c.timeScale().subscribeVisibleLogicalRangeChange(r => {
      if (!r || syncing) return;
      syncing = true;
      all.forEach(o => { if (o !== c) o.timeScale().setVisibleLogicalRange(r); });
      syncing = false;
    }));
    chartsReady = true;
  }

  function ser(arr, times) {
    const out = [];
    for (let i = 0; i < times.length; i++) {
      if (arr[i] == null || Number.isNaN(arr[i])) continue;
      out.push({ time: times[i], value: arr[i] });
    }
    return out;
  }

  function drawChart(fit) {
    const CH = ST.chart[coin + '_' + tf];
    if (!chartsReady || !CH) return;
    try {
    candle.applyOptions({
      priceFormat: { type: 'price', precision: dp(coin), minMove: coin === 'BTC' ? 0.1 : 0.01 }
    });
    candle.setData(CH.t.map((t, i) => ({ time: t, open: CH.o[i], high: CH.h[i], low: CH.l[i], close: CH.c[i] })));
    vol.setData(CH.t.map((t, i) => ({
      time: t, value: CH.v[i],
      color: CH.c[i] >= CH.o[i] ? 'rgba(38,166,154,.35)' : 'rgba(239,83,80,.35)'
    })));
    const showE = $('chkEma').checked, showB = $('chkBoll').checked;
    e20.setData(showE ? ser(CH.ema20, CH.t) : []);
    e50.setData(showE ? ser(CH.ema50, CH.t) : []);
    e200.setData(showE ? ser(CH.ema200, CH.t) : []);
    bu.setData(showB ? ser(CH.bu, CH.t) : []);
    bm.setData(showB ? ser(CH.bm, CH.t) : []);
    bl.setData(showB ? ser(CH.bl, CH.t) : []);
    const hist = [];
    for (let i = 0; i < CH.t.length; i++) {
      if (CH.hist[i] == null) continue;
      hist.push({ time: CH.t[i], value: CH.hist[i], color: CH.hist[i] >= 0 ? 'rgba(38,166,154,.7)' : 'rgba(239,83,80,.7)' });
    }
    mh.setData(hist);
    mdif.setData(ser(CH.macd, CH.t));
    mdea.setData(ser(CH.sig, CH.t));
    rl.setData(ser(CH.rsi, CH.t));
    rsiLines.forEach(p => { try { rl.removePriceLine(p); } catch (e) {} });
    rsiLines = [70, 30].map(v => rl.createPriceLine({ price: v, color: '#30363d', lineWidth: 1, lineStyle: 2, axisLabelVisible: false }));
    kk.setData(ser(CH.k, CH.t));
    kd.setData(ser(CH.d, CH.t));
    kj.setData(ser(CH.j, CH.t));
    if (fit) {
      const n = CH.t.length;
      cMain.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 120), to: n + 3 });
    }
    srSig = '';
    syncSrLines();
    } catch (err) {
      setErr('chart', err);
      console.error(err);
    }
  }

  function liveCandle(c, price) {
    if (!chartsReady || c !== coin) return;
    const CH = ST.chart[c + '_' + tf];
    if (!CH || !CH.t.length) return;
    const i = CH.t.length - 1;
    CH.c[i] = price;
    CH.h[i] = Math.max(CH.h[i], price);
    CH.l[i] = Math.min(CH.l[i], price);
    try {
      candle.update({ time: CH.t[i], open: CH.o[i], high: CH.h[i], low: CH.l[i], close: price });
    } catch (e) {}
  }

  // ---------- render ----------
  function buildSummary() {
    const fngOk = ST.fng.length > 0;
    const fngNow = fngOk ? ST.fng[ST.fng.length - 1].value : 50;
    const now = Date.now() / 1000;
    COINS.forEach(c => {
      const tfs = ST.tf[c] || {};
      if (!tfs['1H'] || !tfs['4H'] || !tfs['1D']) { delete ST.summary[c]; return; }
      const tech = round1(tfs['1H'].score * 0.2 + tfs['4H'].score * 0.3 + tfs['1D'].score * 0.5);
      let sent = Ind.sentimentAdj(fngNow, ST.der[c] || {});
      if (!fngOk) sent = [['恐惧贪婪指数', 0, '暂无数据']].concat(sent.filter(f => f[0] !== '恐惧贪婪指数'));
      const na = Ind.newsAdj(c, ST.news, now);
      const total = round1(tech + sent.reduce((a, f) => a + f[1], 0) + na[0]);
      ST.summary[c] = {
        tech: tech, sentiment: sent, news_adj: na[0], news_stat: na[1],
        total: total, verdict: Ind.label(total)
      };
    });
  }

  function renderVerdicts() {
    $('verdicts').innerHTML = COINS.map(c => {
      const s = ST.summary[c];
      const t = ST.ticker[c] || {};
      const p = live[c] != null ? live[c] : t.last;
      if (!s) return '<div class="card">' + c + ' 指标计算中…</div>';
      const tfs = ST.tf[c];
      return '<div class="card verdict">' +
        '<div class="vrow"><b style="font-size:16px">' + c + '-USDT 永续</b><span class="sig ' + cls(s.verdict) + '">' + esc(s.verdict) + ' ' + sgn(s.total) + '</span></div>' +
        '<div class="vrow"><span class="price" id="px_' + c + '">' + fp(c, p) + '</span>' +
        '<span class="' + scls(t.chg24h) + '" id="chg_' + c + '">' + pct(t.chg24h) + '</span>' +
        '<span class="muted">24小时 高 ' + fp(c, t.high24h) + ' / 低 ' + fp(c, t.low24h) + '</span></div>' +
        '<div class="muted">' + TFS.map(k => TFN[k] + ' <span class="' + scls(tfs[k].score) + '">' + esc(tfs[k].signal) + ' ' + sgn(tfs[k].score) + '</span>').join(' · ') + '</div>' +
        '<div class="muted">技术面 ' + sgn(s.tech) + ' · 情绪 ' + sgn(s.sentiment.reduce((a, f) => a + f[1], 0)) + ' · 新闻 ' + sgn(s.news_adj) + ' = 综合 ' + sgn(s.total) + '</div>' +
        '</div>';
    }).join('');
  }

  function updatePrices() {
    let missing = false;
    COINS.forEach(c => {
      const el = $('px_' + c);
      const t = ST.ticker[c];
      if (!el || !t) { missing = true; return; }
      const p = live[c] != null ? live[c] : t.last;
      el.textContent = fp(c, p);
      const ce = $('chg_' + c);
      if (ce && t.open24h) {
        const v = (p / t.open24h - 1) * 100;
        t.chg24h = v;
        ce.textContent = pct(v);
        ce.className = scls(v);
      }
    });
    if (missing && ST.summary.BTC) renderVerdicts();
    const now = Date.now();
    if (now - auxTimer > 1000) { auxTimer = now; renderEntry(); renderLevels(); renderExtreme(); }
  }

  function renderDetail() {
    const d = ST.tf[coin] && ST.tf[coin][tf];
    const s = ST.summary[coin];
    if (!d) {
      $('bdTitle').textContent = '信号拆解';
      $('bdTable').innerHTML = '<tr><td>该周期还在计算。</td></tr>';
      renderLevels();
      return;
    }
    $('bdTitle').innerHTML = '信号拆解 · ' + coin + ' ' + TFN[tf] + ' <span class="sig ' + cls(d.signal) + '">' + esc(d.signal) + ' ' + sgn(d.score) + '</span>';
    let rows = d.factors.map(f => '<tr><td>' + esc(f[0]) + '</td><td class="n ' + scls(f[1]) + '">' + sgn(f[1]) + '</td><td>' + esc(f[2]) + '</td></tr>').join('');
    if (s) {
      const ns = s.news_stat;
      rows += '<tr><th colspan="3">综合分构成（' + coin + '）</th></tr>';
      rows += '<tr><td>技术面加权</td><td class="n ' + scls(s.tech) + '">' + sgn(s.tech) + '</td><td>1小时×0.2 + 4小时×0.3 + 日线×0.5</td></tr>';
      rows += s.sentiment.map(f => '<tr><td>' + esc(f[0]) + '</td><td class="n ' + scls(f[1]) + '">' + sgn(f[1]) + '</td><td>' + esc(f[2]) + '</td></tr>').join('');
      rows += '<tr><td>新闻倾向</td><td class="n ' + scls(s.news_adj) + '">' + sgn(s.news_adj) + '</td><td>近12小时 利多' + ns.bull + ' / 利空' + ns.bear + ' / 中性' + ns.neutral + '</td></tr>';
      rows += '<tr><td><b>综合</b></td><td class="n"><span class="sig ' + cls(s.verdict) + '">' + sgn(s.total) + '</span></td><td>' + esc(s.verdict) + '</td></tr>';
    }
    $('bdTable').innerHTML = '<tr><th>因子</th><th class="n">得分</th><th>依据</th></tr>' + rows;
    const i = d.ind;
    const row = (a, b) => '<div>' + a + '</div><div>' + b + '</div>';
    $('indKv').innerHTML = [
      row('现价（计算时）', fp(coin, i.close)),
      row('EMA20', fp(coin, i.ema20)),
      row('EMA50', fp(coin, i.ema50)),
      row('EMA200', fp(coin, i.ema200)),
      row('MACD DIF / DEA', Number(i.macd).toFixed(2) + ' / ' + Number(i.macd_signal).toFixed(2)),
      row('MACD 柱', Number(i.macd_hist).toFixed(2) + '（前 ' + Number(i.macd_hist_prev).toFixed(2) + '）'),
      row('RSI(14)', Number(i.rsi).toFixed(1)),
      row('KDJ', Number(i.k).toFixed(1) + ' / ' + Number(i.d).toFixed(1) + ' / ' + Number(i.j).toFixed(1)),
      row('布林上轨', fp(coin, i.boll_up)),
      row('布林中轨', fp(coin, i.boll_mid)),
      row('布林下轨', fp(coin, i.boll_lo)),
      row('ATR(14)', fp(coin, i.atr)),
      row('量比（上一根已收盘）', Number(i.vol_ratio).toFixed(2) + 'x'),
      row('计算时间', fmtHM(d.computed))
    ].join('');
    const pxNow = live[coin] != null ? live[coin] : i.close;
    const viewLv = d.levels ? Ind.presentLevels(d.levels, pxNow) : null;
    const s1 = viewLv && viewLv.supports[0];
    const r1 = viewLv && viewLv.resistances[0];
    $('lvKv').innerHTML = [
      row('最近支撑', s1 ? s1.id + ' ' + fp(coin, s1.price) + '（' + pct(s1.distPct) + '）' : '—'),
      row('最近阻力', r1 ? r1.id + ' ' + fp(coin, r1.price) + '（' + pct(r1.distPct) + '）' : '—'),
      row('ATR(14)', fp(coin, i.atr)),
      row('多单止损参考', fp(coin, d.stop_long)),
      row('空单止损参考', fp(coin, d.stop_short))
    ].join('');
    renderLevels();
  }

  function renderMtf() {
    let h = '<tr><th>币种</th><th>1小时</th><th>4小时</th><th>日线</th><th class="n">RSI 1小时/4小时/日线</th><th>综合</th></tr>';
    COINS.forEach(c => {
      const t = ST.tf[c], s = ST.summary[c];
      if (!t || !s || !t['1H']) return;
      h += '<tr><td>' + c + '</td>' + TFS.map(k => '<td><span class="sig ' + cls(t[k].signal) + '">' + esc(t[k].signal) + ' ' + sgn(t[k].score) + '</span></td>').join('') +
        '<td class="n">' + TFS.map(k => Number(t[k].ind.rsi).toFixed(0)).join(' / ') + '</td>' +
        '<td><span class="sig ' + cls(s.verdict) + '">' + esc(s.verdict) + ' ' + sgn(s.total) + '</span></td></tr>';
    });
    $('mtfTable').innerHTML = h;
  }

  function spark(vals) {
    if (!vals || vals.length < 2) return '';
    const w = 300, h = 60, n = vals.length;
    const pts = vals.map((v, i) => (i / (n - 1)) * w + ',' + (h - (v / 100) * h)).join(' ');
    return '<svg viewBox="0 0 ' + w + ' ' + (h + 4) + '" width="100%" height="64" preserveAspectRatio="none" aria-hidden="true">' +
      '<line x1="0" x2="' + w + '" y1="' + (h / 2) + '" y2="' + (h / 2) + '" stroke="#30363d" stroke-dasharray="3 3"/>' +
      '<polyline fill="none" stroke="#f0b90b" stroke-width="2" points="' + pts + '"/></svg>';
  }

  function renderSent() {
    const f = ST.fng;
    if (!f.length) {
      $('fngBox').textContent = '恐惧贪婪指数暂无。';
    } else {
      const cur = f[f.length - 1];
      const prev = f.length > 1 ? f[f.length - 2].value : '—';
      $('fngBox').innerHTML = '<div class="vrow"><span class="price">' + cur.value + '</span>' +
        '<span class="sig ' + (cur.value < 45 ? 's-down' : cur.value > 55 ? 's-up' : 's-flat') + '">' + esc(FNG_ZH[cur.cls] || cur.cls) + '</span>' +
        '<span class="muted">恐惧贪婪指数（alternative.me）</span></div>' +
        spark(f.map(x => x.value)) +
        '<div class="muted">近30天：' + fmtMDHM(f[0].t * 1000) + ' 为 ' + f[0].value + '，前值 ' + prev + '，最新 ' + cur.value + '（0 极度恐惧 — 100 极度贪婪）</div>';
    }
    $('fngTime').textContent = ST.updated.fng ? '更新于 ' + fmtHM(ST.updated.fng) : '';
    const D = ST.der;
    const cell = (c, fn) => '<td class="n">' + (D[c] ? fn(D[c]) : '—') + '</td>';
    const row = (name, fn) => '<tr><td>' + name + '</td>' + COINS.map(c => cell(c, fn)).join('') + '</tr>';
    $('derTable').innerHTML = '<tr><th>指标</th><th class="n">BTC</th><th class="n">ETH</th></tr>' +
      row('资金费率（当期）', d => d.funding == null ? '—' : (d.funding * 100).toFixed(4) + '%') +
      row('下次结算', d => d.next_funding || '—') +
      row('近7天平均资金费率', d => d.funding_avg7d == null ? '—' : (d.funding_avg7d * 100).toFixed(4) + '%') +
      row('USDT 永续持仓', d => d.oi_usd ? (d.oi_usd / 1e9).toFixed(2) + ' 十亿美元' : '—') +
      row('全部合约持仓 24小时变化', d => d.oi_chg24h == null ? '—' : '<span class="' + scls(d.oi_chg24h) + '">' + pct(d.oi_chg24h) + '</span>') +
      row('多空人数比', d => d.ls_ratio == null ? '—' : Number(d.ls_ratio).toFixed(2)) +
      row('多空比约24小时前', d => d.ls_hist && d.ls_hist.length ? Number(d.ls_hist[0][1]).toFixed(2) : '—');
    const bits = [];
    if (ST.updated.funding) bits.push('费率/持仓 ' + fmtHM(ST.updated.funding));
    if (ST.updated.ls) bits.push('多空比/持仓变化 ' + fmtHM(ST.updated.ls));
    $('derTime').textContent = bits.join(' · ');
    $('derNote').textContent = '资金费率与 USDT 永续持仓由浏览器直连 OKX。多空人数比和全部合约持仓变化来自定时任务，因为这两个接口没有浏览器跨域许可。';
  }

  function renderMacro() {
    const m = ST.macro || {};
    const keys = Object.keys(m);
    $('macroTable').innerHTML = '<tr><th>指标</th><th class="n">最新</th><th class="n">涨跌</th><th class="n">时间（维也纳）</th></tr>' +
      keys.map(k => {
        const v = m[k];
        return '<tr><td>' + esc(k) + '</td><td class="n">' +
          Number(v.last).toLocaleString('en-US', { maximumFractionDigits: 3 }) + esc(v.unit || '') +
          '</td><td class="n ' + scls(v.chg) + '">' + pct(v.chg) + '</td><td class="n">' + fmtMDHM(v.time_unix * 1000) + '</td></tr>';
      }).join('');
    $('macroTime').textContent = ST.updated.macro ? '更新于 ' + fmtFull(ST.updated.macro) : '暂无';
  }

  function renderNews() {
    const tcls = { '利多': 't-bull', '利空': 't-bear', '中性': 't-neu' };
    const list = (ST.news || []).filter(n => newsFilter === 'all' || n.tag === newsFilter);
    $('newsList').innerHTML = list.length ? list.map(n => {
      const fresh = isNew(n);
      return '<li class="' + (fresh ? 'new' : '') + '">' +
        '<div><span class="tag ' + (tcls[n.tag] || 't-neu') + '">' + esc(n.tag) + '</span>' +
        '<a href="' + esc(safeUrl(n.link)) + '" target="_blank" rel="noopener noreferrer">' + esc(n.title) + '</a>' +
        (fresh ? '<span class="badge-new">新</span>' : '') + '</div>' +
        '<div class="muted">' + fmtMDHM(n.ts * 1000) + ' · ' + rel(n.ts) + ' · ' + esc(n.source) +
        (n.coins && n.coins.length ? ' · ' + esc(n.coins.join('/')) : '') + ' · ' + esc(n.reason) + '</div></li>';
    }).join('') : '<li class="muted">暂无要闻。</li>';
    const freshN = (ST.news || []).filter(isNew).length;
    $('newsMeta').textContent = ST.updated.news
      ? '更新于 ' + fmtHM(ST.updated.news) + ' · 约每10分钟 · ' + freshN + ' 条为10分钟内'
      : '';
    const b = ST.summary.BTC, e = ST.summary.ETH;
    if (b && e) {
      $('newsTilt').textContent = '近12小时新闻倾向：BTC 利多' + b.news_stat.bull + '/利空' + b.news_stat.bear +
        '（调整 ' + sgn(b.news_adj) + '），ETH 利多' + e.news_stat.bull + '/利空' + e.news_stat.bear +
        '（调整 ' + sgn(e.news_adj) + '）。调整最多 ±2。';
    }
    const src = (ST.newsMeta && ST.newsMeta.sources) || {};
    $('newsSrc').innerHTML = Object.keys(src).map(k => esc(k) + '：' + esc(src[k])).join('<br>') || '暂无';
  }

  function ageWarn(ms, limit) {
    return ms && (Date.now() - ms > limit);
  }

  function renderMeta() {
    const u = ST.updated;
    const bits = [
      ['价格', u.ticker, 60000],
      ['K线指标', u.klines, 180000],
      ['资金费率', u.funding, 600000],
      ['多空比', u.ls, 40 * 60000],
      ['恐惧贪婪', u.fng, 40 * 60000],
      ['美股宏观', u.macro, 40 * 60000],
      ['新闻', u.news, 40 * 60000]
    ];
    $('updTimes').innerHTML = '各数据源最近更新（维也纳）：' + bits.map(b => {
      const stale = ageWarn(b[1], b[2]);
      return '<span class="' + (stale ? 'warn' : '') + '">' + b[0] + ' ' + (b[1] ? fmtHM(b[1]) : '—') + '</span>';
    }).join(' · ');
    const e = Object.keys(ST.errors);
    $('errs').textContent = e.length ? '数据源错误：' + e.map(k => k + ': ' + ST.errors[k]).join('；') : '';
  }

  let auxTimer = 0;

  function coinPrice(c) {
    if (live[c] != null) return live[c];
    const tfs = ST.tf[c] || {};
    if (tfs['4H']) return tfs['4H'].ind.close;
    if (tfs['1H']) return tfs['1H'].ind.close;
    if (tfs['1D']) return tfs['1D'].ind.close;
    return null;
  }

  function clearSrLines() {
    srLines.forEach(p => { try { candle.removePriceLine(p); } catch (e) {} });
    srLines = [];
  }

  function syncSrLines() {
    if (!chartsReady || !candle) return;
    const d = ST.tf[coin] && ST.tf[coin][tf];
    const show = $('chkSr') && $('chkSr').checked && d && d.levels;
    const price = coinPrice(coin);
    const view = show ? Ind.presentLevels(d.levels, price) : null;
    const sig = !view ? 'off' : ['S', 'R'].map((side, idx) => {
      const list = idx === 0 ? view.supports : view.resistances;
      return list.map(lv => lv.id + ':' + lv.price.toFixed(2) + ':' + (lv.breakFlag || '')).join(',');
    }).join('|');
    if (sig === srSig) return;
    srSig = sig;
    clearSrLines();
    if (!view) return;
    function addLine(lv, color) {
      const broken = !!lv.breakFlag;
      srLines.push(candle.createPriceLine({
        price: lv.price,
        color: broken ? '#d29922' : color,
        lineWidth: lv.nearest || broken ? 2 : 1,
        lineStyle: lv.nearest || broken ? 0 : 2,
        axisLabelVisible: true,
        title: lv.id
      }));
    }
    view.supports.forEach(lv => addLine(lv, '#26a69a'));
    view.resistances.forEach(lv => addLine(lv, '#ef5350'));
  }

  function checkRow(ok, title, detail) {
    return '<div class="chk"><span class="mark ' + (ok ? 'ok' : 'no') + '">' + (ok ? '✓' : '✗') + '</span><span><b>' + esc(title) + '</b> ' + esc(detail) + '</span></div>';
  }

  function geoLine(label, lv, c) {
    if (!lv) return '<div class="muted">' + esc(label) + '：暂无</div>';
    return '<div>' + esc(label) + '：' + esc(lv.tf) + ' ' + esc(lv.id) + ' <b>' + fp(c, lv.price) + '</b> <span class="' + scls(lv.distPct) + '">' + pct(lv.distPct) + '</span></div>';
  }

  function sideBlock(name, side, c) {
    const rr = side.rr == null ? '暂无' : side.rr.toFixed(2) + '（目标空间 ' + (side.rewardPct == null ? '—' : side.rewardPct.toFixed(2) + '%') + ' / 失效距离 ' + (side.riskPct == null ? '—' : side.riskPct.toFixed(2) + '%') + '）';
    return '<div class="lv"><div><b>' + name + '</b></div>' +
      checkRow(side.trend.ok, '趋势', side.trend.detail) +
      checkRow(side.trigger.ok, '触发', side.trigger.detail) +
      checkRow(side.location.ok, '位置', side.location.detail) +
      geoLine('失效参考', side.invalidation, c) +
      geoLine('下一目标', side.target, c) +
      '<div>盈亏比 ' + esc(rr) + '</div></div>';
  }

  function renderEntry() {
    const box = $('entryBody');
    if (!box) return;
    box.innerHTML = COINS.map(c => {
      const px = coinPrice(c);
      const tfs = ST.tf[c] || {};
      if (!tfs['1H'] || !tfs['4H'] || !tfs['1D'] || px == null) {
        return '<div class="card"><b>' + c + '</b><div class="entry-word muted">计算中…</div></div>';
      }
      const plan = Ind.assessEntry(tfs, px);
      const tone = plan.verdict === '可以做多' ? 'up' : plan.verdict === '可以做空' ? 'down' : 'muted';
      let ex = '';
      try {
        const der = ST.der[c] || {};
        const fng = ST.fng.length ? ST.fng[ST.fng.length - 1].value : null;
        const ext = Ind.assessExtreme(tfs, px, { funding: der.funding, fundingAvg: der.funding_avg7d, ls: der.ls_ratio, fng: fng });
        ex = '<div class="muted">见底/见顶：底部「' + esc(ext.bottom.label) + '」，顶部「' + esc(ext.top.label) + '」。结构确认可以作为入场触发。</div>';
      } catch (e) {}
      return '<div><div class="muted">' + c + '-USDT 永续</div><div class="entry-word ' + tone + '">' + esc(plan.verdict) + '</div>' +
        sideBlock('做多条件', plan.long, c) + sideBlock('做空条件', plan.short, c) + ex + '</div>';
    }).join('');
  }

  function renderLevels() {
    const sup = $('srSup'), res = $('srRes');
    if (!sup || !res) return;
    const d = ST.tf[coin] && ST.tf[coin][tf];
    const px = coinPrice(coin);
    $('srTitle').textContent = '支撑位 / 阻力位 · ' + coin + ' ' + TFN[tf];
    if (!d || !d.levels || px == null) {
      sup.textContent = '计算中…';
      res.textContent = '计算中…';
      $('srFlags').innerHTML = '';
      $('srMeta').textContent = '';
      return;
    }
    const view = Ind.presentLevels(d.levels, px);
    $('srMeta').textContent = '现价 ' + fp(coin, px) + (d.computed ? ' · 指标 ' + fmtHM(d.computed) : '');
    const flags = [];
    view.testing.forEach(lv => flags.push('<span class="chip warn">正在测试 ' + fp(coin, lv.price) + ' ' + esc(lv.sources.join('、')) + '</span>'));
    function chips(lv) {
      const bits = [];
      if (lv.nearest) bits.push('<span class="chip near">最近</span>');
      if (lv.proximity) bits.push('<span class="chip near">接近</span>');
      if (lv.breakFlag) bits.push('<span class="chip warn">' + esc(lv.breakFlag) + '</span>');
      return bits.join('');
    }
    function card(lv, side) {
      const bits = [];
      if (lv.next) bits.push('下一' + (side === 'support' ? '支撑 ' : '阻力 ') + lv.next.label + ' ' + fp(coin, lv.next.price) + '（较现价 ' + pct(lv.next.distPct) + '）');
      if (lv.measured) bits.push('测量移动 ' + fp(coin, lv.measured.price) + '（价位' + (side === 'support' ? '减去' : '加上') + '近 20 根高低幅度 ' + fp(coin, view.rangeHeight) + '，较现价 ' + pct(lv.measured.distPct) + '）');
      if (lv.atrTarget) bits.push('1.5×ATR ' + fp(coin, lv.atrTarget.price) + '（较现价 ' + pct(lv.atrTarget.distPct) + '）');
      const head = side === 'support' ? '跌破后可能下探至：' : '突破后可能上探至：';
      const clsLv = lv.breakFlag ? 'lv broke' : (lv.nearest || lv.proximity) ? 'lv hot' : 'lv';
      if (lv.breakFlag || lv.proximity) flags.push('<span class="chip ' + (lv.breakFlag ? 'warn' : 'near') + '">' + esc(lv.id) + ' ' + esc(lv.breakFlag || '接近') + '</span>');
      return '<div class="' + clsLv + '"><div class="vrow"><b>' + esc(lv.id) + '</b> <span class="px">' + fp(coin, lv.price) + '</span> <span class="' + scls(lv.distPct) + '">' + pct(lv.distPct) + '</span> <span class="chips">' + chips(lv) + '</span></div>' +
        '<div class="muted">' + esc(lv.sources.join(' · ')) + (lv.touches ? ' · 近 120 根有 ' + lv.touches + ' 根碰到' : '') + '</div>' +
        (bits.length ? '<div class="muted">' + head + bits.join('；') + '。</div>' : '') + '</div>';
    }
    sup.innerHTML = view.supports.length ? view.supports.map(lv => card(lv, 'support')).join('') : '<div class="muted">下方价位不足。</div>';
    res.innerHTML = view.resistances.length ? view.resistances.map(lv => card(lv, 'resistance')).join('') : '<div class="muted">上方价位不足。</div>';
    $('srFlags').innerHTML = flags.join('');
    syncSrLines();
  }

  function renderExtreme() {
    const box = $('extremeBody');
    if (!box) return;
    const fng = ST.fng.length ? ST.fng[ST.fng.length - 1].value : null;
    box.innerHTML = COINS.map(c => {
      const tfs = ST.tf[c] || {};
      const px = coinPrice(c);
      if (!tfs['4H'] || !tfs['1D'] || px == null) return '<div class="card"><b>' + c + '</b> 计算中…</div>';
      const der = ST.der[c] || {};
      const ext = Ind.assessExtreme(tfs, px, { funding: der.funding, fundingAvg: der.funding_avg7d, ls: der.ls_ratio, fng: fng });
      function col(title, pack) {
        const tone = pack.label.indexOf('确认') >= 0 || pack.label.indexOf('较强') >= 0 ? (title === '底部' ? 'up' : 'down') : 'muted';
        const rows = pack.items.map(it => checkRow(it.ok, it.name + (it.ok ? ' +' + it.points : ''), it.detail)).join('');
        return '<div><div class="muted">' + title + ' ' + pack.score + ' 分</div><div class="ex-label ' + tone + '">' + esc(pack.label) + '</div>' + rows + '</div>';
      }
      const clash = ext.bottom.score >= 3 && ext.top.score >= 3
        ? '<div class="muted">底部和顶部分数都到了「可能」以上，两边同时有信号，不能当成已经选边。</div>' : '';
      return '<div style="margin-bottom:14px"><b>' + c + '</b><div class="grid2" style="margin-top:8px">' + col('底部', ext.bottom) + col('顶部', ext.top) + '</div>' + clash + '</div>';
    }).join('');
  }

  function renderAll() {
    try { buildSummary(); } catch (err) { console.error(err); }
    renderEntry();
    renderVerdicts();
    renderDetail();
    renderExtreme();
    renderMtf();
    renderSent();
    renderMacro();
    renderNews();
    renderMeta();
  }

  // ---------- market data ----------
  function applyTicker(c, t) {
    const last = parseFloat(t.last);
    const open24h = parseFloat(t.open24h);
    ST.ticker[c] = {
      last: last,
      open24h: open24h,
      high24h: parseFloat(t.high24h),
      low24h: parseFloat(t.low24h),
      chg24h: open24h ? (last / open24h - 1) * 100 : null,
      ts: Number(t.ts) || Date.now()
    };
    live[c] = last;
    liveCandle(c, last);
    ST.updated.ticker = Date.now();
  }

  async function refreshKlines() {
    const jobs = [];
    COINS.forEach(c => TFS.forEach(frame => jobs.push([c, frame])));
    await Promise.all(jobs.map(async ([c, frame]) => {
      const key = 'klines ' + c + ' ' + frame;
      try {
        const data = await okx('/api/v5/market/candles?instId=' + c + '-USDT-SWAP&bar=' + TF_BAR[frame] + '&limit=300');
        const rows = data.slice().reverse();
        const res = Ind.analyzeRows(rows);
        if (!res) throw new Error('K线不足');
        res.computed = Date.now();
        ST.tf[c][frame] = res;
        ST.chart[c + '_' + frame] = res.chart;
        setErr(key, null);
      } catch (e) {
        setErr(key, e);
      }
    }));
    ST.updated.klines = Date.now();
    const px = live[coin];
    drawChart(false);
    if (px != null) liveCandle(coin, px);
    renderAll();
  }

  async function refreshDerivatives() {
    await Promise.all(COINS.map(async c => {
      const inst = c + '-USDT-SWAP';
      const out = {};
      try {
        const fr = (await okx('/api/v5/public/funding-rate?instId=' + inst))[0];
        out.funding = parseFloat(fr.fundingRate);
        out.next_funding = fmtHM(Number(fr.fundingTime));
        const hist = await okx('/api/v5/public/funding-rate-history?instId=' + inst + '&limit=21');
        const rates = hist.map(x => parseFloat(x.realizedRate)).filter(x => !Number.isNaN(x));
        if (rates.length) out.funding_avg7d = rates.reduce((a, b) => a + b, 0) / rates.length;
        setErr('funding ' + c, null);
      } catch (e) { setErr('funding ' + c, e); }
      try {
        const oi = (await okx('/api/v5/public/open-interest?instType=SWAP&instId=' + inst))[0];
        out.oi_usd = parseFloat(oi.oiUsd || 0);
        out.oi_ccy = parseFloat(oi.oiCcy);
        setErr('oi ' + c, null);
      } catch (e) { setErr('oi ' + c, e); }
      ST.der[c] = Object.assign(ST.der[c] || {}, out);
    }));
    ST.updated.funding = Date.now();
    renderAll();
  }

  async function refreshTickers() {
    await Promise.all(COINS.map(async c => {
      try {
        const t = (await okx('/api/v5/market/ticker?instId=' + c + '-USDT-SWAP'))[0];
        applyTicker(c, t);
        setErr('ticker ' + c, null);
      } catch (e) { setErr('ticker ' + c, e); }
    }));
    updatePrices();
    renderMeta();
  }

  function applyNews(j) {
    ST.news = j.items || [];
    ST.newsMeta = j.meta || {};
    ST.updated.news = (j.updated_unix || 0) * 1000;
    setErr('news', (j.errors || []).length && !(j.items || []).length ? (j.errors || []).join('；') : null);
  }
  function applyMacro(j) {
    ST.fng = j.fng || [];
    ST.macro = j.markets || {};
    const ts = (j.updated_unix || 0) * 1000;
    ST.updated.macro = ts;
    ST.updated.fng = ts;
    setErr('macro', (j.errors || []).length && !Object.keys(ST.macro).length ? (j.errors || []).join('；') : null);
  }
  function applyDerivativesFile(j) {
    ST.updated.ls = (j.updated_unix || 0) * 1000;
    COINS.forEach(c => {
      const d = (j.coins && j.coins[c]) || {};
      ST.der[c] = Object.assign(ST.der[c] || {}, {
        ls_ratio: d.ls_ratio,
        ls_hist: d.ls_hist,
        oi_all_usd: d.oi_all_usd,
        oi_chg24h: d.oi_chg24h
      });
    });
    setErr('derivatives', (j.errors || []).length && !((j.coins || {}).BTC || {}).ls_ratio ? (j.errors || []).join('；') : null);
  }

  async function refreshStatic() {
    const jobs = [
      ['news', applyNews],
      ['macro', applyMacro],
      ['derivatives', applyDerivativesFile]
    ];
    await Promise.all(jobs.map(async ([name, fn]) => {
      try { fn(await loadJson(name)); setErr('file ' + name, null); }
      catch (e) { setErr('file ' + name, e); }
    }));
    renderAll();
  }

  // ---------- websocket ----------
  let ws, wsOk = false, pingT, wsAttempt = 0;
  function setWs(ok, text) {
    wsOk = ok;
    $('wsdot').className = 'dot ' + (ok ? 'ok' : 'bad');
    $('wsstat').textContent = text;
  }
  function connectWs() {
    const url = WS_URLS[Math.min(wsAttempt, WS_URLS.length - 1)];
    let opened = false;
    try { ws = new WebSocket(url); } catch (e) { scheduleReconnect(); return; }
    ws.onopen = () => {
      opened = true;
      ws.send(JSON.stringify({
        op: 'subscribe',
        args: [
          { channel: 'tickers', instId: 'BTC-USDT-SWAP' },
          { channel: 'tickers', instId: 'ETH-USDT-SWAP' }
        ]
      }));
      clearInterval(pingT);
      pingT = setInterval(() => { try { ws.send('ping'); } catch (e) {} }, 20000);
    };
    ws.onmessage = ev => {
      if (ev.data === 'pong' || ev.data === 'ping') {
        if (ev.data === 'ping') { try { ws.send('pong'); } catch (e) {} }
        return;
      }
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m.data) return;
      const port = url.indexOf(':8443') >= 0 ? '8443' : '443';
      setWs(true, 'OKX 实时价格已连接（' + port + '）');
      m.data.forEach(t => {
        const c = String(t.instId || '').split('-')[0];
        if (COINS.indexOf(c) < 0) return;
        applyTicker(c, t);
      });
      updatePrices();
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      clearInterval(pingT);
      setWs(false, '实时连接断开，每 10 秒轮询价格');
      if (!opened) wsAttempt++;
      scheduleReconnect();
    };
  }
  let reconnT;
  function scheduleReconnect() {
    clearTimeout(reconnT);
    reconnT = setTimeout(connectWs, 5000);
  }

  function seg(id, cb) {
    $(id).querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => {
        $(id).querySelectorAll('button').forEach(x => {
          x.classList.remove('on');
          x.setAttribute('aria-pressed', 'false');
        });
        b.classList.add('on');
        b.setAttribute('aria-pressed', 'true');
        cb(b.dataset.v);
      });
    });
  }

  function tickClock() {
    $('clock').textContent = '维也纳时间 ' + fmtFull(Date.now());
  }

  async function refreshAll() {
    await Promise.all([
      refreshStatic().catch(() => {}),
      refreshKlines().catch(() => {}),
      refreshDerivatives().catch(() => {}),
      refreshTickers().catch(() => {})
    ]);
  }

  seg('segCoin', v => { coin = v; drawChart(true); renderDetail(); });
  seg('segTf', v => { tf = v; drawChart(true); renderDetail(); });
  $('chkBoll').addEventListener('change', () => drawChart(false));
  $('chkEma').addEventListener('change', () => drawChart(false));
  $('chkSr').addEventListener('change', () => { srSig = ''; syncSrLines(); });
  seg('newsFilter', v => { newsFilter = v; renderNews(); });
  $('btnRefresh').addEventListener('click', () => { refreshAll(); });

  tickClock();
  setInterval(tickClock, 1000);
  initCharts();
  connectWs();
  refreshAll().then(() => drawChart(true));
  setInterval(() => { refreshKlines().catch(() => {}); }, 60000);
  setInterval(() => { refreshDerivatives().catch(() => {}); }, 180000);
  setInterval(() => { refreshStatic().catch(() => {}); }, 60000);
  setInterval(() => { if (!wsOk) refreshTickers().catch(() => {}); }, 10000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshAll().catch(() => {});
  });
})();
