/**
 * Capital Hub — UI core, Overview and styles (Treasury › Capital Hub)
 * Pure presentation over window.CapitalHub (see capitalHub.js). Scoped to #trs-capital-hub.
 * The other tabs are registered by capitalHubTabs.js.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.CapitalHubUI) return;
  var CH = window.CapitalHub;
  if (!CH) return;

  var S = { tab: 'overview', asset: 'USDC', flow: 7, shown: false, tx: { q: '', net: '', asset: '', op: '', status: '', period: '', page: 1, open: null } };
  var UI = { S: S, tabs: {}, esc: esc, short: short, css: '' };
  var PALETTE = ['#4f8ef7', '#a78bfa', '#2563eb', '#2dd4bf', '#f43f5e', '#f59e0b', '#22c55e', '#38bdf8', '#e879f9', '#94a3b8', '#fb7185', '#34d399'];

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function short(h) { h = String(h || ''); return h.length > 14 ? h.slice(0, 6) + '…' + h.slice(-4) : (h || '—'); }
  function root() { return document.getElementById('ch-root'); }
  function visible() { var s = document.getElementById('trs-capital-hub'); return !!(s && s.classList.contains('active') && document.getElementById('page-treasury') && document.getElementById('page-treasury').classList.contains('active')); }

  // ── shared pieces ───────────────────────────────────────────────────────────
  function logo(n) {
    try { if (n.reg && typeof _nsChainLogo === 'function') return '<span class="ch-logo">' + _nsChainLogo(n.reg) + '</span>'; } catch (_) {}
    var l = String(n.name || '?').charAt(0).toUpperCase();
    return '<span class="ch-logo ch-logo-fb">' + esc(l) + '</span>';
  }
  function pill(text, tone) { return '<span class="ch-pill ch-' + (tone || 'muted') + '">' + esc(text) + '</span>'; }
  function statusPill(s) {
    var tone = s === 'Confirmed' ? 'green' : s === 'Failed' ? 'red' : s === 'Requires Review' ? 'amber' : s === 'Processing' ? 'blue' : 'muted';
    return pill(s, tone);
  }
  function stateBanner(g) {
    var m = {
      nowallet: ['info', 'Connect a wallet to load your Circle Gateway balances.'],
      idle: ['info', 'Gateway balances have not been loaded for this wallet yet.'],
      loading: ['info', 'Loading Gateway balances…'],
      error: ['err', 'Gateway is unavailable right now. Balances are not shown rather than guessed. Try Refresh.'],
      unavailable: ['err', 'The shared balance service is not available.'],
      stale: ['warn', 'Showing the last Gateway read (older than 90 s). Refresh for current balances.']
    }[g.state];
    if (!m && (g.state === 'ok' || g.state === 'stale') && g.errAssets && g.errAssets.length) m = ['warn', g.errAssets.join(', ') + ' could not be read from Gateway. Those balances are shown as unavailable, not as zero.'];
    if (!m) return '';
    return '<div class="ch-banner ch-banner-' + m[0] + '"><i class="ti ti-' + (m[0] === 'err' ? 'alert-triangle' : m[0] === 'warn' ? 'clock' : 'info-circle') + '"></i><span>' + esc(m[1]) + '</span></div>';
  }
  function usable(g) { return g.state === 'ok' || g.state === 'stale'; }
  function skel(w) { return '<span class="ch-skel" style="width:' + (w || 70) + 'px"></span>'; }
  UI.logo = logo; UI.pill = pill; UI.statusPill = statusPill; UI.stateBanner = stateBanner; UI.usable = usable; UI.skel = skel; UI.palette = PALETTE;

  function copyBtn(h) { return h ? '<button class="ch-icon" data-ch-copy="' + esc(h) + '" title="Copy" aria-label="Copy hash"><i class="ti ti-copy"></i></button>' : ''; }
  function hashCell(o) {
    if (!o.txHash) return '<span class="ch-dim">—</span>';
    var url = CH.explorerTx(o.srcChainId, o.txHash);
    return '<span class="ch-hash">' + (url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(short(o.txHash)) + '</a>' : esc(short(o.txHash))) + copyBtn(o.txHash) + '</span>';
  }
  function dt(ts) { try { var d = new Date(ts); return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit' }) + ', ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }); } catch (_) { return '—'; } }
  UI.copyBtn = copyBtn; UI.hashCell = hashCell; UI.dt = dt;

  function opRow(o) {
    var amt = CH.toAtomic(o.amount, CH.DEC[o.asset]);
    return '<tr><td>' + esc(dt(o.ts)) + '</td><td><b>' + esc(o.type) + '</b></td><td>' + esc(short(o.srcName)) + '</td><td>' + esc(String(o.dstName || '').length > 18 ? short(o.dstName) : (o.dstName || '—')) + '</td><td>' + esc(o.asset) + '</td><td class="ch-num">' + esc(amt == null ? '—' : CH.fmt(amt, CH.DEC[o.asset], CH.DEC[o.asset])) + '</td><td>' + statusPill(o.status) + '</td><td>' + hashCell(o) + '</td></tr>';
  }
  UI.opRow = opRow;
  var OPS_HEAD = '<thead><tr><th>Date &amp; Time</th><th>Operation</th><th>Source</th><th>Destination</th><th>Asset</th><th class="ch-num">Amount</th><th>Status</th><th>Tx Hash</th></tr></thead>';
  UI.OPS_HEAD = OPS_HEAD;

  // ── Overview ────────────────────────────────────────────────────────────────
  function sum(list, sym, fn) { var t = 0n; list.forEach(function (o) { if (o.asset === sym) { var a = CH.toAtomic(o.amount, CH.DEC[sym]); if (a != null && fn(o)) t += a; } }); return t; }
  function pendingOps() { return CH.ops().filter(function (o) { return o.status === 'Pending' || o.status === 'Processing' || o.status === 'Requires Review'; }); }
  UI.pendingOps = pendingOps;

  function cards(g) {
    var ok = usable(g), ld = g.state === 'loading' && !g.domains.length;
    var uni = CH.ASSETS.map(function (sym) {
      var t = ok ? CH.total(g, sym) : null, e = g.assets[sym];
      var v = ld ? skel(90) : (!ok ? '<span class="ch-dim">—</span>' : (e && e.error) ? '<span class="ch-err">Unavailable</span>' : t == null ? '<span class="ch-dim">—</span>' : '<b>' + esc(sym === 'USDC' ? '$' + CH.fmtMin2(t, 6) : CH.fmt(t, CH.DEC[sym], 8)) + '</b>');
      return '<div class="ch-kv"><span>' + esc(sym) + '</span>' + v + '</div>';
    }).join('');
    var nets = ok ? CH.networks(g) : [];
    var funded = nets.filter(function (n) { return CH.ASSETS.some(function (s) { return n.assets[s] && n.assets[s].atomic > 0n; }); }).length;
    var pend = pendingOps();
    var pendAmt = {};
    pend.forEach(function (o) { var a = CH.toAtomic(o.amount, CH.DEC[o.asset]); if (a != null) pendAmt[o.asset] = (pendAmt[o.asset] || 0n) + a; });
    var pendTxt = Object.keys(pendAmt).map(function (s) { return CH.fmt(pendAmt[s], CH.DEC[s], 6) + ' ' + s; }).join(' · ');
    var usdc = ok ? CH.total(g, 'USDC') : null;
    return '<div class="ch-cards">' +
      '<div class="ch-card"><div class="ch-card-h"><i class="ti ti-wallet"></i>Unified Balance</div>' + uni + '<div class="ch-card-f">' + (ok ? 'Funded on ' + funded + ' of ' + nets.length + ' networks' : 'Per asset, from Circle Gateway') + '</div></div>' +
      '<div class="ch-card"><div class="ch-card-h"><i class="ti ti-stack-2"></i>Available Liquidity</div>' +
        '<div class="ch-big">' + (ld ? skel(120) : ok && usdc != null ? '$' + esc(CH.fmtMin2(usdc, 6)) : '<span class="ch-dim">—</span>') + '</div>' +
        '<div class="ch-card-f">USDC spendable on Gateway now. Transfers already debited are not counted twice.</div></div>' +
      '<div class="ch-card"><div class="ch-card-h"><i class="ti ti-clock-hour-4"></i>Pending Operations</div>' +
        '<div class="ch-big">' + pend.length + '</div>' +
        '<div class="ch-card-f">' + (pend.length ? esc(pendTxt) + ' awaiting confirmation' : 'None in progress (operations started from this browser)') + '</div></div>' +
      '<div class="ch-card"><div class="ch-card-h"><i class="ti ti-topology-star-3"></i>Supported Networks</div>' +
        '<div class="ch-big">' + (ld ? skel(40) : ok ? nets.length : '<span class="ch-dim">—</span>') + '</div>' +
        '<div class="ch-card-f">' + (ok ? esc(nets.slice(0, 5).map(function (n) { return n.name; }).join(' · ')) + (nets.length > 5 ? ' +' + (nets.length - 5) : '') : 'Reported by Circle Gateway') + '</div></div>' +
      '</div>';
  }

  function actions() {
    var w = CH.wallet();
    var dis = w ? '' : ' disabled title="Connect a wallet first"';
    return '<div class="ch-actions">' +
      '<button class="ch-act ch-act-primary" data-ch-act="deposit"' + dis + '><i class="ti ti-download"></i>Deposit</button>' +
      '<button class="ch-act" data-ch-act="transfer"' + dis + '><i class="ti ti-arrows-exchange"></i>Transfer</button>' +
      '<button class="ch-act" data-ch-act="withdraw"' + dis + '><i class="ti ti-upload"></i>Withdraw</button></div>';
  }

  function assetTabs() {
    return '<div class="ch-seg" role="tablist" aria-label="Asset">' + CH.ASSETS.map(function (a) { return '<button class="' + (S.asset === a ? 'on' : '') + '" data-ch-asset="' + a + '">' + a + '</button>'; }).join('') + '</div>';
  }
  UI.assetTabs = assetTabs;

  function distribution(g) {
    var head = '<div class="ch-panel-h"><div><div class="ch-panel-t">Liquidity Distribution</div><div class="ch-panel-s">Gateway deposits by network</div></div>' + assetTabs() + '</div>';
    if (!usable(g)) return '<div class="ch-panel">' + head + '<div class="ch-empty"><i class="ti ti-chart-pie-off"></i><span>' + (g.state === 'loading' ? 'Loading…' : 'No Gateway data to show yet.') + '</span></div></div>';
    var sym = S.asset, dec = CH.DEC[sym], e = g.assets[sym];
    if (e && e.error) return '<div class="ch-panel">' + head + '<div class="ch-empty"><i class="ti ti-alert-triangle"></i><span>' + esc(sym) + ' balances are unavailable from Gateway.</span></div></div>';
    var rows = CH.networks(g).filter(function (n) { return n.assets[sym] && n.assets[sym].supported; }).map(function (n) { return { n: n, a: n.assets[sym].atomic }; });
    var tot = 0n, bad = false; rows.forEach(function (r) { if (r.a == null) bad = true; else tot += r.a; });
    if (bad) return '<div class="ch-panel">' + head + '<div class="ch-empty"><i class="ti ti-alert-triangle"></i><span>A balance could not be read exactly, so no distribution is shown.</span></div></div>';
    if (tot === 0n) return '<div class="ch-panel">' + head + '<div class="ch-empty"><i class="ti ti-database-off"></i><span>No ' + esc(sym) + ' deposited in Circle Gateway.</span></div></div>';
    rows.sort(function (x, y) { return x.n.domain === 26 ? -1 : y.n.domain === 26 ? 1 : (y.a > x.a ? 1 : y.a < x.a ? -1 : 0); });
    var segs = '', list = '';
    rows.forEach(function (r, i) {
      var bp = Number((r.a * 10000n) / tot), col = PALETTE[i % PALETTE.length];
      if (r.a > 0n) segs += '<span style="flex:' + Math.max(bp, 1) + ' 1 0;background:' + col + '" title="' + esc(r.n.name) + ' ' + (bp / 100).toFixed(1) + '%"></span>';
      list += '<div class="ch-leg' + (r.n.domain === 26 ? ' main' : '') + '"><span class="ch-dot" style="background:' + col + '"></span>' + logo(r.n) + '<span class="ch-leg-n">' + esc(r.n.name) + (r.n.domain === 26 ? ' ' + pill('Primary', 'blue') : '') + '</span>' +
        '<span class="ch-num">' + esc(CH.fmt(r.a, dec, dec)) + ' ' + esc(sym) + (sym === 'USDC' ? '<small>≈ $' + esc(CH.fmtMin2(r.a, 6)) + '</small>' : '') + '</span><span class="ch-share">' + (bp / 100).toFixed(1) + '%</span></div>';
    });
    return '<div class="ch-panel">' + head + '<div class="ch-bar">' + segs + '</div><div class="ch-legend">' + list + '</div></div>';
  }

  function flowData(sym, days) {
    var now = new Date(); now.setHours(0, 0, 0, 0);
    var start = now.getTime() - (days - 1) * 86400000;
    var b = []; for (var i = 0; i < days; i++) b.push({ t: start + i * 86400000, inn: 0n, out: 0n });
    var tin = 0n, tout = 0n, n = 0;
    CH.ops().forEach(function (o) {
      if (o.status !== 'Confirmed' || o.asset !== sym) return;
      var ts = o.confirmedAt || o.ts, idx = Math.floor((ts - start) / 86400000);
      if (idx < 0 || idx >= days) return;
      var a = CH.toAtomic(o.amount, CH.DEC[sym]); if (a == null) return;
      n++; if (o.type === 'Deposit') { b[idx].inn += a; tin += a; } else { b[idx].out += a; tout += a; }
    });
    return { b: b, tin: tin, tout: tout, n: n };
  }
  function flowPanel() {
    var sym = S.asset, dec = CH.DEC[sym], d = flowData(sym, S.flow);
    var ranges = [7, 30, 90].map(function (r) { return '<button class="' + (S.flow === r ? 'on' : '') + '" data-ch-flow="' + r + '">' + r + 'D</button>'; }).join('');
    var head = '<div class="ch-panel-h"><div><div class="ch-panel-t">Capital Flow</div><div class="ch-panel-s">Confirmed inflow vs outflow · ' + esc(sym) + ' · last ' + S.flow + ' days</div></div><div class="ch-seg">' + ranges + '</div></div>';
    if (!d.n) return '<div class="ch-panel">' + head + '<div class="ch-empty"><i class="ti ti-chart-bar-off"></i><span>No confirmed ' + esc(sym) + ' operations in this period.<br><small>Flow is built from confirmed Gateway operations started from this browser.</small></span></div></div>';
    var max = 0n; d.b.forEach(function (x) { if (x.inn > max) max = x.inn; if (x.out > max) max = x.out; });
    var W = 560, H = 150, pad = 4, slot = (W - pad * 2) / d.b.length, bw = Math.max(1.5, Math.min(14, slot * 0.34)), svg = '';
    d.b.forEach(function (x, i) {
      var cx = pad + slot * i + slot / 2;
      var hi = max ? Number((x.inn * 1000n) / max) / 1000 * (H - 18) : 0, ho = max ? Number((x.out * 1000n) / max) / 1000 * (H - 18) : 0;
      var lbl = new Date(x.t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' · In ' + CH.fmt(x.inn, dec, 6) + ' · Out ' + CH.fmt(x.out, dec, 6) + ' ' + sym;
      svg += '<g class="ch-bg" data-tip="' + esc(lbl) + '"><rect x="' + (cx - slot / 2) + '" y="0" width="' + slot + '" height="' + H + '" fill="transparent"/>' +
        (x.inn > 0n ? '<rect x="' + (cx - bw - 0.5) + '" y="' + (H - 14 - Math.max(hi, 1.5)) + '" width="' + bw + '" height="' + Math.max(hi, 1.5) + '" rx="1.5" fill="#2dd4bf"/>' : '') +
        (x.out > 0n ? '<rect x="' + (cx + 0.5) + '" y="' + (H - 14 - Math.max(ho, 1.5)) + '" width="' + bw + '" height="' + Math.max(ho, 1.5) + '" rx="1.5" fill="#a78bfa"/>' : '') + '</g>';
    });
    var first = new Date(d.b[0].t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), last = new Date(d.b[d.b.length - 1].t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return '<div class="ch-panel">' + head + '<div class="ch-chart" id="ch-chart"><svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="Capital flow">' + svg + '<line x1="0" x2="' + W + '" y1="' + (H - 14) + '" y2="' + (H - 14) + '" stroke="currentColor" opacity=".15"/></svg><div class="ch-tip" id="ch-tip"></div></div>' +
      '<div class="ch-axis"><span>' + esc(first) + '</span><span>' + esc(last) + '</span></div>' +
      '<div class="ch-flow-t"><span><i class="ch-dot" style="background:#2dd4bf"></i>Inflow <b>' + esc(CH.fmt(d.tin, dec, 6)) + '</b></span><span><i class="ch-dot" style="background:#a78bfa"></i>Outflow <b>' + esc(CH.fmt(d.tout, dec, 6)) + '</b></span></div></div>';
  }

  function recentOps() {
    var list = CH.ops().slice().sort(function (a, b) { return b.ts - a.ts; }).slice(0, 5);
    var head = '<div class="ch-panel-h"><div class="ch-panel-t">Recent Operations</div><button class="ch-link" data-ch-tab="transactions">View all</button></div>';
    if (!list.length) return '<div class="ch-panel">' + head + '<div class="ch-empty"><i class="ti ti-receipt-off"></i><span>No Gateway operations recorded for this wallet yet.</span></div></div>';
    return '<div class="ch-panel">' + head + '<div class="ch-scroll"><table class="ch-table">' + OPS_HEAD + '<tbody>' + list.map(opRow).join('') + '</tbody></table></div></div>';
  }

  function networkBalances(g) {
    var head = '<div class="ch-panel-h"><div class="ch-panel-t">Network Balances</div><button class="ch-link" data-ch-tab="networks">Details</button></div>';
    if (!usable(g)) return '<div class="ch-panel">' + head + '<div class="ch-empty"><i class="ti ti-plug-off"></i><span>' + (g.state === 'loading' ? 'Loading…' : 'Network balances are not available yet.') + '</span></div></div>';
    return '<div class="ch-panel">' + head + '<div class="ch-scroll">' + networksTable(g) + '</div></div>';
  }
  function networksTable(g) {
    var pend = pendingOps(), rows = CH.networks(g).map(function (n) {
      var cells = CH.ASSETS.filter(function (s) { return n.assets[s]; });
      var sup = cells.map(function (s) { return pill(s, n.assets[s].error ? 'red' : 'muted'); }).join(' ') || '<span class="ch-dim">—</span>';
      var bal = cells.map(function (s) { var a = n.assets[s]; return '<div>' + (a.error ? '<span class="ch-err">Unavailable</span>' : a.atomic == null ? '<span class="ch-err">Unreadable</span>' : esc(CH.fmt(a.atomic, CH.DEC[s], CH.DEC[s])) + ' <small>' + s + '</small>') + '</div>'; }).join('') || '—';
      var pn = cells.map(function (s) {
        var t = 0n; pend.forEach(function (o) { if (o.type === 'Deposit' && o.asset === s && o.domain === n.domain) { var x = CH.toAtomic(o.amount, CH.DEC[s]); if (x != null) t += x; } });
        return '<div>' + (t > 0n ? esc(CH.fmt(t, CH.DEC[s], 6)) + ' <small>' + s + '</small>' : '<span class="ch-dim">0</span>') + '</div>';
      }).join('') || '—';
      var err = !!(g.errAssets && g.errAssets.length);
      return '<tr><td><span class="ch-net">' + logo(n) + esc(n.name) + (n.domain === 26 ? ' ' + pill('Primary', 'blue') : '') + '</span></td><td>' + sup + '</td><td class="ch-num">' + bal + '</td><td class="ch-num">' + pn + '</td><td class="ch-num">' + bal + '</td><td>' + (err ? pill('Partial', 'amber') : pill('Active', 'green')) + '</td></tr>';
    }).join('');
    return '<table class="ch-table"><thead><tr><th>Network</th><th>Supported Assets</th><th class="ch-num">Gateway Balance</th><th class="ch-num">Pending Amount</th><th class="ch-num">Available Balance</th><th>Status</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="ch-note">Pending = deposits confirmed on the source chain but not yet credited by Gateway. Transfers are debited by Gateway immediately, so Available equals the Gateway balance.</div>';
  }
  UI.networksTable = networksTable;

  function sources(g) {
    var w = CH.walletBalances(), v = CH.vaultBalances(), t = usable(g) ? CH.total(g, 'USDC') : null;
    function cell(title, sub, val, cls) { return '<div class="ch-src ' + cls + '"><div class="ch-src-t">' + title + '</div><div class="ch-src-v">' + val + '</div><div class="ch-src-s">' + sub + '</div></div>'; }
    return '<div class="ch-sources">' +
      cell('Gateway (unified)', 'Counted in the Unified Balance', t != null ? '$' + esc(CH.fmtMin2(t, 6)) + ' <small>USDC</small>' : '<span class="ch-dim">—</span>', 'a') +
      cell('EVM wallet', 'Active network only · not included above', w && w.USDC != null ? esc(w.USDC.toFixed(2)) + ' <small>USDC</small>' : '<span class="ch-dim">—</span>', 'b') +
      cell('Treasury Vault', 'Protocol capital · kept separate, never mixed', v && v.usdc != null ? esc(String(v.usdc)) + ' <small>USDC</small>' : '<span class="ch-dim">—</span>', 'c') + '</div>';
  }

  function overview(g) {
    return stateBanner(g) + cards(g) + actions() + sources(g) +
      '<div class="ch-grid2">' + distribution(g) + flowPanel() + '</div>' +
      recentOps() + networkBalances(g);
  }

  // ── shell ───────────────────────────────────────────────────────────────────
  var TABS = [['overview', 'layout-dashboard', 'Overview'], ['manage', 'wallet', 'Manage Funds'], ['networks', 'topology-star-3', 'Networks'], ['transactions', 'arrows-exchange', 'Transactions'], ['analytics', 'chart-bar', 'Analytics'], ['security', 'shield-check', 'Security']];
  function header() {
    var e = CH.env();
    return '<div class="ch-head"><div class="ch-head-ic"><i class="ti ti-world"></i></div><div class="ch-head-t"><h2>Capital Hub</h2><p>Unified Capital &amp; Cross-Chain Liquidity Management</p></div>' +
      '<div class="ch-head-r"><span class="ch-by">Powered by <i class="ti ti-circle-dot"></i> <b>Circle Gateway</b></span>' + pill(e.label, e.label === 'Mainnet' ? 'green' : e.label === 'Testnet' ? 'amber' : 'muted') +
      '<button class="ch-btn" data-ch-refresh aria-label="Refresh"><i class="ti ti-refresh"></i>Refresh</button></div></div>' +
      '<div class="ch-tabs" role="tablist">' + TABS.map(function (t) { return '<button role="tab" class="' + (S.tab === t[0] ? 'on' : '') + '" data-ch-tab="' + t[0] + '"><i class="ti ti-' + t[1] + '"></i>' + t[2] + '</button>'; }).join('') + '</div>';
  }

  var _raf = 0;
  function render() {
    var r = root(); if (!r) return;
    if (!visible()) return;
    var g = CH.gateway();
    var body = S.tab === 'overview' ? overview(g) : (UI.tabs[S.tab] ? UI.tabs[S.tab](g) : '');
    var sc = r.scrollTop;
    var ae = document.activeElement, aid = ae && ae.id, keep = (aid === 'ch-q' || (aid && aid.indexOf('ch-qf-') === 0 && ae.tagName === 'INPUT')) ? { id: aid, s: ae.selectionStart } : null;
    r.innerHTML = header() + '<div class="ch-body">' + body + '</div>';
    if (keep) { var q = document.getElementById(keep.id); if (q) { q.focus(); try { q.setSelectionRange(keep.s, keep.s); } catch (_) {} } }
    r.scrollTop = sc;
  }
  function schedule() { if (_raf) return; _raf = requestAnimationFrame(function () { _raf = 0; render(); }); }
  UI.render = render; UI.schedule = schedule; UI.visible = visible;

  function refresh() {
    try { if (typeof ubGatewayFetch === 'function') ubGatewayFetch(); } catch (_) {}   // existing path: single in-flight, seq-guarded
    CH.reconcileTransfers();
    schedule();
  }
  UI.refresh = refresh;

  function launch(kind, asset) {
    var w = CH.wallet(); if (!w) { try { toast('Connect your wallet first', 'warning'); } catch (_) {} return; }
    asset = asset || 'USDC';
    if (kind === 'deposit') {
      if (typeof ubGwDepOpen === 'function') ubGwDepOpen(asset); else try { toast('Gateway deposit is not available in this build', 'error'); } catch (_) {}
      return;
    }
    if (typeof showPage !== 'function' || typeof saSetOrigin !== 'function') { try { toast('Gateway transfers are not available in this build', 'error'); } catch (_) {} return; }
    showPage('send');
    setTimeout(function () {
      try {
        var b = document.querySelector('.sa-asset-btn[data-asset="' + asset + '"]'); if (b && typeof saSelectAsset === 'function') saSelectAsset(asset, b);
        saSetOrigin('gateway');
        if (kind === 'withdraw') { var r = document.getElementById('sa-recipient'); if (r) { r.value = w; r.dispatchEvent(new Event('input', { bubbles: true })); } }
      } catch (_) {}
    }, 120);
  }
  UI.launch = launch;

  function copy(text, btn) {
    try { navigator.clipboard.writeText(text).then(function () { var i = btn.querySelector('i'); if (i) { i.className = 'ti ti-check'; setTimeout(function () { i.className = 'ti ti-copy'; }, 1200); } }); } catch (_) {}
  }

  // one delegated listener on the stable section node (bound once)
  function bind() {
    var sec = document.getElementById('trs-capital-hub');
    if (!sec || sec.__chBound) return;
    sec.__chBound = true;
    sec.addEventListener('click', function (ev) {
      var t = ev.target.closest('[data-ch-tab],[data-ch-asset],[data-ch-flow],[data-ch-act],[data-ch-refresh],[data-ch-copy],[data-ch-launch],[data-ch-qa],[data-ch-max],[data-ch-qa-open],[data-ch-page],[data-ch-open],[data-ch-export],[data-ch-clear]');
      if (!t || t.disabled) return;
      if (t.hasAttribute('data-ch-tab')) { S.tab = t.getAttribute('data-ch-tab'); render(); }
      else if (t.hasAttribute('data-ch-asset')) { S.asset = t.getAttribute('data-ch-asset'); render(); }
      else if (t.hasAttribute('data-ch-flow')) { S.flow = Number(t.getAttribute('data-ch-flow')); render(); }
      else if (t.hasAttribute('data-ch-qa') && UI.qaSelect) UI.qaSelect(t.getAttribute('data-ch-qa'));
      else if (t.hasAttribute('data-ch-max') && UI.qaMax) UI.qaMax(t.getAttribute('data-ch-max'));
      else if (t.hasAttribute('data-ch-qa-open') && UI.qaOpen) UI.qaOpen(t.getAttribute('data-ch-qa-open'));
      else if (t.hasAttribute('data-ch-act')) launch(t.getAttribute('data-ch-act'), S.asset);
      else if (t.hasAttribute('data-ch-launch')) { var p = t.getAttribute('data-ch-launch').split(':'); var sel = document.getElementById('ch-mf-' + p[0]); launch(p[0], sel ? sel.value : S.asset); }
      else if (t.hasAttribute('data-ch-refresh')) refresh();
      else if (t.hasAttribute('data-ch-copy')) copy(t.getAttribute('data-ch-copy'), t);
      else if (t.hasAttribute('data-ch-page') && UI.txPage) UI.txPage(Number(t.getAttribute('data-ch-page')));
      else if (t.hasAttribute('data-ch-open') && UI.txOpen) UI.txOpen(t.getAttribute('data-ch-open'));
      else if (t.hasAttribute('data-ch-export') && UI.exportCsv) UI.exportCsv();
      else if (t.hasAttribute('data-ch-clear') && UI.txClear) UI.txClear();
    });
    sec.addEventListener('input', function (ev) { var id = ev.target.id || ''; if (id === 'ch-q' && UI.txFilter) UI.txFilter('q', ev.target.value); else if (id.indexOf('ch-qf-') === 0 && UI.qaInput) UI.qaInput(id, ev.target.value); });
    sec.addEventListener('change', function (ev) { var id = ev.target.id || ''; if (id.indexOf('ch-f-') === 0 && UI.txFilter) UI.txFilter(id.slice(5), ev.target.value); else if (id.indexOf('ch-qf-') === 0 && UI.qaChange) UI.qaChange(id, ev.target.value); });
    sec.addEventListener('mouseover', function (ev) {
      var g = ev.target.closest && ev.target.closest('.ch-bg'); var tip = document.getElementById('ch-tip'); if (!tip) return;
      if (!g) { tip.style.display = 'none'; return; }
      var c = document.getElementById('ch-chart').getBoundingClientRect(), b = g.getBoundingClientRect();
      tip.textContent = g.getAttribute('data-tip'); tip.style.display = 'block';
      tip.style.left = Math.min(Math.max(b.left - c.left + b.width / 2, 70), c.width - 70) + 'px';
    });
  }

  function onShow() {
    S.shown = true;
    bind();
    CH.installHooks();
    var g = CH.gateway();
    if ((g.state === 'idle') && typeof ubGatewayFetch === 'function') { try { ubGatewayFetch(); } catch (_) {} }   // first load only; later reads use the shared cache
    CH.reconcileDeposits();
    CH.reconcileTransfers();
    render();
  }
  UI.onShow = onShow;

  // Re-render when the SHARED cache changes (observers only — no timers, no polling).
  function watch() {
    if (window.__chWatch) return; window.__chWatch = true;
    try {
      if (typeof ubGatewayRender === 'function') { var o = ubGatewayRender; ubGatewayRender = function () { var r = o.apply(this, arguments); try { CH.reconcileDeposits(); schedule(); } catch (_) {} return r; }; }
      var er = document.getElementById('ub-gw-error');
      if (er && typeof MutationObserver !== 'undefined') new MutationObserver(function () { schedule(); }).observe(er, { childList: true, characterData: true, subtree: true, attributes: true });
    } catch (_) {}
    document.addEventListener('WALLET_CONNECTED', function () { schedule(); });
    try { if (typeof EventBus !== 'undefined' && EventBus.on) EventBus.on('CHAIN_CHANGED', function () { schedule(); }); } catch (_) {}
    CH.on(schedule);
  }

  function init() { CH.installHooks(); watch(); }
  if (document.readyState === 'complete') init(); else window.addEventListener('load', init);

  window.CapitalHubUI = UI;
})();
