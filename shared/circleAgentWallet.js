/**
 * Circle AI Smart Wallet — Frontend Client
 *
 * Thin browser-side client for the /api/agent/* Cloudflare Pages Function.
 * All Circle secrets (API key, entity secret) live SERVER-SIDE ONLY.
 * This module never stores or exposes secrets.
 *
 * Used by:
 *   - Autonoma (AI Agent) — status display + intent routing
 *   - AI Smart Wallet     — Mission Control + transfer execution
 *
 * Attached to window.CircleAgent
 */
(function () {
  'use strict';

  var BASE = '/api/agent';
  var _cache = {};
  var _cacheMs = 15000; // 15 s cache for status/balance

  /* ── Internal fetch helper ────────────────────────────── */
  async function _call(path, options) {
    var url = BASE + (path ? '/' + path : '');
    try {
      var resp = await fetch(url, Object.assign({ headers: { 'Content-Type': 'application/json' } }, options || {}));
      var data = await resp.json();
      return { ok: resp.ok, status: resp.status, data: data };
    } catch (e) {
      return { ok: false, status: 0, data: { error: e.message || 'Network error' } };
    }
  }

  /* ── Public API ──────────────────────────────────────── */

  /**
   * getStatus() → { configured, paused, walletId, walletAddress, wallet, balances, entitySecretSet }
   * Cached for 15 s.
   */
  async function getStatus(forceRefresh) {
    var now = Date.now();
    if (!forceRefresh && _cache.status && (now - _cache.statusAt) < _cacheMs) {
      return _cache.status;
    }
    var res = await _call('status');
    if (res.ok) {
      _cache.status = res.data;
      _cache.statusAt = now;
    }
    return res.data;
  }

  /**
   * getBalance() → Circle wallets balance response
   */
  async function getBalance() {
    var res = await _call('balance');
    return res.data;
  }

  /**
   * getTransactions() → Circle transaction list
   */
  async function getTransactions() {
    var res = await _call('transactions');
    return res.data;
  }

  /**
   * formatBalance(balances) → { USDC: '0.00', EURC: '0.00', ... }
   * Normalizes Circle's tokenBalances array into a simple symbol→amount map.
   */
  function formatBalance(balances) {
    var result = {};
    if (!balances || !balances.tokenBalances) return result;
    balances.tokenBalances.forEach(function (tb) {
      var sym = (tb.token && tb.token.symbol) ? tb.token.symbol : 'UNKNOWN';
      result[sym] = parseFloat(tb.amount || 0).toFixed(2);
    });
    return result;
  }

  /**
   * statusHTML() → renders a compact HTML status card for embedding in
   * Autonoma's welcome panel and AI Smart Wallet Mission Control.
   */
  /**
   * provision() — calls POST /api/agent/provision to create a per-user
   * Circle wallet on Arc Mainnet. Idempotent: safe to call multiple times.
   * Returns { ok, address, walletId, alreadyProvisioned, error }.
   */
  async function provision() {
    try {
      // Build headers — always include credentials (cookie) and also pass
      // the session token as Authorization: Bearer so the backend can
      // authenticate even if the HttpOnly cookie was not forwarded
      // (e.g. SameSite restrictions, expired cookie, browser quirks).
      var headers = { 'Content-Type': 'application/json' };
      try {
        // Auth module exposes getSessionToken(); if it returns null we fall
        // back to reading the raw value from localStorage directly.
        var tok = null;
        if (typeof Auth !== 'undefined' && typeof Auth.getSessionToken === 'function') {
          tok = Auth.getSessionToken();
        }
        if (!tok) {
          // Attempt direct localStorage read — the session key used by auth.js
          var raw = localStorage.getItem('elligente_session');
          if (raw) {
            var parsed = JSON.parse(raw);
            if (parsed && parsed.token) tok = parsed.token;
          }
        }
        if (!tok) {
          // Last resort: read from the elligente_sid cookie (visible only if
          // the cookie was NOT set HttpOnly — keep as fallback, harmless if absent)
          var cm = document.cookie.match(/elligente_sid=([^;]+)/);
          if (cm) tok = cm[1];
        }
        if (tok) headers['Authorization'] = 'Bearer ' + tok;
      } catch (_e) {}
      var resp = await fetch('/api/agent/provision', {
        method: 'POST',
        credentials: 'include',
        headers: headers,
      });
      var data = await resp.json();
      if (resp.ok && data.ok) {
        // Bust cache so next mount/refresh picks up the new wallet
        _cache.status = null;
      }
      return data;
    } catch (e) {
      return { ok: false, error: e.message || 'Network error' };
    }
  }

  async function statusHTML() {
    var s = await getStatus();
    if (!s || s.ok === false || s.error) {
      var errMsg = (s && s.error) ? s.error : 'Could not reach /api/agent — check Cloudflare secrets';
      // Distinguish "not configured" (server secrets missing) from "no wallet yet"
      var noWallet = s && (s.status === 503 || (s.error && s.error.indexOf('not configured') !== -1));
      if (!noWallet && s && s.error && s.error.indexOf('wallet') !== -1) noWallet = true;
      return '<div class="caw-card caw-unconfigured">' +
        '<div class="caw-card-icon"><i class="ti ti-robot-off"></i></div>' +
        '<div class="caw-card-body">' +
          '<div class="caw-card-title">Circle AI Smart Wallet</div>' +
          '<div class="caw-card-sub">' + errMsg + '</div>' +
        '</div></div>';
    }

    // User doesn't have a personal wallet yet — show Create My Wallet CTA
    // (needsProvision comes from the backend; isPerUser === false means using platform fallback)
    if (s.needsProvision || (!s.isPerUser && s.isPerUser !== undefined)) {
      var platAddr = s.walletAddress || (s.wallet && s.wallet.address) || '';
      var platShort = platAddr ? (platAddr.slice(0,6) + '…' + platAddr.slice(-4)) : '';
      return '<div style="display:flex;flex-direction:column;gap:8px">' +
        // CTA card
        '<div class="caw-card" style="flex-direction:column;align-items:flex-start;gap:10px;border-color:rgba(39,117,202,.35);background:rgba(39,117,202,.07)">' +
          '<div style="display:flex;align-items:center;gap:10px;width:100%">' +
            '<div class="caw-card-icon" style="color:#2775ca"><i class="ti ti-wallet-plus" style="font-size:22px"></i></div>' +
            '<div class="caw-card-body">' +
              '<div class="caw-card-title">Create Your Personal AI Wallet</div>' +
              '<div class="caw-card-sub">Get your own Circle wallet on Arc Mainnet for Autonoma operations — no seed phrase, no private key to manage.</div>' +
            '</div>' +
          '</div>' +
          '<div style="width:100%;padding:10px 12px;border-radius:8px;background:rgba(39,117,202,.06);border:1px solid rgba(39,117,202,.15)">' +
            '<div style="font-size:8.5px;color:var(--muted2);margin-bottom:8px;display:flex;flex-wrap:wrap;gap:12px">' +
              '<span><i class="ti ti-check" style="color:var(--green)"></i> Arc Mainnet</span>' +
              '<span><i class="ti ti-check" style="color:var(--green)"></i> Circle Developer-Controlled</span>' +
              '<span><i class="ti ti-check" style="color:var(--green)"></i> No seed phrase</span>' +
              '<span><i class="ti ti-check" style="color:var(--green)"></i> Autonoma-ready</span>' +
            '</div>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
              '<button id="caw-create-btn" onclick="CircleAgent._handleCreate(this)" ' +
                'style="background:linear-gradient(135deg,#2775ca,#1a5fa8);color:#fff;border:none;border-radius:6px;padding:8px 18px;font-size:10.5px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px;box-shadow:0 2px 8px rgba(39,117,202,.3)">' +
                '<i class="ti ti-wallet-plus"></i>Create My Wallet' +
              '</button>' +
              '<span style="font-size:8px;color:var(--muted2)">Free · Instant · Arc Mainnet</span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        // Platform wallet shown below as reference
        (platShort ? '<div style="font-size:8px;color:var(--muted2);padding:5px 8px;border-radius:5px;border:1px solid var(--border);background:rgba(0,0,0,.1)">' +
          '<i class="ti ti-building-bank" style="margin-right:4px"></i>Platform wallet in use until yours is created: ' +
          '<span style="font-family:monospace;color:var(--muted2)">' + platShort + '</span>' +
        '</div>' : '') +
      '</div>';
    }
    if (s.paused) {
      return '<div class="caw-card caw-paused">' +
        '<div class="caw-card-icon" style="color:var(--yellow)"><i class="ti ti-pause-circle"></i></div>' +
        '<div class="caw-card-body">' +
          '<div class="caw-card-title">Circle AI Smart Wallet <span class="caw-badge paused">Paused</span></div>' +
          '<div class="caw-card-sub">Kill switch active — transfers are blocked</div>' +
        '</div></div>';
    }
    // s.balances is already the flat array from the server
    var bals = formatBalance({ tokenBalances: s.balances || [] });
    var balStr = Object.keys(bals).length
      ? Object.keys(bals).map(function (k) { return '<span class="caw-bal"><b>' + bals[k] + '</b> ' + k + '</span>'; }).join(' &nbsp; ')
      : '<span class="caw-bal muted">No balances</span>';
    var addr = s.walletAddress || (s.wallet && s.wallet.address) || '';
    var addrShort = addr ? (addr.slice(0,6) + '...' + addr.slice(-4)) : '—';
    var walletState = s.wallet ? s.wallet.state : 'UNKNOWN';
    var stateCls = walletState === 'LIVE' ? 'live' : walletState === 'FROZEN' ? 'frozen' : 'pending';
    return '<div class="caw-card caw-live">' +
      '<div class="caw-card-icon" style="color:#2775ca"><img src="/assets/tokens/usdc/Symbol/USDC-symbol.png" style="width:28px;height:28px;border-radius:50%" alt="USDC"></div>' +
      '<div class="caw-card-body">' +
        '<div class="caw-card-title">Circle AI Smart Wallet <span class="caw-badge ' + stateCls + '">' + walletState + '</span></div>' +
        '<div class="caw-card-addr" title="' + addr + '">' + addrShort + ' <button onclick="navigator.clipboard.writeText(\'' + addr + '\').then(()=>toast(\'Copied\',\'success\'))" style="background:none;border:none;cursor:pointer;color:var(--muted2);font-size:9px" title="Copy"><i class="ti ti-copy"></i></button></div>' +
        '<div class="caw-card-bals">' + balStr + '</div>' +
      '</div>' +
      '<button class="btn" onclick="CircleAgent.refreshCard()" style="font-size:8px;padding:3px 7px;align-self:flex-start"><i class="ti ti-refresh"></i></button>' +
    '</div>';
  }

  /**
   * _readCachedAddress() → the Circle wallet address from the last status call,
   * or null if status has not been fetched yet.
   */
  function _readCachedAddress() {
    var s = _cache.status;
    if (!s) return null;
    return s.walletAddress || (s.wallet && s.wallet.address) || null;
  }

  var _addressPromise = null;
  var _lastResolveAttempt = 0;

  /**
   * resolveAddress() → the Circle AI Smart Wallet address, resolving it from the
   * real Circle status when the cache is empty. Never invents an address and
   * never falls back to another wallet; returns null only when Circle genuinely
   * has no wallet to resolve.
   */
  async function resolveAddress() {
    var cached = _readCachedAddress();
    if (cached) return cached;
    if (_addressPromise) return _addressPromise;
    var now = Date.now();
    if (now - _lastResolveAttempt < 5000) return null;
    _lastResolveAttempt = now;
    _addressPromise = getStatus(true)
      .then(function (s) {
        return (s && (s.walletAddress || (s.wallet && s.wallet.address))) || null;
      })
      .catch(function () { return null; })
      .finally(function () { _addressPromise = null; });
    return _addressPromise;
  }

  /**
   * getCachedAddress() → the cached Circle wallet address. When the cache is
   * empty, this kicks off a non-blocking resolution against the real Circle
   * status so the address becomes available as soon as possible, instead of
   * treating an empty cache as "wallet does not exist".
   */
  function getCachedAddress() {
    var addr = _readCachedAddress();
    if (addr) return addr;
    try { resolveAddress(); } catch (_e) {}
    return null;
  }

  /**
   * refreshCard() — re-renders all .caw-mount elements on the page
   */
  async function refreshCard() {
    _cache.status = null;
    var mounts = document.querySelectorAll('.caw-mount');
    if (!mounts.length) return;
    var html = await statusHTML();
    mounts.forEach(function (m) { m.innerHTML = html; });
  }

  /**
   * mount(selector) — renders the status card into a selector
   */
  async function mount(selector) {
    var el = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (!el) return;
    el.classList.add('caw-mount');
    el.innerHTML = '<div style="font-size:9px;color:var(--muted2);padding:8px">Loading Circle AI Smart Wallet…</div>';
    var html = await statusHTML();
    el.innerHTML = html;
  }

  /* ── CSS (injected once) ─────────────────────────────── */
  function _injectCSS() {
    if (document.getElementById('caw-styles')) return;
    var style = document.createElement('style');
    style.id = 'caw-styles';
    style.textContent = [
      '.caw-card{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;border:1px solid var(--border);background:rgba(0,0,0,.18)}',
      '.caw-card.caw-live{border-color:rgba(39,117,202,.3);background:rgba(39,117,202,.06)}',
      '.caw-card.caw-paused{border-color:rgba(245,158,11,.3);background:rgba(245,158,11,.05)}',
      '.caw-card.caw-unconfigured{border-color:var(--border);opacity:.7}',
      '.caw-card-icon{font-size:22px;flex-shrink:0}',
      '.caw-card-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.caw-card-title{font-size:10px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:6px}',
      '.caw-card-sub{font-size:8.5px;color:var(--muted2)}',
      '.caw-card-addr{font-size:8.5px;color:var(--muted2);font-family:"JetBrains Mono",monospace;display:flex;align-items:center;gap:3px}',
      '.caw-card-bals{font-size:9px;color:var(--text);display:flex;flex-wrap:wrap;gap:8px;margin-top:2px}',
      '.caw-bal{color:var(--teal)}.caw-bal.muted{color:var(--muted2)}',
      '.caw-badge{font-size:7.5px;padding:2px 6px;border-radius:3px;font-weight:600}',
      '.caw-badge.live{background:rgba(34,197,94,.12);color:var(--green)}',
      '.caw-badge.frozen{background:rgba(239,68,68,.12);color:var(--red)}',
      '.caw-badge.pending{background:rgba(245,158,11,.12);color:var(--yellow)}',
      '.caw-badge.paused{background:rgba(245,158,11,.12);color:var(--yellow)}',
    ].join('');
    document.head.appendChild(style);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _injectCSS);
  } else {
    _injectCSS();
  }

  /**
   * _handleCreate(btn) — called by the "Create My Wallet" button.
   * Shows a loading state, calls provision(), then refreshes all cards.
   */
  async function _handleCreate(btn) {
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i> Creating…'; }
    try {
      var res = await provision();
      if (res && res.ok) {
        var msg = res.alreadyProvisioned
          ? 'Wallet already exists: ' + (res.address ? res.address.slice(0,6) + '…' + res.address.slice(-4) : '')
          : 'Wallet created on Arc Mainnet: ' + (res.address ? res.address.slice(0,6) + '…' + res.address.slice(-4) : '');
        try { if (typeof toast === 'function') toast(msg, 'success'); } catch(_e){}
        await refreshCard();
      } else {
        var errMsg = (res && res.error) ? res.error : 'Wallet creation failed';
        try { if (typeof toast === 'function') toast(errMsg, 'error'); } catch(_e){}
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-wallet-plus"></i>Create My Wallet'; }
      }
    } catch(e) {
      try { if (typeof toast === 'function') toast('Error: ' + (e.message || e), 'error'); } catch(_e){}
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-wallet-plus"></i>Create My Wallet'; }
    }
  }

  /* ── Exports ─────────────────────────────────────────── */
  var API = {
    getStatus: getStatus,
    getBalance: getBalance,
    getTransactions: getTransactions,
    formatBalance: formatBalance,
    statusHTML: statusHTML,
    getCachedAddress: getCachedAddress,
    resolveAddress: resolveAddress,
    refreshCard: refreshCard,
    mount: mount,
    provision: provision,
    _handleCreate: _handleCreate,
  };

  if (typeof window !== 'undefined') window.CircleAgent = API;
  else if (typeof globalThis !== 'undefined') globalThis.CircleAgent = API;
})();
