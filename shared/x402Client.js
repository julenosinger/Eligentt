/**
 * x402 Payments — Autonoma client (frontend).
 * ═══════════════════════════════════════════════════════════════════════
 * Modular, isolated buyer-side integration for the x402 open payment
 * standard (HTTP 402 Payment Required, protocol v2).
 *
 * Responsibilities (display + flow only — authority is server-side):
 *   - Fetch integration status from /api/x402/status
 *   - Discover payment requirements for a service URL via /api/x402/discover
 *   - Validate + prepare an authorization intent via /api/x402/prepare
 *   - Explicit user confirmation before any (future) payment — no auto-pay
 *   - Persistent history + duplicate-submission protection
 *
 * SECURITY:
 *   - No secrets, keys, or private keys are stored or exposed here.
 *   - Payment requirements, prices, recipients, and status are NEVER trusted
 *     from this client or from the AI model — the backend re-validates them.
 *   - Phase 1: real settlement is disabled server-side; this UI reports that
 *     honestly and never shows a simulated payment as real.
 *
 * Attached to window.X402.
 */
(function () {
  'use strict';

  var CFG = (typeof window !== 'undefined' && window.X402Config) || {
    ENDPOINT: '/api/x402',
    STORAGE_HISTORY: 'elligentt_x402_history_v1',
    STORAGE_SUBMITTED: 'elligentt_x402_submitted_v1',
    NETWORK_LABELS: {},
    DECIMALS: 6,
    VERSION: 2,
  };

  var _overlay = null;
  var _status = null;
  var _lastDiscovery = null;
  var _busy = false;

  /* ── Storage helpers ──────────────────────────────────────────────── */
  function lsLoad(key, def) {
    try { var raw = localStorage.getItem(key); return raw === null ? def : JSON.parse(raw); }
    catch (_) { return def; }
  }
  function lsSave(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) { /* quota */ }
  }
  function getHistory() { return lsLoad(CFG.STORAGE_HISTORY, []); }
  function getSubmitted() { return lsLoad(CFG.STORAGE_SUBMITTED, {}); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function shortAddr(a) {
    a = String(a || '');
    return a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : a;
  }
  function fmtUsd(atomic) {
    var n = Number(atomic);
    if (!isFinite(n)) return '—';
    var usd = n / Math.pow(10, CFG.DECIMALS || 6);
    return '$' + usd.toLocaleString('en-US', { maximumFractionDigits: 6 });
  }
  function networkLabel(caip) {
    return (CFG.NETWORK_LABELS && CFG.NETWORK_LABELS[caip]) || caip || '—';
  }
  function nowIso() { return new Date().toISOString(); }
  function notify(msg, kind) {
    try { if (typeof toast === 'function') { toast(msg, kind || 'info'); return; } } catch (_) {}
    try { console.log('[X402] ' + msg); } catch (_) {}
  }

  function getToken() {
    try {
      if (typeof AuthManager !== 'undefined' && typeof AuthManager.getSessionToken === 'function') {
        var t = AuthManager.getSessionToken(); if (t) return t;
      }
      if (typeof Auth !== 'undefined' && typeof Auth.getSessionToken === 'function') {
        var t2 = Auth.getSessionToken(); if (t2) return t2;
      }
    } catch (_) {}
    try { return sessionStorage.getItem('elligente_st') || null; } catch (_) { return null; }
  }

  async function api(path, options) {
    var headers = Object.assign({ 'Content-Type': 'application/json' }, (options && options.headers) || {});
    var tok = getToken();
    if (tok) headers['Authorization'] = 'Bearer ' + tok;
    try {
      var resp = await fetch(CFG.ENDPOINT + path, Object.assign({ credentials: 'include', headers: headers }, options || {}));
      var data = await resp.json().catch(function () { return { ok: false, error: 'Non-JSON response' }; });
      return { ok: resp.ok, status: resp.status, data: data };
    } catch (e) {
      return { ok: false, status: 0, data: { error: e.message || 'Network error' } };
    }
  }

  /* ── Backend calls ─────────────────────────────────────────────────── */
  async function getStatus(force) {
    if (!force && _status) return _status;
    var res = await api('/status');
    _status = res.data || {};
    return _status;
  }

  async function discover(url) {
    return await api('/discover', { method: 'POST', body: JSON.stringify({ url: url }) });
  }

  async function prepare(resourceUrl, requirement) {
    return await api('/prepare', { method: 'POST', body: JSON.stringify({ resourceUrl: resourceUrl, requirement: requirement, resource: (requirement && requirement.resource) || null }) });
  }

  async function pay(intent) {
    return await api('/pay', { method: 'POST', body: JSON.stringify({ intentId: intent && intent.id }) });
  }

  /* ── History / dedup ───────────────────────────────────────────────── */
  function pushHistory(entry) {
    var h = getHistory();
    h.unshift(Object.assign({ at: nowIso() }, entry));
    h = h.slice(0, 100);
    lsSave(CFG.STORAGE_HISTORY, h);
    return h;
  }
  function isAlreadySubmitted(id) {
    var s = getSubmitted();
    return !!(s && s[id]);
  }
  function markSubmitted(id, status) {
    var s = getSubmitted();
    s[id] = { at: nowIso(), status: status };
    lsSave(CFG.STORAGE_SUBMITTED, s);
  }

  /* ── Rendering ─────────────────────────────────────────────────────── */

  function stateBadge(state) {
    var map = {
      available: { cls: 'x402-live', label: 'Available' },
      disabled: { cls: 'x402-muted', label: 'Disabled' },
      unavailable: { cls: 'x402-err', label: 'Unavailable' },
      pending_config: { cls: 'x402-warn', label: 'Configuration pending' },
    };
    var m = map[state] || map.disabled;
    return '<span class="x402-badge ' + m.cls + '">' + esc(m.label) + '</span>';
  }

  function checkRow(c) {
    var icon = c.passed ? 'ti ti-check' : 'ti ti-x';
    var color = c.passed ? 'var(--green)' : 'var(--red)';
    return '<div class="x402-check">' +
      '<i class="' + icon + '" style="color:' + color + '"></i>' +
      '<span class="x402-check-name">' + esc(c.name) + '</span>' +
      '<span class="x402-check-detail">' + esc(c.detail || '') + '</span>' +
      '</div>';
  }

  function renderStatusPanel() {
    var s = _status || {};
    var state = s.state || 'disabled';
    var wallet = s.wallet || {};
    var netRows = (s.networks || []).map(function (n) {
      var compat = n.eip3009Compatible ? '<span style="color:var(--green)">EIP-3009 ✓</span>' : '<span style="color:var(--yellow)">EIP-3009 unconfirmed</span>';
      return '<div class="x402-net"><span>' + esc(n.label) + '</span><span class="x402-net-caip">' + esc(n.caip) + '</span><span>' + compat + '</span></div>';
    }).join('');

    return '<div class="x402-card">' +
      '<div class="x402-card-head"><span class="x402-card-title"><i class="ti ti-credit-card-pay"></i> x402 Payments</span>' + stateBadge(state) + '</div>' +
      '<div class="x402-card-sub">' + esc(s.reason || '…') + '</div>' +
      '<div class="x402-kv">' +
        '<div><span>Protocol</span><b>v' + esc(s.version) + '</b></div>' +
        '<div><span>Facilitator</span><b>' + esc(s.facilitator || '—') + '</b></div>' +
        '<div><span>Wallet</span><b>' + (wallet.provisioned ? shortAddr(wallet.address) : 'Not provisioned') + '</b></div>' +
        '<div><span>Max / payment</span><b>' + esc('$' + (s.maxUsd || 0)) + '</b></div>' +
      '</div>' +
      '<div class="x402-netlist">' + netRows + '</div>' +
    '</div>';
  }

  function renderDiscoverForm() {
    return '<div class="x402-card">' +
      '<div class="x402-card-head"><span class="x402-card-title"><i class="ti ti-search"></i> Discover a paid service</span></div>' +
      '<div class="x402-card-sub">Enter an x402-enabled URL. The server will probe it for an HTTP 402 Payment Required response and read its payment requirements.</div>' +
      '<div class="x402-row">' +
        '<input class="x402-input" id="x402-url" placeholder="https://api.example.com/premium-data" spellcheck="false" autocomplete="off"/>' +
        '<button class="x402-btn" id="x402-discover-btn" onclick="X402._discover()"><i class="ti ti-arrow-right"></i></button>' +
      '</div>' +
    '</div>';
  }

  function renderDiscovery() {
    var d = _lastDiscovery;
    if (!d) return '';
    var res = d.data || {};
    var parts = [];

    if (res.parseError) {
      parts.push('<div class="x402-errbox"><i class="ti ti-alert-triangle"></i> ' + esc(res.parseError) + '</div>');
    } else if (res.x402 && res.requirements && res.requirements.length) {
      var svc = res.resource && res.resource.serviceName ? res.resource.serviceName : res.resourceUrl;
      var desc = res.resource && res.resource.description ? res.resource.description : '';
      parts.push('<div class="x402-card"><div class="x402-card-head"><span class="x402-card-title"><i class="ti ti-api"></i> ' + esc(svc || 'Service') + '</span></div>' +
        (desc ? '<div class="x402-card-sub">' + esc(desc) + '</div>' : '') +
        '<div class="x402-card-sub" style="font-family:monospace">' + esc(res.resourceUrl) + '</div></div>');

      res.requirements.forEach(function (r, i) {
        var checkRows = (r.checks || []).map(checkRow).join('');
        var valid = r.valid;
        parts.push('<div class="x402-card">' +
          '<div class="x402-card-head"><span class="x402-card-title">Requirement #' + (i + 1) + '</span>' +
          (valid ? '<span class="x402-badge x402-live">valid</span>' : '<span class="x402-badge x402-warn">blocked</span>') + '</div>' +
          '<div class="x402-kv">' +
            '<div><span>Amount</span><b>' + esc(fmtUsd(r.amount)) + ' USDC</b></div>' +
            '<div><span>Token</span><b>' + esc(r.asset || 'USDC') + '</b></div>' +
            '<div><span>Network</span><b>' + esc(networkLabel(r.network)) + '</b></div>' +
            '<div><span>Recipient</span><b title="' + esc(r.payTo) + '">' + esc(shortAddr(r.payTo)) + '</b></div>' +
            '<div><span>Scheme</span><b>' + esc(r.scheme) + '</b></div>' +
            '<div><span>Timeout</span><b>' + esc(r.maxTimeoutSeconds) + 's</b></div>' +
          '</div>' +
          '<div class="x402-checks">' + checkRows + '</div>' +
          '<button class="x402-btn x402-btn-primary" onclick="X402._prepare(' + i + ')"' + (valid ? '' : ' disabled title="Blocked"') + '><i class="ti ti-shield-check"></i> Validate &amp; authorize</button>' +
        '</div>');
      });
    } else if (res.x402) {
      parts.push('<div class="x402-errbox">Resource returned 402 but no parseable payment requirements were found.</div>');
    } else {
      parts.push('<div class="x402-okbox"><i class="ti ti-check"></i> Resource returned HTTP ' + esc(res.status) + ' — no payment required (or already authorized).</div>');
    }
    return parts.join('');
  }

  function renderPrepare() {
    var p = _lastPrepare;
    if (!p) return '';
    var res = p.data || {};
    var it = res.intent || {};
    var checkRows = (it.checks || []).map(checkRow).join('');

    var head;
    if (res.enabled && !it.blockedReason) {
      head = '<div class="x402-card-head"><span class="x402-card-title"><i class="ti ti-shield-check"></i> Authorize payment</span>' +
        '<span class="x402-badge x402-live">ready</span></div>' +
        '<div class="x402-card-sub">Review the payment and confirm. Funds move ONLY after you authorize — never automatically.</div>';
    } else {
      head = '<div class="x402-card-head"><span class="x402-card-title"><i class="ti ti-lock"></i> Payment blocked</span>' +
        '<span class="x402-badge x402-warn">blocked</span></div>' +
        '<div class="x402-errbox"><i class="ti ti-alert-triangle"></i> ' + esc(it.blockedReason || 'blocked') + '</div>';
    }

    return '<div class="x402-card">' +
      head +
      '<div class="x402-kv">' +
        '<div><span>Amount</span><b>' + esc(fmtUsd(it.amountUsd != null ? Math.round(it.amountUsd * 1e6) : null)) + ' USDC</b></div>' +
        '<div><span>Network</span><b>' + esc(networkLabel(it.networkCaip)) + '</b></div>' +
        '<div><span>Recipient</span><b title="' + esc(it.payTo) + '">' + esc(shortAddr(it.payTo)) + '</b></div>' +
        '<div><span>Wallet</span><b title="' + esc(it.walletAddress) + '">' + esc(shortAddr(it.walletAddress)) + '</b></div>' +
        '<div><span>Intent</span><b style="font-family:monospace;font-size:9px">' + esc(it.id) + '</b></div>' +
      '</div>' +
      '<div class="x402-checks">' + checkRows + '</div>' +
      '<div class="x402-row">' +
        '<button class="x402-btn" onclick="X402._back()"><i class="ti ti-arrow-left"></i> Back</button>' +
        '<button class="x402-btn x402-btn-primary" id="x402-pay-btn" onclick="X402._pay()" ' + (res.enabled && !it.blockedReason ? '' : 'disabled') + '><i class="ti ti-credit-card-pay"></i> Confirm &amp; Pay</button>' +
      '</div>' +
    '</div>';
  }

  function renderHistory() {
    var h = getHistory();
    var rows = h.length
      ? h.map(function (e) {
          var badge = e.status === 'paid' ? '<span class="x402-badge x402-live">paid</span>'
            : e.status === 'blocked' ? '<span class="x402-badge x402-warn">blocked</span>'
            : '<span class="x402-badge x402-muted">' + esc(e.status) + '</span>';
          var link = e.txHash
            ? ' · <a class="x402-link" href="' + esc(e.txHash) + '" target="_blank" rel="noopener noreferrer">tx</a>'
            : '';
          return '<div class="x402-hist">' +
            '<div>' + badge + '<b>' + esc(fmtUsd(e.amountAtomic != null ? e.amountAtomic : (e.amountUsd != null ? e.amountUsd * 1e6 : null))) + '</b> · ' + esc(e.service || '') + '</div>' +
            '<div class="x402-hist-sub">' + esc(networkLabel(e.network)) + ' · ' + esc(new Date(e.at).toLocaleString()) + link + '</div>' +
            (e.reason ? '<div class="x402-hist-reason">' + esc(e.reason) + '</div>' : '') +
          '</div>';
        }).join('')
      : '<div class="x402-empty">No x402 payments yet.</div>';
    return '<div class="x402-card"><div class="x402-card-head"><span class="x402-card-title"><i class="ti ti-history"></i> Payment history</span></div>' + rows + '</div>';
  }

  function render() {
    if (!_overlay) return;
    var body =
      renderStatusPanel() +
      renderDiscoverForm() +
      renderDiscovery() +
      renderPrepare() +
      renderHistory();
    _overlay.querySelector('.x402-body').innerHTML = body;
  }

  /* ── Actions ───────────────────────────────────────────────────────── */

  function setBusy(b) {
    _busy = b;
    var btn = document.getElementById('x402-discover-btn');
    if (btn) btn.disabled = b;
    var pay = document.getElementById('x402-pay-btn');
    if (pay) pay.disabled = b || pay.disabled;
  }

  async function _discover() {
    if (_busy) return;
    var input = document.getElementById('x402-url');
    if (!input) return;
    var url = input.value.trim();
    if (!url) { notify('Enter a service URL', 'error'); return; }
    _lastPrepare = null;
    setBusy(true);
    var res = await discover(url);
    setBusy(false);
    if (!res.ok) {
      _lastDiscovery = null;
      notify((res.data && res.data.error) || 'Discovery failed', 'error');
      render();
      return;
    }
    _lastDiscovery = res;
    if (res.data && res.data.x402) {
      notify('Payment required — review the requirements', 'info');
    } else if (res.data && res.data.status !== 402) {
      notify('No payment required (HTTP ' + res.data.status + ')', 'info');
    }
    render();
  }

  async function _prepare(idx) {
    if (_busy) return;
    var d = _lastDiscovery && _lastDiscovery.data;
    if (!d || !d.requirements || !d.requirements[idx]) return;
    var req = d.requirements[idx];
    setBusy(true);
    var res = await prepare(d.resourceUrl, req);
    setBusy(false);
    if (!res.ok) {
      notify((res.data && res.data.error) || 'Prepare failed', 'error');
      return;
    }
    _lastPrepare = res;
    render();
    var it = res.data && res.data.intent;
    if (it && it.blockedReason) {
      pushHistory({
        status: 'blocked', id: it.id, service: res.data.resourceUrl || d.resourceUrl,
        amountAtomic: Math.round((it.amountUsd || 0) * 1e6), network: it.networkCaip, reason: it.blockedReason,
      });
      render();
    }
  }

  async function _pay() {
    if (_busy) return;
    var p = _lastPrepare && _lastPrepare.data;
    var it = p && p.intent;
    if (!it) return;
    if (isAlreadySubmitted(it.id)) {
      notify('This payment was already handled — not resubmitting', 'error');
      return;
    }
    // Explicit authorization is the user clicking "Confirm & Pay". No auto-pay.
    setBusy(true);
    var res = await pay(it);
    setBusy(false);
    if (!res.ok) {
      var reason = (res.data && res.data.error) || 'Payment disabled';
      markSubmitted(it.id, 'blocked');
      pushHistory({
        status: 'blocked', id: it.id, service: p.resourceUrl, amountAtomic: Math.round((it.amountUsd || 0) * 1e6),
        network: it.networkCaip, reason: reason,
      });
      notify(reason, 'error');
      _status = null;
      await getStatus(true);
      render();
      return;
    }
    // Phase 2: record real txHash/opId when settlement is enabled.
    markSubmitted(it.id, 'paid');
    pushHistory({ status: 'paid', id: it.id, service: p.resourceUrl, amountAtomic: Math.round((it.amountUsd || 0) * 1e6), network: it.networkCaip, txHash: null });
    render();
  }

  function _back() { _lastPrepare = null; render(); }

  /* ── Overlay scaffolding ───────────────────────────────────────────── */
  function injectCSS() {
    if (document.getElementById('x402-styles')) return;
    var css = [
      '#x402-overlay{position:fixed;inset:0;z-index:9990;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.72);backdrop-filter:blur(4px)}',
      '.x402-shell{background:var(--card,#111520);border:1px solid var(--border,#232940);border-radius:14px;width:560px;max-width:96vw;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 32px 80px rgba(0,0,0,.7)}',
      '.x402-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--border,#232940)}',
      '.x402-head-title{font-size:12px;font-weight:800;color:var(--text,#e5e7eb);display:flex;align-items:center;gap:8px}',
      '.x402-close{margin-left:auto;background:none;border:none;color:var(--muted2,#94a3b8);cursor:pointer;font-size:16px}',
      '.x402-body{padding:14px;overflow-y:auto;display:flex;flex-direction:column;gap:12px}',
      '.x402-card{background:rgba(0,0,0,.18);border:1px solid var(--border,#232940);border-radius:9px;padding:12px;display:flex;flex-direction:column;gap:8px}',
      '.x402-card-head{display:flex;align-items:center;gap:8px}',
      '.x402-card-title{font-size:11px;font-weight:700;color:var(--text,#e5e7eb);display:flex;align-items:center;gap:6px}',
      '.x402-card-sub{font-size:9px;color:var(--muted2,#94a3b8);line-height:1.5}',
      '.x402-badge{font-size:8px;font-weight:700;padding:2px 7px;border-radius:4px}',
      '.x402-badge.x402-live{background:rgba(34,197,94,.14);color:var(--green,#22c55e)}',
      '.x402-badge.x402-warn{background:rgba(245,158,11,.14);color:var(--yellow,#f59e0b)}',
      '.x402-badge.x402-err{background:rgba(239,68,68,.14);color:var(--red,#ef4444)}',
      '.x402-badge.x402-muted{background:rgba(148,163,184,.14);color:var(--muted2,#94a3b8)}',
      '.x402-kv{display:grid;grid-template-columns:1fr 1fr;gap:6px}',
      '.x402-kv div{display:flex;flex-direction:column;gap:1px;min-width:0}',
      '.x402-kv span{font-size:8px;color:var(--muted2,#94a3b8);text-transform:uppercase;letter-spacing:.4px}',
      '.x402-kv b{font-size:10px;color:var(--text,#e5e7eb);word-break:break-all}',
      '.x402-row{display:flex;gap:8px}',
      '.x402-input{flex:1;background:rgba(0,0,0,.25);border:1px solid var(--border,#232940);border-radius:7px;padding:9px 11px;font-size:11px;color:var(--text,#e5e7eb);font-family:"JetBrains Mono",monospace}',
      '.x402-input:focus{outline:none;border-color:var(--teal,#06F7E9)}',
      '.x402-btn{background:rgba(148,163,184,.12);border:1px solid var(--border,#232940);color:var(--text,#e5e7eb);border-radius:7px;padding:9px 12px;font-size:10px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px;white-space:nowrap}',
      '.x402-btn:hover:not(:disabled){border-color:var(--teal,#06F7E9)}',
      '.x402-btn:disabled{opacity:.45;cursor:not-allowed}',
      '.x402-btn-primary{background:linear-gradient(135deg,#06F7E9,#4f8ef7);color:#081018;border:none}',
      '.x402-checks{display:flex;flex-direction:column;gap:4px;margin-top:2px}',
      '.x402-check{display:flex;align-items:center;gap:7px;font-size:9px;color:var(--muted2,#94a3b8)}',
      '.x402-check i{font-size:11px;flex-shrink:0}',
      '.x402-check-name{color:var(--text,#e5e7eb);font-weight:600;min-width:120px}',
      '.x402-check-detail{margin-left:auto;text-align:right;word-break:break-all}',
      '.x402-netlist{display:flex;flex-direction:column;gap:3px}',
      '.x402-net{display:flex;align-items:center;gap:8px;font-size:9px;color:var(--muted2,#94a3b8)}',
      '.x402-net-caip{font-family:"JetBrains Mono",monospace;color:var(--text,#e5e7eb)}',
      '.x402-errbox{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);color:var(--red,#ef4444);border-radius:7px;padding:9px 11px;font-size:10px;display:flex;gap:7px;align-items:flex-start}',
      '.x402-okbox{background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.3);color:var(--green,#22c55e);border-radius:7px;padding:9px 11px;font-size:10px;display:flex;gap:7px;align-items:flex-start}',
      '.x402-hist{display:flex;flex-direction:column;gap:3px;padding:7px 0;border-bottom:1px solid var(--border,#232940)}',
      '.x402-hist:last-child{border-bottom:none}',
      '.x402-hist div{font-size:10px;color:var(--text,#e5e7eb)}',
      '.x402-hist-sub{font-size:8.5px;color:var(--muted2,#94a3b8)}',
      '.x402-hist-reason{font-size:8.5px;color:var(--yellow,#f59e0b)}',
      '.x402-link{color:var(--teal,#06F7E9)}',
      '.x402-empty{font-size:9.5px;color:var(--muted2,#94a3b8);padding:6px 0}',
    ].join('\n');
    var style = document.createElement('style');
    style.id = 'x402-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function close() {
    if (_overlay) { _overlay.remove(); _overlay = null; }
  }

  async function open() {
    injectCSS();
    close();
    _overlay = document.createElement('div');
    _overlay.id = 'x402-overlay';
    _overlay.innerHTML =
      '<div class="x402-shell">' +
        '<div class="x402-head">' +
          '<span class="x402-head-title"><i class="ti ti-credit-card-pay" style="color:#06F7E9"></i> x402 Payments</span>' +
          '<button class="x402-close" onclick="X402.close()" title="Close"><i class="ti ti-x"></i></button>' +
        '</div>' +
        '<div class="x402-body"></div>' +
      '</div>';
    _overlay.addEventListener('click', function (e) { if (e.target === _overlay) close(); });
    document.body.appendChild(_overlay);

    _status = null;
    await getStatus(true);
    render();
  }

  /* ── Exports ───────────────────────────────────────────────────────── */
  var API = {
    open: open,
    close: close,
    getStatus: getStatus,
    discover: discover,
    prepare: prepare,
    pay: pay,
    render: render,
    _discover: _discover,
    _prepare: _prepare,
    _pay: _pay,
    _back: _back,
    getHistory: getHistory,
  };

  if (typeof window !== 'undefined') window.X402 = API;
  else if (typeof globalThis !== 'undefined') globalThis.X402 = API;
})();
