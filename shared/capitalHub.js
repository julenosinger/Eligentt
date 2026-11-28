/**
 * Capital Hub — data layer (Treasury › Capital Hub)
 * ─────────────────────────────────────────────────────────────────────────────
 * A management VIEW over the existing Circle Gateway infrastructure. It owns no
 * balances, signs nothing, sends nothing and has no execution engine.
 *
 *  Reads (never its own balance fetch):
 *    - Gateway balances  → the shared Unified Balance cache (_ubGwCache), refreshed
 *                          through the existing ubGatewayFetch() (single in-flight, seq-guarded)
 *    - EVM wallet        → UB.state.assets (active network only)
 *    - Treasury Vault    → VaultStore.get().chainBalances (kept separate, never added)
 *  Operation journal:
 *    - A bounded, per-wallet, per-environment activity journal of Gateway operations that were
 *      started from THIS browser (deposit confirmation hook + Gateway transfer result). It records
 *      what the existing flows already reported — it is not a ledger and holds no balances.
 *  Status truth:
 *    - Deposit: "Confirmed" only when a later Gateway balance read shows the credit (balance >=
 *      balance-before + amount). A confirmed SOURCE transaction is "Processing".
 *    - Transfer: "Confirmed" only when the existing /api/gateway/transfer record reports it.
 *  Exposes window.CapitalHub. No timers, no polling.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.CapitalHub) return;

  var ASSETS = ['USDC', 'EURC', 'cirBTC'];
  var DEC = { USDC: 6, EURC: 6, cirBTC: 8 };
  // Circle Gateway domain → EVM chain id (only domains whose chain id is already known to the app).
  var DOMAIN_CHAIN = { 0: 1, 1: 43114, 2: 10, 3: 42161, 6: 8453, 7: 137, 14: 480, 26: 5042 };
  var LOG_KEY = 'elligentt_capital_hub_ops_v1';
  var LOG_MAX = 300;
  var FRESH_MS = 90000;           // same freshness window as ubGetGatewayBalance()
  var REVIEW_AFTER_MS = 60 * 60 * 1000;
  var STATUS = ['Pending', 'Processing', 'Confirmed', 'Failed', 'Requires Review'];

  var _listeners = [];
  var _seq = 0;

  // ── exact decimal helpers (no float) ──────────────────────────────────────
  function toAtomic(str, dec) {
    var s = str == null ? '' : String(str).trim();
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
    var p = s.split('.');
    var frac = p[1] || '';
    if (frac.length > dec) { if (/[1-9]/.test(frac.slice(dec))) return null; frac = frac.slice(0, dec); }
    return BigInt(p[0] + frac.padEnd(dec, '0'));
  }
  function fmt(atomic, dec, maxFrac) {
    if (atomic == null) return '—';
    var neg = atomic < 0n; var a = neg ? -atomic : atomic;
    var s = a.toString().padStart(dec + 1, '0');
    var whole = s.slice(0, s.length - dec), frac = s.slice(s.length - dec);
    var keep = maxFrac == null ? dec : Math.min(maxFrac, dec);
    frac = frac.slice(0, keep).replace(/0+$/, '');
    whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + whole + (frac ? '.' + frac : '');
  }
  // USD-style display: truncated (never rounded up) to exactly 2 decimals.
  function fmtMin2(atomic, dec) {
    var v = fmt(atomic, dec, 2);
    if (v === '—') return v;
    var i = v.indexOf('.');
    if (i === -1) return v + '.00';
    return v.length - i - 1 < 2 ? v + '0' : v;
  }

  // ── environment / wallet ──────────────────────────────────────────────────
  function wallet() {
    var a = (typeof walletAddress !== 'undefined' ? walletAddress : '') || '';
    if (a.indexOf(':') !== -1) a = a.split(':').pop();
    return /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : null;
  }
  function env() {
    try {
      var c = (typeof getActiveChain === 'function') ? getActiveChain() : null;
      if (c) return { label: c.testnet ? 'Testnet' : 'Mainnet', chainId: c.chainId, name: c.name };
    } catch (_) {}
    return { label: 'Unknown', chainId: null, name: '' };
  }
  function registry(chainId) {
    try { return (typeof CHAIN_REGISTRY !== 'undefined' && CHAIN_REGISTRY[chainId]) || null; } catch (_) { return null; }
  }
  function chainOfDomain(domain) { return DOMAIN_CHAIN[domain] != null ? DOMAIN_CHAIN[domain] : null; }
  function domainOfChain(chainId) {
    for (var d in DOMAIN_CHAIN) { if (DOMAIN_CHAIN[d] === Number(chainId)) return Number(d); }
    return null;
  }
  function explorerTx(chainId, hash) {
    var c = registry(chainId);
    return (c && c.explorer && /^0x[0-9a-fA-F]{64}$/.test(hash || '')) ? c.explorer.replace(/\/$/, '') + '/tx/' + hash : null;
  }

  // ── Gateway balances (shared cache, read-only) ────────────────────────────
  function cache() { try { return (typeof _ubGwCache !== 'undefined') ? _ubGwCache : null; } catch (_) { return null; } }
  function gateway() {
    var w = wallet();
    var out = { state: 'nowallet', ts: 0, assets: {}, domains: [], errAssets: [] };
    if (!w) return out;
    var c = cache();
    if (!c) { out.state = 'unavailable'; return out; }
    if (c.addr && c.addr.toLowerCase() !== w) { out.state = 'idle'; return out; }   // cache belongs to another wallet
    out.ts = c.ts || 0;
    if (c.status === 'loading') out.state = c.data ? 'loading' : 'loading';
    else if (c.status === 'error') out.state = 'error';
    else if (c.status === 'idle' || (c.status === 'empty' && !c.data)) out.state = 'idle';
    else out.state = (c.ts && (Date.now() - c.ts) > FRESH_MS) ? 'stale' : 'ok';
    if (!c.data || out.state === 'nowallet') return out;
    var seen = {};
    ASSETS.forEach(function (sym) {
      var rows = c.data[sym];
      var err = c.data.errors && c.data.errors[sym];
      var entry = { error: err || (rows ? null : 'unavailable'), rows: [] };
      if (Array.isArray(rows)) {
        rows.forEach(function (r) {
          var at = toAtomic(r.balance == null ? '0' : r.balance, DEC[sym]);
          entry.rows.push({ domain: Number(r.domain), name: String(r.domainName || r.domain), atomic: at });
          seen[r.domain] = String(r.domainName || r.domain);
        });
      }
      out.assets[sym] = entry;
    });
    out.errAssets = ASSETS.filter(function (a) { return out.assets[a] && out.assets[a].error; });
    out.domains = Object.keys(seen).map(Number).sort(function (a, b) { return (a === 26 ? -1 : b === 26 ? 1 : a - b); });
    out.domainNames = seen;
    return out;
  }
  function total(g, sym) {
    var e = g.assets[sym];
    if (!e || e.error || !e.rows.length) return null;
    var t = 0n;
    for (var i = 0; i < e.rows.length; i++) { if (e.rows[i].atomic == null) return null; t += e.rows[i].atomic; }
    return t;
  }
  function balanceAt(g, sym, domain) {
    var e = g.assets[sym];
    if (!e || e.error) return null;
    for (var i = 0; i < e.rows.length; i++) { if (e.rows[i].domain === domain) return e.rows[i].atomic; }
    return null;
  }
  // Per-network view. An asset is "supported" on a network only if the Gateway API returned a row for it there.
  function networks(g) {
    var list = [];
    g.domains.forEach(function (d) {
      var chainId = chainOfDomain(d);
      var n = { domain: d, name: g.domainNames[d], chainId: chainId, reg: chainId ? registry(chainId) : null, assets: {} };
      ASSETS.forEach(function (sym) {
        var e = g.assets[sym];
        if (!e) return;
        if (e.error) return;     // per-network support is unknown while the asset could not be read
        var row = null; e.rows.forEach(function (r) { if (r.domain === d) row = r; });
        if (row) n.assets[sym] = { supported: true, atomic: row.atomic };
      });
      list.push(n);
    });
    return list;
  }

  // ── Other capital sources (kept separate; never added to the unified balance) ──
  function walletBalances() {
    var out = {};
    try {
      var as = (typeof UB !== 'undefined' && UB.state && UB.state.assets) ? UB.state.assets : null;
      if (!as) return null;
      as.forEach(function (a) { if (a && a.token) out[a.token] = (out[a.token] || 0) + (Number(a.balance) || 0); });
      return out;
    } catch (_) { return null; }
  }
  function vaultBalances() {
    try {
      var s = (typeof VaultStore !== 'undefined') ? VaultStore.get() : null;
      if (!s || !s.chainBalances || !s.lastChainFetch) return null;
      return { usdc: s.chainBalances.usdc, eurc: s.chainBalances.eurc, cirbtc: s.chainBalances.cirbtc, ts: s.lastChainFetch };
    } catch (_) { return null; }
  }

  // ── Operation journal ─────────────────────────────────────────────────────
  function readAll() {
    try { var a = JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (_) { return []; }
  }
  function writeAll(a) { try { localStorage.setItem(LOG_KEY, JSON.stringify(a.slice(0, LOG_MAX))); } catch (_) {} }
  function ops() {
    var w = wallet(), e = env().label;
    if (!w) return [];
    return readAll().filter(function (o) { return o.wallet === w && o.env === e; });
  }
  function emit() { _listeners.slice().forEach(function (f) { try { f(); } catch (_) {} }); }
  function on(fn) { if (typeof fn === 'function' && _listeners.indexOf(fn) === -1) _listeners.push(fn); }

  // Idempotent by id: the same operation is updated, never duplicated.
  function record(op) {
    var w = wallet();
    if (!w || !op || !op.id) return null;
    var all = readAll();
    var idx = -1;
    for (var i = 0; i < all.length; i++) { if (all[i].id === op.id && all[i].wallet === w) { idx = i; break; } }
    var base = idx >= 0 ? all[idx] : { id: String(op.id), wallet: w, env: env().label, ts: Date.now() };
    var next = Object.assign({}, base, op, { wallet: w, env: base.env });
    if (STATUS.indexOf(next.status) === -1) next.status = 'Processing';
    if (idx >= 0) all[idx] = next; else all.unshift(next);
    writeAll(all);
    emit();
    return next;
  }

  // Called from the existing deposit flow right after its source transaction is confirmed.
  function noteDeposit(info) {
    try {
      var sym = info.token, dec = DEC[sym];
      var domain = domainOfChain(info.chainId);
      var g = gateway();
      var pre = (g.state === 'ok' && domain != null) ? balanceAt(g, sym, domain) : null;
      record({
        id: 'dep:' + info.txHash, type: 'Deposit', status: 'Processing', asset: sym, amount: String(info.amount),
        srcChainId: Number(info.chainId), srcName: info.chainName || '', dstName: 'Circle Gateway', domain: domain,
        txHash: info.txHash, preBalance: pre == null ? null : pre.toString(), ts: Date.now()
      });
    } catch (_) {}
  }

  // Compare a Processing deposit with the latest fresh Gateway read; promote only on real evidence.
  function reconcileDeposits() {
    var g = gateway();
    var all = readAll(), changed = false, w = wallet();
    all.forEach(function (o) {
      if (o.wallet !== w || o.type !== 'Deposit' || o.status === 'Confirmed' || o.status === 'Failed') return;
      var dec = DEC[o.asset];
      if (g.state === 'ok' && o.preBalance != null && o.domain != null) {
        var now = balanceAt(g, o.asset, o.domain), amt = toAtomic(o.amount, dec);
        if (now != null && amt != null && now >= BigInt(o.preBalance) + amt) { o.status = 'Confirmed'; o.confirmedAt = Date.now(); changed = true; return; }
      }
      if (o.status === 'Processing' && (Date.now() - o.ts) > REVIEW_AFTER_MS) { o.status = 'Requires Review'; changed = true; }
    });
    if (changed) { writeAll(all); emit(); }
  }

  // Ask the EXISTING server record (same endpoint the transfer flow uses) about open transfers.
  var _recBusy = false;
  function reconcileTransfers() {
    var w = wallet();
    if (!w || _recBusy || typeof fetch !== 'function') return Promise.resolve();
    var open = ops().filter(function (o) { return (o.type === 'Transfer' || o.type === 'Withdraw') && o.salt && (o.status === 'Processing' || o.status === 'Requires Review'); }).slice(0, 10);
    if (!open.length) return Promise.resolve();
    _recBusy = true;
    var token = ++_seq;
    return Promise.all(open.map(function (o) {
      var ctrl = new AbortController(); var t = setTimeout(function () { ctrl.abort(); }, 10000);
      return fetch('/api/gateway/transfer?salt=' + encodeURIComponent(o.salt) + '&depositor=' + encodeURIComponent(w), { signal: ctrl.signal })
        .then(function (r) { clearTimeout(t); return r.ok ? r.json() : null; })
        .then(function (rec) { return { o: o, rec: rec }; })
        .catch(function () { clearTimeout(t); return { o: o, rec: null }; });
    })).then(function (res) {
      _recBusy = false;
      if (token !== _seq || wallet() !== w) return;                 // wallet changed / newer pass: discard stale answers
      res.forEach(function (x) {
        if (!x.rec) return;
        var s = x.rec.status, patch = null;
        if (s === 'confirmed') patch = { status: 'Confirmed', confirmedAt: Date.now(), txHash: x.rec.mintTxHash || x.rec.txHash || x.o.txHash || null, dstTx: x.rec.mintTxHash || null };
        else if (s === 'failed' || s === 'rejected') patch = { status: 'Failed' };
        else if (s === 'ambiguous') patch = { status: 'Requires Review' };
        else if (s === 'accepted' || s === 'submitting') patch = { status: 'Processing' };
        if (patch) record(Object.assign({ id: x.o.id }, patch));
      });
    }).catch(function () { _recBusy = false; });
  }

  // ── observe the existing Gateway transfer flow (no change to its behaviour) ──
  function installHooks() {
    if (window.__capitalHubHooks) return;
    window.__capitalHubHooks = true;
    try {
      if (typeof saExecGateway === 'function') {
        var orig = saExecGateway;
        saExecGateway = function () {
          var o = arguments[0] || {};
          var recip = (o.recipient !== undefined) ? o.recipient : ((document.getElementById('sa-recipient') || {}).value || '');
          var amt = (o.amount !== undefined) ? String(o.amount) : ((document.getElementById('sa-amount') || {}).value || '');
          var asset = o.asset || (typeof saCurrentAsset !== 'undefined' ? saCurrentAsset : 'USDC');
          var chainId = (o.chainId != null) ? o.chainId : (typeof activeChainId !== 'undefined' ? activeChainId : null);
          var w = wallet();
          var r = orig.apply(this, arguments);
          Promise.resolve(r).then(function (res) {
            try {
              if (!res || !w || (res.status !== 'pending' && res.status !== 'ambiguous')) return;
              var id = 'gw:' + (res.salt || res.transferId || ('t' + Date.now()));
              var self = String(recip).toLowerCase() === w;
              record({
                id: id, type: self ? 'Withdraw' : 'Transfer', asset: asset, amount: String(amt).trim(),
                srcChainId: chainId, srcName: 'Circle Gateway', dstName: self ? 'Own wallet' : recip, recipient: recip,
                salt: res.salt || null, transferId: res.transferId || null, txHash: null,
                status: res.status === 'ambiguous' ? 'Requires Review' : 'Processing', ts: Date.now()
              });
            } catch (_) {}
          }, function () {});
          return r;
        };
      }
    } catch (_) {}
  }

  window.CapitalHub = {
    ASSETS: ASSETS, DEC: DEC, STATUS: STATUS,
    toAtomic: toAtomic, fmt: fmt, fmtMin2: fmtMin2,
    wallet: wallet, env: env, registry: registry, chainOfDomain: chainOfDomain, domainOfChain: domainOfChain, explorerTx: explorerTx,
    gateway: gateway, total: total, balanceAt: balanceAt, networks: networks,
    walletBalances: walletBalances, vaultBalances: vaultBalances,
    ops: ops, record: record, noteDeposit: noteDeposit, on: on, emit: emit,
    reconcileDeposits: reconcileDeposits, reconcileTransfers: reconcileTransfers, installHooks: installHooks
  };
})();
