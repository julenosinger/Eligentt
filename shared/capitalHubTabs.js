/**
 * Capital Hub — Manage Funds, Networks, Transactions, Analytics and Security tabs.
 * Presentation over window.CapitalHub / window.CapitalHubUI. No execution logic lives here:
 * Deposit / Transfer / Withdraw open the EXISTING Gateway flows, which keep their own review,
 * fee display, approval, signature and confirmation steps.
 */
(function () {
  'use strict';
  var CH = window.CapitalHub, UI = window.CapitalHubUI;
  if (!CH || !UI || UI.__tabs) return;
  UI.__tabs = true;
  var S = UI.S, esc = UI.esc, short = UI.short, pill = UI.pill;
  var PAGE = 10;

  // Manage Funds lives in capitalHubManage.js (Quick Actions + operation panel).

  // ── Networks ────────────────────────────────────────────────────────────────
  UI.tabs.networks = function (g) {
    var env = CH.env();
    if (!UI.usable(g)) return UI.stateBanner(g) + '<div class="ch-panel"><div class="ch-empty"><i class="ti ti-plug-off"></i><span>' + (g.state === 'loading' ? 'Loading networks…' : 'Network details need Gateway data.') + '</span></div></div>';
    var pend = UI.pendingOps();
    var upd = g.ts ? new Date(g.ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
    var cards = CH.networks(g).map(function (n) {
      var assets = CH.ASSETS.filter(function (s) { return n.assets[s]; });
      var bal = assets.map(function (s) { var a = n.assets[s]; return '<div class="ch-kv"><span>' + s + '</span><b>' + (a.error ? '<span class="ch-err">Unavailable</span>' : a.atomic == null ? '<span class="ch-err">Unreadable</span>' : esc(CH.fmt(a.atomic, CH.DEC[s], CH.DEC[s]))) + '</b></div>'; }).join('');
      var np = pend.filter(function (o) { return o.type === 'Deposit' && o.domain === n.domain; }).length;
      var err = !!(g.errAssets && g.errAssets.length);
      return '<div class="ch-panel ch-netcard"><div class="ch-netcard-h">' + UI.logo(n) + '<div><div class="ch-panel-t">' + esc(n.name) + '</div><div class="ch-panel-s">Chain ID ' + (n.chainId != null ? n.chainId : '—') + ' · Domain ' + n.domain + '</div></div>' + pill(env.label, env.label === 'Mainnet' ? 'green' : 'amber') + '</div>' +
        '<div class="ch-chips">' + assets.map(function (s) { return pill(s, 'muted'); }).join(' ') + '</div>' + bal +
        '<div class="ch-kv"><span>Pending deposits</span><b>' + np + '</b></div><div class="ch-kv"><span>Status</span>' + (err ? pill('Partial', 'amber') : pill('Operational', 'green')) + '</div><div class="ch-card-f">Last Gateway read ' + esc(upd) + '</div></div>';
    }).join('');
    return UI.stateBanner(g) + '<div class="ch-netgrid">' + cards + '</div><div class="ch-note">Networks and assets are exactly those returned by Circle Gateway for your address. Environment: ' + esc(env.label) + (env.label === 'Mainnet' ? ' (Testnet networks are not part of this app).' : '.') + '</div>';
  };

  // ── Transactions ────────────────────────────────────────────────────────────
  function filtered() {
    var f = S.tx, q = f.q.trim().toLowerCase(), now = Date.now();
    var days = f.period ? Number(f.period) : 0;
    return CH.ops().filter(function (o) {
      if (q && !((o.txHash || '').toLowerCase().indexOf(q) !== -1 || (o.salt || '').toLowerCase().indexOf(q) !== -1 || (o.recipient || '').toLowerCase().indexOf(q) !== -1 || (o.wallet || '').indexOf(q) !== -1)) return false;
      if (f.net && String(o.srcName) !== f.net && String(o.dstName) !== f.net) return false;
      if (f.asset && o.asset !== f.asset) return false;
      if (f.op && o.type !== f.op) return false;
      if (f.status && o.status !== f.status) return false;
      if (days && (now - o.ts) > days * 86400000) return false;
      return true;
    }).sort(function (a, b) { return b.ts - a.ts; });
  }
  function opt(list, sel, all) { return '<option value="">' + all + '</option>' + list.map(function (v) { return '<option value="' + esc(v[0]) + '"' + (v[0] === sel ? ' selected' : '') + '>' + esc(v[1]) + '</option>'; }).join(''); }
  function txBody() {
    var f = S.tx, all = filtered(), pages = Math.max(1, Math.ceil(all.length / PAGE));
    if (f.page > pages) f.page = pages;
    var rows = all.slice((f.page - 1) * PAGE, f.page * PAGE);
    if (!all.length) return '<div class="ch-empty"><i class="ti ti-receipt-off"></i><span>' + (CH.ops().length ? 'No operations match these filters.' : 'No Gateway operations recorded for this wallet yet.<br><small>Deposits and transfers started from this browser appear here.</small>') + '</span></div>';
    var body = rows.map(function (o) {
      var det = f.open === o.id ? '<tr class="ch-det"><td colspan="9">' + detail(o) + '</td></tr>' : '';
      return UI.opRow(o).replace('</tr>', '<td><button class="ch-icon" data-ch-open="' + esc(o.id) + '" aria-label="Details" aria-expanded="' + (f.open === o.id) + '"><i class="ti ti-chevron-' + (f.open === o.id ? 'up' : 'down') + '"></i></button></td></tr>') + det;
    }).join('');
    return '<div class="ch-scroll"><table class="ch-table">' + UI.OPS_HEAD.replace('</tr>', '<th></th></tr>') + '<tbody>' + body + '</tbody></table></div>' +
      '<div class="ch-pager"><span>' + all.length + ' operation' + (all.length === 1 ? '' : 's') + '</span><span><button class="ch-icon" data-ch-page="' + (f.page - 1) + '"' + (f.page <= 1 ? ' disabled' : '') + ' aria-label="Previous page"><i class="ti ti-chevron-left"></i></button> Page ' + f.page + ' / ' + pages + ' <button class="ch-icon" data-ch-page="' + (f.page + 1) + '"' + (f.page >= pages ? ' disabled' : '') + ' aria-label="Next page"><i class="ti ti-chevron-right"></i></button></span></div>';
  }
  function detail(o) {
    var row = function (k, v) { return '<div class="ch-kv"><span>' + k + '</span><span>' + v + '</span></div>'; };
    return '<div class="ch-detail">' + row('Operation id', esc(short(o.id))) + row('Wallet', esc(o.wallet)) + row('Recipient', o.recipient ? esc(o.recipient) : '—') +
      row('Source network', esc(o.srcName || '—')) + row('Destination', esc(o.dstName || '—')) + row('Salt', o.salt ? esc(short(o.salt)) : '—') + row('Transfer id', o.transferId ? esc(short(o.transferId)) : '—') +
      row('Started', esc(new Date(o.ts).toLocaleString())) + row('Confirmed', o.confirmedAt ? esc(new Date(o.confirmedAt).toLocaleString()) : '—') +
      '<div class="ch-card-f">' + (o.type === 'Deposit' ? 'A deposit is Confirmed only after a later Gateway read shows the credit; the source transaction alone is Processing.' : 'A transfer is Confirmed only when the Gateway transfer record reports it.') + '</div></div>';
  }
  UI.tabs.transactions = function () {
    var f = S.tx, all = CH.ops();
    var nets = {}; all.forEach(function (o) { if (o.srcName) nets[o.srcName] = 1; if (o.dstName && o.type === 'Deposit') nets[o.dstName] = 1; });
    return '<div class="ch-panel"><div class="ch-panel-h"><div><div class="ch-panel-t">Transactions</div><div class="ch-panel-s">Gateway operations started from this browser for the connected wallet</div></div><button class="ch-btn" data-ch-export><i class="ti ti-file-export"></i>Export CSV</button></div>' +
      '<div class="ch-filters"><input id="ch-q" class="ch-in" type="search" placeholder="Search hash, salt or address" value="' + esc(f.q) + '" aria-label="Search">' +
      '<select id="ch-f-net" class="ch-sel" aria-label="Network">' + opt(Object.keys(nets).map(function (k) { return [k, k]; }), f.net, 'All networks') + '</select>' +
      '<select id="ch-f-asset" class="ch-sel" aria-label="Asset">' + opt(CH.ASSETS.map(function (a) { return [a, a]; }), f.asset, 'All assets') + '</select>' +
      '<select id="ch-f-op" class="ch-sel" aria-label="Operation">' + opt([['Deposit', 'Deposit'], ['Transfer', 'Transfer'], ['Withdraw', 'Withdraw']], f.op, 'All operations') + '</select>' +
      '<select id="ch-f-status" class="ch-sel" aria-label="Status">' + opt(CH.STATUS.map(function (s) { return [s, s]; }), f.status, 'All statuses') + '</select>' +
      '<select id="ch-f-period" class="ch-sel" aria-label="Period">' + opt([['1', '24 hours'], ['7', '7 days'], ['30', '30 days'], ['90', '90 days']], f.period, 'All time') + '</select>' +
      '<button class="ch-link" data-ch-clear>Clear</button></div><div id="ch-tx-body">' + txBody() + '</div></div>';
  };
  function repaintTx() { var el = document.getElementById('ch-tx-body'); if (el) el.innerHTML = txBody(); }
  UI.txFilter = function (k, v) { S.tx[k] = v; S.tx.page = 1; S.tx.open = null; repaintTx(); };
  UI.txPage = function (p) { S.tx.page = Math.max(1, p); repaintTx(); };
  UI.txOpen = function (id) { S.tx.open = S.tx.open === id ? null : id; repaintTx(); };
  UI.txClear = function () { S.tx = { q: '', net: '', asset: '', op: '', status: '', period: '', page: 1, open: null }; UI.render(); };
  UI.exportCsv = function () {
    var list = filtered();
    if (!list.length) { try { toast('Nothing to export for the current filters', 'warning'); } catch (_) {} return; }
    function cell(v) { var s = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; }
    var head = ['date_utc', 'operation', 'source', 'destination', 'asset', 'amount', 'status', 'tx_hash', 'salt', 'wallet', 'environment'];
    var lines = [head.join(',')].concat(list.map(function (o) { return [new Date(o.ts).toISOString(), o.type, o.srcName, o.dstName, o.asset, o.amount, o.status, o.txHash, o.salt, o.wallet, o.env].map(cell).join(','); }));
    var blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'capital-hub-operations-' + CH.wallet().slice(0, 8) + '.csv';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  };

  // ── Analytics ───────────────────────────────────────────────────────────────
  UI.tabs.analytics = function (g) {
    var all = CH.ops(), sym = S.asset, dec = CH.DEC[sym];
    var conf = all.filter(function (o) { return o.status === 'Confirmed'; });
    function sumBy(list, type) { var t = 0n; list.forEach(function (o) { if (o.asset === sym && (!type || o.type === type)) { var a = CH.toAtomic(o.amount, dec); if (a != null) t += a; } }); return t; }
    var count = function (t) { return all.filter(function (o) { return o.type === t; }).length; };
    var durs = conf.filter(function (o) { return o.confirmedAt && o.ts && o.confirmedAt >= o.ts; }).map(function (o) { return o.confirmedAt - o.ts; });
    var avg = durs.length ? Math.round(durs.reduce(function (a, b) { return a + b; }, 0) / durs.length / 60000) : null;
    var moved = sumBy(conf, null);
    var open = all.filter(function (o) { return o.status !== 'Confirmed' && o.status !== 'Failed'; }).length;
    function k(t, v, s) { return '<div class="ch-card"><div class="ch-card-h">' + t + '</div><div class="ch-big">' + v + '</div><div class="ch-card-f">' + s + '</div></div>'; }
    var dist = '';
    if (UI.usable(g) && !(g.assets[sym] && g.assets[sym].error)) {
      var rows = CH.networks(g).filter(function (n) { return n.assets[sym] && n.assets[sym].supported && n.assets[sym].atomic > 0n; });
      var tot = rows.reduce(function (a, n) { return a + n.assets[sym].atomic; }, 0n);
      dist = tot === 0n ? '<div class="ch-empty"><i class="ti ti-database-off"></i><span>No ' + sym + ' in Gateway.</span></div>' : rows.map(function (n, i) {
        var bp = Number((n.assets[sym].atomic * 10000n) / tot);
        return '<div class="ch-leg"><span class="ch-dot" style="background:' + UI.palette[i % UI.palette.length] + '"></span>' + UI.logo(n) + '<span class="ch-leg-n">' + esc(n.name) + '</span><span class="ch-num">' + esc(CH.fmt(n.assets[sym].atomic, dec, dec)) + '</span><span class="ch-share">' + (bp / 100).toFixed(1) + '%</span></div>';
      }).join('');
    } else dist = '<div class="ch-empty"><i class="ti ti-chart-pie-off"></i><span>Distribution needs Gateway data.</span></div>';
    return UI.stateBanner(g) + '<div class="ch-panel-h" style="margin-bottom:8px"><div class="ch-panel-s">Metrics from confirmed operations recorded by this browser, shown per asset.</div>' + UI.assetTabs() + '</div>' +
      '<div class="ch-cards">' +
      k('<i class="ti ti-arrows-exchange"></i>Capital moved', '<b>' + esc(CH.fmt(moved, dec, dec)) + '</b> <small>' + sym + '</small>', 'Confirmed deposits, transfers and withdrawals') +
      k('<i class="ti ti-download"></i>Deposits', String(count('Deposit')), esc(CH.fmt(sumBy(conf, 'Deposit'), dec, 6)) + ' ' + sym + ' confirmed') +
      k('<i class="ti ti-send"></i>Transfers · Withdrawals', count('Transfer') + ' · ' + count('Withdraw'), esc(CH.fmt(sumBy(conf, 'Transfer') + sumBy(conf, 'Withdraw'), dec, 6)) + ' ' + sym + ' confirmed') +
      k('<i class="ti ti-receipt-2"></i>Fees paid', '<span class="ch-dim">—</span>', 'Not recorded by the existing flows') + '</div>' +
      '<div class="ch-cards" style="margin-top:10px">' +
      k('<i class="ti ti-circle-check"></i>Completed', String(conf.length), 'Confirmed operations') + k('<i class="ti ti-clock-hour-4"></i>Pending', String(open), 'Not yet confirmed') +
      k('<i class="ti ti-hourglass"></i>Avg. completion', avg == null ? '<span class="ch-dim">—</span>' : avg + ' min', avg == null ? 'No measurable completion yet' : 'From start to confirmation (' + durs.length + ' op' + (durs.length === 1 ? '' : 's') + ')') +
      k('<i class="ti ti-database"></i>Operations recorded', String(all.length), 'This wallet · ' + esc(CH.env().label)) + '</div>' +
      '<div class="ch-panel" style="margin-top:12px"><div class="ch-panel-h"><div class="ch-panel-t">Distribution by network</div><div class="ch-panel-s">Current Gateway balance · ' + sym + '</div></div>' + dist + '</div>' +
      '<div class="ch-note">These are capital-movement metrics, not revenue or profit. Gateway capital is the user\u2019s own and is never part of protocol fee revenue.</div>';
  };

  // ── Security ────────────────────────────────────────────────────────────────
  UI.tabs.security = function (g) {
    var env = CH.env(), w = CH.wallet(), all = CH.ops();
    var review = all.filter(function (o) { return o.status === 'Requires Review' || o.status === 'Failed'; }).length;
    var processing = all.filter(function (o) { return o.status === 'Processing' || o.status === 'Requires Review' || o.status === 'Pending'; }).length;
    var signer_ = false; try { signer_ = typeof signer !== 'undefined' && !!signer; } catch (_) {}
    var svc = g.state === 'ok' ? ['ok', 'Gateway answered ' + Math.max(0, Math.round((Date.now() - g.ts) / 1000)) + ' s ago'] : g.state === 'stale' ? ['warn', 'Last Gateway read is older than 90 s'] : g.state === 'error' ? ['bad', 'Last Gateway request failed'] : g.state === 'loading' ? ['info', 'Waiting for Gateway'] : ['info', 'No Gateway read yet'];
    var items = [
      ['Wallet Connection', w ? 'ok' : 'warn', w ? 'Connected ' + w.slice(0, 6) + '…' + w.slice(-4) : 'No wallet connected'],
      ['Network Environment', env.label === 'Mainnet' ? 'ok' : env.label === 'Testnet' ? 'warn' : 'info', env.label + (env.name ? ' · ' + env.name : '') + '. Records and balances never mix environments.'],
      ['Authorization Status', signer_ ? 'ok' : 'warn', signer_ ? 'Wallet can sign. Each operation still needs your explicit signature; nothing runs automatically.' : 'Wallet is not ready to sign'],
      ['Replay Protection', 'info', 'Each transfer is signed with a unique salt and reserved by the Gateway transfer endpoint. This page cannot verify that from the browser, so it is shown as informational.'],
      ['Transaction Integrity', review ? 'warn' : 'ok', review ? review + ' operation(s) need attention in the journal' : 'No flagged operations among ' + all.length + ' recorded'],
      ['Pending Reconciliation', processing ? 'warn' : 'ok', processing ? processing + ' operation(s) awaiting confirmation' : 'Nothing awaiting confirmation'],
      ['Service Availability', svc[0], svc[1]]
    ];
    return '<div class="ch-panel"><div class="ch-panel-h"><div><div class="ch-panel-t">Security &amp; integrity</div><div class="ch-panel-s">Each indicator reflects evidence available in this session. Unknown is shown as unknown.</div></div></div>' +
      '<div class="ch-sec">' + items.map(function (it) {
        var ic = it[1] === 'ok' ? 'circle-check' : it[1] === 'bad' ? 'circle-x' : it[1] === 'warn' ? 'alert-triangle' : 'info-circle';
        return '<div class="ch-sec-i ch-s-' + it[1] + '"><i class="ti ti-' + ic + '"></i><div><div class="ch-sec-t">' + it[0] + '</div><div class="ch-sec-d">' + esc(it[2]) + '</div></div></div>';
      }).join('') + '</div></div>' +
      '<div class="ch-note">Capital Hub grants no extra privileges. Treasury Vault, Mint Console and operator permissions are unchanged, and Gateway capital is never mixed with Vault capital.</div>';
  };
})();
