/* 浏览器端行情、指标与页面。新闻 / 宏观 / 多空比读取仓库里的 JSON。 */
(function () {
  'use strict';

  const COINS = ['BTC', 'ETH'];
  const TFS = ['5m', '15m', '1H', '4H', '1D', '1W'];
  const TF_BAR = { '1m': '1m', '5m': '5m', '15m': '15m', '1H': '1H', '4H': '4H', '1D': '1Dutc', '1W': '1Wutc' };
  const TFN = { '1m': '1分钟', '5m': '5分钟', '15m': '15分钟', '1H': '1小时', '4H': '4小时', '1D': '日线', '1W': '周线' };
  const FETCH_TFS = ['1m', '5m', '15m', '1H', '4H', '1D', '1W'];
  const CORE_TFS = ['1H', '4H', '1D'];
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
  const LIQ = { BTC: [], ETH: [] };
  ST.book = { BTC: null, ETH: null };
  ST.rows = {};
  const LIQ_SEEN = { BTC: new Set(), ETH: new Set() };
  const CTVAL = { BTC: 0.01, ETH: 0.1 };

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
      const has15 = !!tfs['15m'];
      const tech = has15
        ? round1(tfs['15m'].score * 0.1 + tfs['1H'].score * 0.2 + tfs['4H'].score * 0.3 + tfs['1D'].score * 0.4)
        : round1(tfs['1H'].score * 0.2 + tfs['4H'].score * 0.3 + tfs['1D'].score * 0.5);
      const weightNote = has15
        ? '15分钟×0.1 + 1小时×0.2 + 4小时×0.3 + 日线×0.4'
        : '1小时×0.2 + 4小时×0.3 + 日线×0.5（15分钟未就绪，不挡综合分）';
      let sent = Ind.sentimentAdj(fngNow, ST.der[c] || {});
      if (!fngOk) sent = [['恐惧贪婪指数', 0, '暂无数据']].concat(sent.filter(f => f[0] !== '恐惧贪婪指数'));
      const na = Ind.newsAdj(c, ST.news, now);
      const total = round1(tech + sent.reduce((a, f) => a + f[1], 0) + na[0]);
      ST.summary[c] = {
        tech: tech, weightNote: weightNote, sentiment: sent, news_adj: na[0], news_stat: na[1],
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
        '<div class="muted">' + TFS.filter(k => tfs[k]).map(k => TFN[k] + ' <span class="' + scls(tfs[k].score) + '">' + esc(tfs[k].signal) + ' ' + sgn(tfs[k].score) + '</span>').join(' · ') + '</div>' +
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
    if (now - auxTimer > 1000) { auxTimer = now; renderOverall(); renderEntry(); renderLevels(); renderExtreme(); }
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
      rows += '<tr><td>技术面加权</td><td class="n ' + scls(s.tech) + '">' + sgn(s.tech) + '</td><td>' + esc(s.weightNote || '1小时×0.2 + 4小时×0.3 + 日线×0.5') + '</td></tr>';
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
    let h = '<tr><th>币种</th>' + TFS.map(k => '<th>' + TFN[k] + '</th>').join('') + '<th class="n">RSI ' + TFS.map(k => TFN[k]).join('/') + '</th><th>综合</th></tr>';
    COINS.forEach(c => {
      const t = ST.tf[c], s = ST.summary[c];
      if (!t || !s || !CORE_TFS.every(k => t[k])) return;
      h += '<tr><td>' + c + '</td>' + TFS.map(k => t[k]
        ? '<td><span class="sig ' + cls(t[k].signal) + '">' + esc(t[k].signal) + ' ' + sgn(t[k].score) + '</span></td>'
        : '<td>—</td>').join('') +
        '<td class="n">' + TFS.map(k => t[k] ? Number(t[k].ind.rsi).toFixed(0) : '—').join(' / ') + '</td>' +
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
        '<a href="' + esc(safeUrl(n.link)) + '" target="_blank" rel="noopener noreferrer">' + esc(n.title_zh && n.title_zh !== n.title ? n.title_zh : n.title) + '</a>' +
        (fresh ? '<span class="badge-new">新</span>' : '') +
        (n.title_zh && n.title_zh !== n.title ? '<div class="orig">' + esc(n.title) + '</div>' : '') + '</div>' +
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

  function usdTxt(v) {
    if (v == null || !isFinite(Number(v))) return '—';
    const n = Number(v);
    if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 亿美元';
    if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 万美元';
    return n.toFixed(0) + ' 美元';
  }

  function addLiq(c, ev) {
    if (!LIQ[c] || !ev || !ev.ts) return;
    const key = ev.ts + '|' + ev.px + '|' + ev.sz + '|' + ev.posSide;
    if (LIQ_SEEN[c].has(key)) return;
    LIQ_SEEN[c].add(key);
    LIQ[c].push(ev);
    if (LIQ[c].length > 5000) {
      LIQ[c] = LIQ[c].slice(-4000);
      LIQ_SEEN[c] = new Set(LIQ[c].map(x => x.ts + '|' + x.px + '|' + x.sz + '|' + x.posSide));
    }
  }

  function ingestDetails(instId, details) {
    const c = String(instId || '').split('-')[0];
    if (COINS.indexOf(c) < 0) return;
    const ct = CTVAL[c] || 0.01;
    (details || []).forEach(d => {
      const px = parseFloat(d.bkPx);
      const sz = parseFloat(d.sz);
      if (!isFinite(px) || !isFinite(sz)) return;
      addLiq(c, { ts: Number(d.ts || d.time), px: px, sz: sz, usd: sz * ct * px, posSide: d.posSide === 'short' ? 'short' : 'long' });
    });
  }

  function extremeCtx(c, px) {
    const der = ST.der[c] || {};
    const fng = ST.fng.length ? ST.fng[ST.fng.length - 1].value : null;
    const sum = Ind.summarizeLiquidations(LIQ[c] || [], Date.now());
    const book = ST.tf[c] && ST.tf[c]['4H'] && ST.tf[c]['4H'].levels;
    const view = book ? Ind.presentLevels(book, px) : null;
    const near = !!(view && view.supports[0] && Math.abs(view.supports[0].distPct) <= 1);
    return {
      funding: der.funding,
      fundingAvg: der.funding_avg7d,
      ls: der.ls_ratio,
      fng: fng,
      liq: { long1h: sum.h1.long, short1h: sum.h1.short, long4h: sum.h4.long, short4h: sum.h4.short },
      liqMin: c === 'BTC' ? 1000000 : 300000,
      nearSupport: near
    };
  }

  function countdown(ms) {
    if (!ms) return '—';
    let s = Math.floor((Number(ms) - Date.now()) / 1000);
    if (s < 0) s = 0;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h + '小时' + String(m).padStart(2, '0') + '分' + String(sec).padStart(2, '0') + '秒';
  }

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

  function zonesFor(c, px) {
    if (px == null) return null;
    const h1 = ST.tf[c] && ST.tf[c]['1H'] && ST.tf[c]['1H'].chart;
    const entries = [];
    if (h1) {
      const start = Math.max(0, h1.c.length - 24);
      for (let i = start; i < h1.c.length; i++) entries.push({ price: h1.c[i], vol: h1.v[i] || 0 });
    }
    const der = ST.der[c] || {};
    return Ind.estimateLiqZones(px, entries, der.oi_usd || 0, der.oi_chg24h);
  }

  function syncSrLines() {
    if (!chartsReady || !candle) return;
    const d = ST.tf[coin] && ST.tf[coin][tf];
    const price = coinPrice(coin);
    const show = $('chkSr') && $('chkSr').checked && d && d.levels;
    const view = show ? Ind.presentLevels(d.levels, price) : null;
    const zones = $('chkLiq') && $('chkLiq').checked ? zonesFor(coin, price) : null;
    const sig = (view ? ['S', 'R'].map((side, idx) => {
      const list = idx === 0 ? view.supports : view.resistances;
      return list.map(lv => lv.id + ':' + lv.price.toFixed(2) + ':' + (lv.breakFlag || '')).join(',');
    }).join('|') : 'off') + '#' + (zones && zones.nearestLong ? zones.nearestLong.price.toFixed(1) : '') + '/' + (zones && zones.nearestShort ? zones.nearestShort.price.toFixed(1) : '');
    if (sig === srSig) return;
    srSig = sig;
    clearSrLines();
    function addLine(priceLv, title, color, dashed) {
      srLines.push(candle.createPriceLine({
        price: priceLv, color: color, lineWidth: dashed ? 1 : 2, lineStyle: dashed ? 2 : 0,
        axisLabelVisible: true, title: title
      }));
    }
    if (view) {
      view.supports.forEach(lv => addLine(lv.price, lv.id, lv.breakFlag ? '#d29922' : '#26a69a', !(lv.nearest || lv.breakFlag)));
      view.resistances.forEach(lv => addLine(lv.price, lv.id, lv.breakFlag ? '#d29922' : '#ef5350', !(lv.nearest || lv.breakFlag)));
    }
    if (zones && zones.nearestLong) addLine(zones.nearestLong.price, '估多' + zones.nearestLong.lev + 'x', '#d29922', true);
    if (zones && zones.nearestShort) addLine(zones.nearestShort.price, '估空' + zones.nearestShort.lev + 'x', '#c678dd', true);
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
        const ext = Ind.assessExtreme(tfs, px, extremeCtx(c, px));
        ex = '<div class="muted">见底/见顶：底部「' + esc(ext.bottom.label) + '」，顶部「' + esc(ext.top.label) + '」。结构确认可以作为入场触发。</div>';
        const z = zonesFor(c, px);
        if (z && z.nearestShort) ex += '<div class="muted">上方空头清算估计区 ' + fp(c, z.nearestShort.price) + '（' + z.nearestShort.lev + 'x，约 ' + usdTxt(z.nearestShort.usd) + '，' + pct(z.nearestShort.distPct) + '）。这是估计磁铁，可当作上探参考，不是确定目标。</div>';
        if (z && z.nearestLong) ex += '<div class="muted">下方多头清算估计区 ' + fp(c, z.nearestLong.price) + '（' + z.nearestLong.lev + 'x，约 ' + usdTxt(z.nearestLong.usd) + '，' + pct(z.nearestLong.distPct) + '）。</div>';
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
    box.innerHTML = COINS.map(c => {
      const tfs = ST.tf[c] || {};
      const px = coinPrice(c);
      if (!tfs['4H'] || !tfs['1D'] || px == null) return '<div class="card"><b>' + c + '</b> 计算中…</div>';
      const ext = Ind.assessExtreme(tfs, px, extremeCtx(c, px));
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

  function liqSvg(buckets) {
    const w = 300, h = 64;
    let max = 1;
    buckets.forEach(b => { if (b.long + b.short > max) max = b.long + b.short; });
    const bw = w / buckets.length;
    const rects = buckets.map((b, i) => {
      const hl = (b.long / max) * (h - 2);
      const hs = (b.short / max) * (h - 2);
      const x = i * bw;
      return '<rect x="' + x.toFixed(1) + '" y="' + (h - hl).toFixed(1) + '" width="' + (bw * 0.42).toFixed(1) + '" height="' + Math.max(0, hl).toFixed(1) + '" fill="#ef5350"/>' +
        '<rect x="' + (x + bw * 0.48).toFixed(1) + '" y="' + (h - hs).toFixed(1) + '" width="' + (bw * 0.42).toFixed(1) + '" height="' + Math.max(0, hs).toFixed(1) + '" fill="#26a69a"/>';
    }).join('');
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="72" aria-label="每小时清算金额">' + rects + '</svg>';
  }

  function fundSvg(hist) {
    const w = 300, h = 72, mid = h / 2;
    let max = 0.00005;
    hist.forEach(p => { if (Math.abs(p.rate) > max) max = Math.abs(p.rate); });
    const bw = w / Math.max(1, hist.length);
    const bars = hist.map((p, i) => {
      const bh = Math.abs(p.rate) / max * (mid - 4);
      const y = p.rate >= 0 ? mid - bh : mid;
      const color = p.rate >= 0 ? '#ef5350' : '#26a69a';
      return '<rect x="' + (i * bw + 1).toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + Math.max(1, bw - 2).toFixed(1) + '" height="' + Math.max(1, bh).toFixed(1) + '" fill="' + color + '"/>';
    }).join('');
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="80" aria-label="资金费率历史"><line x1="0" x2="' + w + '" y1="' + mid + '" y2="' + mid + '" stroke="#30363d"/>' + bars + '</svg>';
  }

  function renderLiq() {
    const box = $('liqBody');
    if (!box) return;
    const now = Date.now();
    box.innerHTML = COINS.map(c => {
      const events = LIQ[c] || [];
      const sum = Ind.summarizeLiquidations(events, now);
      const buckets = Ind.liqBuckets(events, now);
      const px = coinPrice(c);
      const z = px == null ? null : zonesFor(c, px);
      const spanH = sum.spanMs ? (sum.spanMs / 3600000) : 0;
      function pair(w) {
        return '多头 ' + usdTxt(w.long) + ' / 空头 ' + usdTxt(w.short);
      }
      const top = events.slice().sort((a, b) => b.usd - a.usd).slice(0, 6);
      const rows = top.map(ev => '<tr><td>' + (ev.posSide === 'short' ? '空头被清算' : '多头被清算') + '</td><td class="n">' + fp(c, ev.px) + '</td><td class="n">' + usdTxt(ev.usd) + '</td><td class="n">' + fmtMDHM(ev.ts) + '</td></tr>').join('');
      function zoneRows(list, side) {
        if (!list || !list.length) return '<div class="muted">暂无</div>';
        const max = Math.max.apply(null, list.map(x => x.usd || 0)) || 1;
        return list.map(lv => {
          const width = lv.usd ? Math.max(8, Math.round((lv.usd / max) * 100)) : 20;
          const hot = z && ((side === 'long' && z.nearestLong && z.nearestLong.lev === lv.lev) || (side === 'short' && z.nearestShort && z.nearestShort.lev === lv.lev));
          return '<div class="vrow"><span>' + lv.lev + 'x</span> <b>' + fp(c, lv.price) + '</b> <span class="' + scls(lv.distPct) + '">' + pct(lv.distPct) + '</span> <span class="muted">' + usdTxt(lv.usd) + (hot ? ' · 最近的大区' : '') + '</span></div>' +
            '<div style="height:6px;background:#21262d;border-radius:4px;margin:2px 0 6px"><div style="height:6px;width:' + width + '%;background:' + (side === 'long' ? '#d29922' : '#c678dd') + ';border-radius:4px"></div></div>';
        }).join('');
      }
      return '<div style="margin-bottom:14px"><b>' + c + '</b> <span class="muted">' + events.length + ' 笔，跨度约 ' + spanH.toFixed(1) + ' 小时</span>' +
        '<div class="muted">1 小时 ' + pair(sum.h1) + '</div>' +
        '<div class="muted">4 小时 ' + pair(sum.h4) + '</div>' +
        '<div class="muted">24 小时 ' + pair(sum.h24) + (spanH < 20 ? '（记录还不满 24 小时）' : '') + '</div>' +
        liqSvg(buckets) +
        '<div class="muted">红柱是多头被清算，绿柱是空头被清算，每柱约 1 小时。</div>' +
        '<div class="scroll"><table><tr><th>方向</th><th class="n">价格</th><th class="n">金额</th><th class="n">时间</th></tr>' + (rows || '<tr><td colspan="4">暂无</td></tr>') + '</table></div>' +
        '<div class="grid2" style="margin-top:8px"><div><div class="subh">下方多头清算估计区</div>' + (z ? zoneRows(z.longZones, 'long') : '') + '</div><div><div class="subh">上方空头清算估计区</div>' + (z ? zoneRows(z.shortZones, 'short') : '') + '</div></div></div>';
    }).join('');
    if ($('liqMeta')) $('liqMeta').textContent = ST.updated.liq ? '记录更新于 ' + fmtHM(ST.updated.liq) : '';
  }

  function renderFunding() {
    const box = $('fundBody');
    if (!box) return;
    box.innerHTML = COINS.map(c => {
      const d = ST.der[c] || {};
      const rate = d.funding;
      const pct8 = rate == null ? null : rate * 100;
      const day = pct8 == null ? null : pct8 * 3;
      const year = rate == null ? null : rate * 3 * 365 * 100;
      let flag = '';
      if (pct8 != null && pct8 > 0.05) flag = '<span class="chip warn">多头拥挤 · 轧多风险</span>';
      else if (pct8 != null && pct8 < -0.03) flag = '<span class="chip near">空头拥挤</span>';
      const payer = rate == null ? '—' : rate > 0 ? '多头付给空头' : rate < 0 ? '空头付给多头' : '双方都不付';
      const next = d.next_funding_rate == null || Number.isNaN(d.next_funding_rate) ? '暂未公布' : (d.next_funding_rate * 100).toFixed(4) + '%';
      const hist = d.funding_hist || [];
      return '<div class="lv"><div class="vrow"><b>' + c + '</b> <span class="px ' + (rate > 0 ? 'down' : rate < 0 ? 'up' : '') + '">' + (pct8 == null ? '—' : (pct8 > 0 ? '+' : '') + pct8.toFixed(4) + '%') + '</span> ' + flag + '</div>' +
        '<div class="muted">每 8 小时 · ' + payer + '</div>' +
        '<div class="kv">' +
        '<div>预测下期</div><div>' + next + '</div>' +
        '<div>距下次结算</div><div data-fund-cd="' + (d.funding_time || '') + '">' + countdown(d.funding_time) + '</div>' +
        '<div>年化（按每天 3 次）</div><div>' + (year == null ? '—' : (year > 0 ? '+' : '') + year.toFixed(2) + '%') + '</div>' +
        '<div>每 8 小时占名义本金</div><div>' + (pct8 == null ? '—' : Math.abs(pct8).toFixed(4) + '%') + '</div>' +
        '<div>每天占名义本金</div><div>' + (day == null ? '—' : Math.abs(day).toFixed(4) + '%') + '</div>' +
        '<div>近 7 天平均</div><div>' + (d.funding_avg7d == null ? '—' : (d.funding_avg7d * 100).toFixed(4) + '%') + '</div>' +
        '</div>' +
        (hist.length ? fundSvg(hist) + '<div class="muted">红柱费率为正（多头付费），绿柱为负（空头付费）。每根是一次 8 小时结算。</div>' : '<div class="muted">费率历史加载中。</div>') +
        '</div>';
    }).join('');
    if ($('fundMeta')) $('fundMeta').textContent = ST.updated.funding ? '更新于 ' + fmtHM(ST.updated.funding) : '';
  }

  function srSnapshot(c, px) {
    const tf = ST.tf[c] && (ST.tf[c]['4H'] || ST.tf[c]['1H']);
    if (!tf || !tf.levels || px == null) return null;
    const view = Ind.presentLevels(tf.levels, px);
    const sup = view.supports[0];
    const res = view.resistances[0];
    return {
      nearSupport: !!(sup && Math.abs(sup.distPct) <= 0.5),
      nearResistance: !!(res && Math.abs(res.distPct) <= 0.5),
      brokeDown: view.resistances.some(lv => lv.breakFlag === '刚刚跌破'),
      brokeUp: view.supports.some(lv => lv.breakFlag === '刚刚突破'),
      supportDist: sup ? sup.distPct : null,
      resistDist: res ? res.distPct : null,
      nextDown: sup && sup.next ? sup.next.price : null
    };
  }

  function recentLiqUsd(c, minutes) {
    const cut = Date.now() - minutes * 60000;
    let longUsd = 0;
    let shortUsd = 0;
    (LIQ[c] || []).forEach(e => {
      if (e.ts < cut) return;
      if (e.posSide === 'short') shortUsd += e.usd || 0;
      else longUsd += e.usd || 0;
    });
    return { longUsd: longUsd, shortUsd: shortUsd };
  }

  function srUnitFrom(c, keys, px) {
    let tf = null;
    let key = null;
    for (let i = 0; i < keys.length; i++) {
      if (ST.tf[c] && ST.tf[c][keys[i]] && ST.tf[c][keys[i]].levels) { tf = ST.tf[c][keys[i]]; key = keys[i]; break; }
    }
    if (!tf || px == null) return { unit: null, text: '支撑阻力未就绪', line: '支撑阻力未就绪' };
    const view = Ind.presentLevels(tf.levels, px);
    const sup = view.supports[0];
    const res = view.resistances[0];
    const brokeDown = view.resistances.some(lv => lv.breakFlag === '刚刚跌破');
    const brokeUp = view.supports.some(lv => lv.breakFlag === '刚刚突破');
    let unit = 0;
    let text = TFN[key] || '';
    if (brokeDown && !brokeUp) { unit = -0.85; text += ' 刚跌破支撑'; }
    else if (brokeUp && !brokeDown) { unit = 0.85; text += ' 刚向上突破'; }
    else if (sup && Math.abs(sup.distPct) <= 0.5 && !(res && Math.abs(res.distPct) <= 0.5)) { unit = 0.7; text += ' 靠近支撑'; }
    else if (res && Math.abs(res.distPct) <= 0.5 && !(sup && Math.abs(sup.distPct) <= 0.5)) { unit = -0.7; text += ' 靠近阻力'; }
    else if (sup && res) {
      unit = Math.abs(sup.distPct) < Math.abs(res.distPct) ? 0.25 : -0.25;
      text += Math.abs(sup.distPct) < Math.abs(res.distPct) ? ' 离支撑更近' : ' 离阻力更近';
    }
    const line = [sup ? '支撑 ' + sup.id + ' ' + fp(c, sup.price) + '（' + pct(sup.distPct) + '）' : '', res ? '阻力 ' + res.id + ' ' + fp(c, res.price) + '（' + pct(res.distPct) + '）' : ''].filter(Boolean).join(' · ');
    return { unit: unit, text: text, line: line || '暂无价位' };
  }

  function horizonBlock(title, call, srText) {
    const tone = call.strength.indexOf('做多') >= 0 ? 'up' : call.strength.indexOf('做空') >= 0 ? 'down' : 'muted';
    const reasons = (call.factors || []).slice().sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)).slice(0, 3)
      .map(f => esc(f.name) + ' ' + esc(f.reading)).join('；');
    return '<div class="hz"><div class="vrow"><b>' + title + '</b> <span class="sig ' + (tone === 'up' ? 's-up' : tone === 'down' ? 's-down' : 's-flat') + '">' + esc(call.strength) + '</span> <span class="' + scls(call.score) + '">' + (call.score == null ? '—' : sgn(call.score)) + '</span> <span class="muted">信心 ' + esc(call.confidence) + '</span></div>' +
      '<div>' + esc(call.rationale) + '</div>' +
      '<div class="muted">' + (reasons || '因子还没到齐') + '</div>' +
      '<div class="muted">' + srText + '</div></div>';
  }

  function renderOverall() {
    const box = $('overallBody');
    if (!box) return;
    box.innerHTML = COINS.map(c => {
      const px = coinPrice(c);
      const tfs = ST.tf[c] || {};
      const s = ST.summary[c];
      const funding = (ST.der[c] || {}).funding;
      const inf = ST.influence && ST.influence.bias != null ? ST.influence : null;
      let entry = null;
      let extreme = null;
      if (tfs['1H'] && tfs['4H'] && tfs['1D'] && px != null) {
        try {
          const plan = Ind.assessEntry(tfs, px);
          const hits = side => [side.trend, side.trigger, side.location].filter(x => x && x.ok).length;
          entry = { ready: plan.ready, verdict: plan.verdict, longHits: hits(plan.long), shortHits: hits(plan.short) };
          const ext = Ind.assessExtreme(tfs, px, extremeCtx(c, px));
          extreme = { bottom: ext.bottom.label, top: ext.top.label };
        } catch (e) {}
      }
      const pulse = Ind.shortPulse(tfs['1m'], px);
      const book = ST.book[c];
      const near = recentLiqUsd(c, 15);
      let liqUnit = null;
      let liqText = '近15分钟还没有清算记录';
      if (near.longUsd + near.shortUsd > 0) {
        liqUnit = (near.shortUsd - near.longUsd) / (near.longUsd + near.shortUsd);
        liqText = '多头被清算 ' + usdTxt(near.longUsd) + '，空头被清算 ' + usdTxt(near.shortUsd);
      }
      const scalpSr = srUnitFrom(c, ['5m', '15m'], px);
      const scalp = Ind.horizonScalp({
        pulse: pulse,
        m5: tfs['5m'] ? tfs['5m'].score : null,
        m5Text: tfs['5m'] ? tfs['5m'].signal + ' ' + sgn(tfs['5m'].score) : '',
        m15: tfs['15m'] ? tfs['15m'].score : null,
        m15Text: tfs['15m'] ? tfs['15m'].signal + ' ' + sgn(tfs['15m'].score) : '',
        book: book ? Math.max(-1, Math.min(1, book.imb)) : null,
        bookText: book ? '买盘 ' + (book.imb >= 0 ? '偏多 ' : '偏空 ') + (book.imb * 100).toFixed(0) + '%' : '',
        liqUnit: liqUnit,
        liqText: liqText,
        funding: funding,
        srUnit: scalpSr.unit,
        srText: scalpSr.text
      });
      const swingTech = (tfs['1H'] && tfs['4H'] && tfs['1D'])
        ? round1(tfs['1H'].score * 0.2 + tfs['4H'].score * 0.3 + tfs['1D'].score * 0.5) : null;
      const sum = Ind.summarizeLiquidations(LIQ[c] || [], Date.now());
      const z = px == null ? null : zonesFor(c, px);
      const swing = Ind.overallCall({
        tech: swingTech,
        timeframes: ['1H', '4H', '1D'].filter(k => tfs[k]).map(k => ({ name: TFN[k], score: tfs[k].score, signal: tfs[k].signal })),
        sr: srSnapshot(c, px),
        entry: entry,
        extreme: extreme,
        funding: funding,
        liq: {
          long1h: sum.h1.long, short1h: sum.h1.short,
          longZoneDist: z && z.nearestLong ? z.nearestLong.distPct : null,
          shortZoneDist: z && z.nearestShort ? z.nearestShort.distPct : null
        },
        fng: ST.fng.length ? ST.fng[ST.fng.length - 1].value : null,
        hasNews: (ST.news || []).length > 0,
        newsAdj: s ? s.news_adj : null,
        newsStat: s ? s.news_stat : null,
        influence: inf
      });
      const longSr = srUnitFrom(c, ['1W', '1D'], px);
      const weekly = tfs['1W'];
      const daily = tfs['1D'];
      const longer = Ind.horizonLong({
        weeklyScore: weekly ? weekly.score : null,
        weeklyText: weekly ? weekly.signal + ' ' + sgn(weekly.score) + (weekly.ind.ema200 != null ? '，EMA200 ' + fp(c, weekly.ind.ema200) : '') : '',
        dailyScore: daily ? daily.score : null,
        dailyText: daily ? daily.signal + ' ' + sgn(daily.score) : '',
        weeklyRsi: weekly ? weekly.ind.rsi : null,
        aboveEma200: weekly && weekly.ind.ema200 != null ? px > weekly.ind.ema200 : null,
        srUnit: longSr.unit,
        srText: longSr.text,
        influence: inf,
        fng: ST.fng.length ? ST.fng[ST.fng.length - 1].value : null,
        extreme: extreme
      });
      const bits = [['超短线', scalp], ['中线', swing], ['长线', longer]];
      const headline = bits.map(b => b[0] + b[1].strength).join('，');
      const disagree = bits.some(b => b[1].call !== bits[0][1].call);
      return '<div><div class="muted">' + c + '-USDT 永续</div><div class="' + (disagree ? 'warn' : '') + '" style="font-weight:650;margin:4px 0 8px">' + esc(headline) + '</div>' +
        horizonBlock('超短线', scalp, scalpSr.line) +
        horizonBlock('中线', swing, srUnitFrom(c, ['4H', '1H'], px).line) +
        horizonBlock('长线', longer, longSr.line) + '</div>';
    }).join('');
  }

  function renderUs() {
    const box = $('usBody');
    if (!box) return;
    const inf = ST.influence || {};
    const session = ST.session || {};
    const names = ['标普期货 ES', '标普 500', '纳指期货 NQ', '纳斯达克100', 'VIX', '美元指数 DXY', '美10年期国债收益率', 'Coinbase', 'MicroStrategy', '贝莱德 IBIT'];
    const rows = names.filter(n => ST.macro[n]).map(n => {
      const v = ST.macro[n];
      const cell = x => x == null ? '—' : '<span class="' + scls(x) + '">' + pct(x) + '</span>';
      return '<tr><td>' + esc(n) + (v.stale ? ' <span class="warn">旧</span>' : '') + '</td><td class="n">' +
        Number(v.last).toLocaleString('en-US', { maximumFractionDigits: 3 }) + esc(v.unit || '') +
        '</td><td class="n">' + cell(v.chg_intraday) + '</td><td class="n">' + cell(v.chg_1d != null ? v.chg_1d : v.chg) +
        '</td><td class="n">' + cell(v.chg_5d) + '</td></tr>';
    }).join('');
    function corrCell(coin, idx) {
      const cell = ((ST.correlation || {})[coin] || {})[idx] || {};
      const v = cell.d30 != null ? cell.d30 : cell.d90;
      if (v == null) return '—';
      const a = Math.abs(v);
      const lab = a >= 0.6 ? '强' : a >= 0.3 ? '中' : '弱';
      return v.toFixed(2) + ' ' + lab + (cell.d90 != null ? '（90天 ' + cell.d90.toFixed(2) + '）' : '');
    }
    $('usMeta').textContent = (session.label || '时段未知') + (ST.updated.macro ? ' · 更新于 ' + fmtHM(ST.updated.macro) : '');
    box.innerHTML = '<p><b>' + esc(inf.line || '美股数据还没到。') + '</b></p>' +
      '<div class="muted">30 天相关性：BTC 对标普 ' + esc(corrCell('BTC', 'SPX')) + '，对纳指 ' + esc(corrCell('BTC', 'NDX')) +
      '；ETH 对标普 ' + esc(corrCell('ETH', 'SPX')) + '，对纳指 ' + esc(corrCell('ETH', 'NDX')) + '。</div>' +
      '<div class="scroll"><table><tr><th>品种</th><th class="n">最新</th><th class="n">日内</th><th class="n">1日</th><th class="n">5日</th></tr>' +
      (rows || '<tr><td colspan="5">暂无</td></tr>') + '</table></div>';
  }

  function renderAll() {
    try { buildSummary(); } catch (err) { console.error(err); }
    renderOverall();
    renderEntry();
    renderVerdicts();
    renderUs();
    renderLiq();
    renderFunding();
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
    COINS.forEach(c => FETCH_TFS.forEach(frame => jobs.push([c, frame])));
    await Promise.all(jobs.map(async ([c, frame]) => {
      const key = 'klines ' + c + ' ' + frame;
      try {
        const data = await okx('/api/v5/market/candles?instId=' + c + '-USDT-SWAP&bar=' + TF_BAR[frame] + '&limit=300');
        const rows = data.slice().reverse();
        ST.rows[c + '_' + frame] = rows;
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
        out.funding_time = Number(fr.fundingTime);
        out.next_funding = fmtHM(Number(fr.fundingTime));
        out.next_funding_rate = fr.nextFundingRate === '' || fr.nextFundingRate == null ? null : parseFloat(fr.nextFundingRate);
        const hist = await okx('/api/v5/public/funding-rate-history?instId=' + inst + '&limit=30');
        const rates = hist.map(x => parseFloat(x.realizedRate != null ? x.realizedRate : x.fundingRate)).filter(x => !Number.isNaN(x));
        if (rates.length) out.funding_avg7d = rates.reduce((a, b) => a + b, 0) / rates.length;
        out.funding_hist = hist.slice().reverse().map(x => ({
          t: Number(x.fundingTime),
          rate: parseFloat(x.realizedRate != null ? x.realizedRate : x.fundingRate)
        })).filter(x => !Number.isNaN(x.rate));
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
    ST.session = j.session || {};
    ST.correlation = j.correlation || {};
    ST.influence = j.influence || {};
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
  function applyLiquidations(j) {
    COINS.forEach(c => {
      const coin = (j.coins && j.coins[c]) || {};
      if (coin.ctVal) CTVAL[c] = Number(coin.ctVal) || CTVAL[c];
      (coin.events || []).forEach(ev => addLiq(c, ev));
    });
    if (j.updated_unix) ST.updated.liq = j.updated_unix * 1000;
    setErr('liq-file', (j.errors || []).length && !(j.coins && j.coins.BTC && (j.coins.BTC.events || []).length) ? j.errors.join('；') : null);
  }
  async function refreshBooks() {
    await Promise.all(COINS.map(async c => {
      try {
        const book = (await okx('/api/v5/market/books?instId=' + c + '-USDT-SWAP&sz=20'))[0];
        const bid = (book.bids || []).reduce((s, x) => s + parseFloat(x[1] || 0), 0);
        const ask = (book.asks || []).reduce((s, x) => s + parseFloat(x[1] || 0), 0);
        const tot = bid + ask;
        ST.book[c] = { bid: bid, ask: ask, imb: tot ? (bid - ask) / tot : 0, ts: Date.now() };
        setErr('book ' + c, null);
      } catch (e) { setErr('book ' + c, e); }
    }));
  }

  async function refreshLiq() {
    await Promise.all(COINS.map(async c => {
      try {
        const blocks = await okx('/api/v5/public/liquidation-orders?instType=SWAP&instFamily=' + c + '-USDT&state=filled&limit=100');
        blocks.forEach(b => ingestDetails(b.instId || (c + '-USDT-SWAP'), b.details));
        setErr('liq ' + c, null);
      } catch (e) { setErr('liq ' + c, e); }
    }));
    ST.updated.liq = Date.now();
    renderLiq();
  }

  async function refreshStatic() {
    const jobs = [
      ['news', applyNews],
      ['macro', applyMacro],
      ['derivatives', applyDerivativesFile],
      ['liquidations', applyLiquidations]
    ];
    await Promise.all(jobs.map(async ([name, fn]) => {
      try { fn(await loadJson(name)); setErr('file ' + name, null); }
      catch (e) { setErr('file ' + name, e); }
    }));
    renderAll();
  }

  const reanT = {};
  function applyWsCandle(instId, channel, row) {
    const c = String(instId || '').split('-')[0];
    const frame = channel === 'candle1m' ? '1m' : channel === 'candle5m' ? '5m' : null;
    if (!frame || COINS.indexOf(c) < 0 || !row) return;
    const key = c + '_' + frame;
    const rows = ST.rows[key];
    if (!rows || !rows.length) return;
    const ts = String(row[0]);
    const last = rows[rows.length - 1];
    if (String(last[0]) === ts) rows[rows.length - 1] = row;
    else if (Number(ts) > Number(last[0])) {
      rows.push(row);
      if (rows.length > 320) rows.shift();
    } else return;
    clearTimeout(reanT[key]);
    reanT[key] = setTimeout(() => {
      try {
        const res = Ind.analyzeRows(ST.rows[key]);
        if (!res) return;
        res.computed = Date.now();
        if (!ST.tf[c]) ST.tf[c] = {};
        ST.tf[c][frame] = res;
        ST.chart[key] = res.chart;
        if (c === coin && frame === tf) drawChart(false);
        renderOverall();
      } catch (e) {}
    }, 1500);
  }

  // ---------- websocket ----------
  let ws, wsOk = false, pingT, wsAttempt = 0, liqRenderTimer = 0;
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
          { channel: 'tickers', instId: 'ETH-USDT-SWAP' },
          { channel: 'liquidation-orders', instType: 'SWAP' },
          { channel: 'candle1m', instId: 'BTC-USDT-SWAP' },
          { channel: 'candle1m', instId: 'ETH-USDT-SWAP' },
          { channel: 'candle5m', instId: 'BTC-USDT-SWAP' },
          { channel: 'candle5m', instId: 'ETH-USDT-SWAP' }
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
      if (m.arg && String(m.arg.channel || '').indexOf('candle') === 0) {
        (m.data || []).forEach(row => applyWsCandle(m.arg.instId, m.arg.channel, row));
        return;
      }
      if (m.arg && m.arg.channel === 'liquidation-orders') {
        m.data.forEach(b => ingestDetails(b.instId, b.details));
        const now = Date.now();
        if (now - liqRenderTimer > 1500) { liqRenderTimer = now; renderLiq(); renderExtreme(); }
        return;
      }
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
    document.querySelectorAll('[data-fund-cd]').forEach(el => {
      el.textContent = countdown(el.getAttribute('data-fund-cd'));
    });
  }

  async function refreshAll() {
    await Promise.all([
      refreshStatic().catch(() => {}),
      refreshKlines().catch(() => {}),
      refreshDerivatives().catch(() => {}),
      refreshLiq().catch(() => {}),
      refreshBooks().catch(() => {}),
      refreshTickers().catch(() => {})
    ]);
  }

  seg('segCoin', v => { coin = v; drawChart(true); renderDetail(); });
  seg('segTf', v => { tf = v; drawChart(true); renderDetail(); });
  $('chkBoll').addEventListener('change', () => drawChart(false));
  $('chkEma').addEventListener('change', () => drawChart(false));
  $('chkSr').addEventListener('change', () => { srSig = ''; syncSrLines(); });
  if ($('chkLiq')) $('chkLiq').addEventListener('change', () => { srSig = ''; syncSrLines(); });
  seg('newsFilter', v => { newsFilter = v; renderNews(); });
  $('btnRefresh').addEventListener('click', () => { refreshAll(); });

  tickClock();
  setInterval(tickClock, 1000);
  initCharts();
  connectWs();
  refreshAll().then(() => drawChart(true));
  setInterval(() => { refreshKlines().catch(() => {}); }, 60000);
  setInterval(() => { refreshLiq().catch(() => {}); }, 60000);
  setInterval(() => { refreshBooks().then(() => renderOverall()).catch(() => {}); }, 15000);
  setInterval(() => { refreshDerivatives().catch(() => {}); }, 180000);
  setInterval(() => { refreshStatic().catch(() => {}); }, 60000);
  setInterval(() => { if (!wsOk) refreshTickers().catch(() => {}); }, 10000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshAll().catch(() => {});
  });
})();
