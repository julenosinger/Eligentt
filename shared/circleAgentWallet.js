/**
 * Circle Agent Wallet — Frontend Client
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
   * validate(to, amount) → { valid, checks }
   */
  async function validate(to, amount) {
    var res = await _call('validate', {
      method: 'POST',
      body: JSON.stringify({ to: to, amount: amount })
    });
    return res.data;
  }

  /**
   * transfer(to, amount, tokenAddress, blockchain, idempotencyKey) → Circle transaction response
   * All fields required except idempotencyKey (auto-generated server-side if omitted).
   * USDC on Arc Mainnet: blockchain = 'ARC', tokenAddress = USDC contract on Arc.
   */
  async function transfer(to, amount, tokenAddress, blockchain, idempotencyKey) {
    var res = await _call('transfer', {
      method: 'POST',
      body: JSON.stringify({
        to: to,
        amount: amount,
        tokenAddress: tokenAddress || '0x3600000000000000000000000000000000000000',
        blockchain: blockchain || 'ARC',
        idempotencyKey: idempotencyKey || null
      })
    });
    _cache.status = null; // invalidate cache after transfer
    return { ok: res.ok, data: res.data };
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
  async function statusHTML() {
    var s = await getStatus();
    if (!s || s.ok === false || s.error) {
      var errMsg = (s && s.error) ? s.error : 'Could not reach /api/agent — check Cloudflare secrets';
      return '<div class="caw-card caw-unconfigured">' +
        '<div class="caw-card-icon"><i class="ti ti-robot-off"></i></div>' +
        '<div class="caw-card-body">' +
          '<div class="caw-card-title">Circle Agent Wallet</div>' +
          '<div class="caw-card-sub">' + errMsg + '</div>' +
        '</div></div>';
    }
    if (s.paused) {
      return '<div class="caw-card caw-paused">' +
        '<div class="caw-card-icon" style="color:var(--yellow)"><i class="ti ti-pause-circle"></i></div>' +
        '<div class="caw-card-body">' +
          '<div class="caw-card-title">Circle Agent Wallet <span class="caw-badge paused">Paused</span></div>' +
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
        '<div class="caw-card-title">Circle Agent Wallet <span class="caw-badge ' + stateCls + '">' + walletState + '</span></div>' +
        '<div class="caw-card-addr" title="' + addr + '">' + addrShort + ' <button onclick="navigator.clipboard.writeText(\'' + addr + '\').then(()=>toast(\'Copied\',\'success\'))" style="background:none;border:none;cursor:pointer;color:var(--muted2);font-size:9px" title="Copy"><i class="ti ti-copy"></i></button></div>' +
        '<div class="caw-card-bals">' + balStr + '</div>' +
      '</div>' +
      '<button class="btn" onclick="CircleAgent.refreshCard()" style="font-size:8px;padding:3px 7px;align-self:flex-start"><i class="ti ti-refresh"></i></button>' +
    '</div>';
  }

  /**
   * getCachedAddress() → the Circle wallet address from the last status call,
   * or null if status has not been fetched yet.
   */
  function getCachedAddress() {
    var s = _cache.status;
    if (!s) return null;
    return s.walletAddress || (s.wallet && s.wallet.address) || null;
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
    el.innerHTML = '<div style="font-size:9px;color:var(--muted2);padding:8px">Loading Circle Agent Wallet…</div>';
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

  /* ── Exports ─────────────────────────────────────────── */
  var API = {
    getStatus: getStatus,
    getBalance: getBalance,
    getTransactions: getTransactions,
    validate: validate,
    transfer: transfer,
    formatBalance: formatBalance,
    statusHTML: statusHTML,
    getCachedAddress: getCachedAddress,
    refreshCard: refreshCard,
    mount: mount,
  };

  if (typeof window !== 'undefined') window.CircleAgent = API;
  else if (typeof globalThis !== 'undefined') globalThis.CircleAgent = API;
})();
