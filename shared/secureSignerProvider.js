/**
 * AUTONOMA-6B — Secure Signer Provider (Proof of Concept)
 * ═══════════════════════════════════════════════════════════════════════
 * A single signer abstraction for the Autonoma execution authority.
 *
 *   AgentScheduleExecutor  (the ONE execution authority)
 *        ↓
 *   SecureSignerProvider
 *        ├── BrowserSigner   (default — unchanged: browser Agent Wallet)
 *        └── CircleSigner    (Circle secure wallet, signed SERVER-SIDE)
 *
 * Design rules (do not regress):
 *   1. Browser is ALWAYS the default provider. Nothing changes unless the
 *      operator explicitly selects `circle`.
 *   2. In circle mode the signer is resolved SERVER-SIDE (never in the
 *      browser). No Circle secret ever exists in client code.
 *   3. FAIL-CLOSED: in circle mode, if the Circle signer endpoint is
 *      unavailable, misconfigured, or rejects the request, the operation
 *      FAILS. There is NEVER a silent fallback to the browser signer.
 *   4. No duplicate authority: browser-mode broadcast/nonce/receipt still
 *      delegate to AgentScheduleExecutor (the single broadcast primitive).
 *   5. This module contains NO raw-key access and NO transaction-signing or
 *      raw-broadcast primitives — those remain exclusively inside
 *      AgentScheduleExecutor (AUTONOMA-1/2).
 *
 * Attached to window.SecureSignerProvider
 */
(function () {
  'use strict';

  if (typeof window !== 'undefined' && window.SecureSignerProvider) return;

  var BROWSER_MODE = 'browser';
  var CIRCLE_MODE = 'circle';

  var FLAG_KEY = 'elligentt_autonoma_signer_provider';
  var ARC_CHAIN_ID = 5042002;

  // Circle config resolved from the server (contains only public info:
  // availability + the circle wallet ADDRESS). No secret material.
  var _circleConfig = null;
  var _configPromise = null;

  function _readFlag() {
    try {
      if (typeof window !== 'undefined') {
        if (window.AUTONOMA_SIGNER_PROVIDER === CIRCLE_MODE) return CIRCLE_MODE;
        if (window.AUTONOMA_SIGNER_PROVIDER === BROWSER_MODE) return BROWSER_MODE;
      }
      if (typeof localStorage !== 'undefined') {
        var v = localStorage.getItem(FLAG_KEY);
        if (v === CIRCLE_MODE) return CIRCLE_MODE;
        if (v === BROWSER_MODE) return BROWSER_MODE;
      }
    } catch (e) {}
    return BROWSER_MODE;
  }

  var _mode = _readFlag();

  function _authority() {
    try { return (typeof AgentScheduleExecutor !== 'undefined') ? AgentScheduleExecutor : null; } catch (e) { return null; }
  }

  function _chainIdOf(provider) {
    try {
      if (provider && provider._network && provider._network.chainId) return Number(provider._network.chainId);
    } catch (e) {}
    return ARC_CHAIN_ID;
  }

  /* ── Mode selection ── */
  function getMode() { return _mode; }
  function isCircleMode() { return _mode === CIRCLE_MODE; }
  function isBrowserMode() { return _mode === BROWSER_MODE; }

  function setMode(mode) {
    if (mode !== BROWSER_MODE && mode !== CIRCLE_MODE) {
      throw new Error('Invalid signer provider: ' + mode);
    }
    _mode = mode;
    reset();
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(FLAG_KEY, mode); } catch (e) {}
    return _mode;
  }

  function reset() {
    _configPromise = null;
    _circleConfig = null;
  }

  /* ── Circle config (public info only; fails closed) ── */
  function _ensureCircleConfig() {
    if (_circleConfig) return Promise.resolve(_circleConfig);
    if (_configPromise) return _configPromise;
    _configPromise = fetch('/api/agent-signer/config', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    })
      .then(function (r) {
        if (!r.ok) throw new Error('Circle signer config unavailable (' + r.status + ')');
        return r.json();
      })
      .then(function (cfg) {
        if (!cfg || cfg.available !== true || !cfg.address) {
          throw new Error('Circle signer not configured');
        }
        _circleConfig = cfg;
        return cfg;
      })
      .catch(function (e) {
        _configPromise = null;
        throw e;
      });
    return _configPromise;
  }

  /* ── Signer resolution ── */
  // browser mode: return null → caller uses the existing browser Agent Wallet
  // (getSessionSigner). circle mode: return a remote signer STUB (address +
  // provider) so the existing execution code keeps working, but signing is
  // performed by the server.
  async function getSigner(provider) {
    if (isBrowserMode()) return null;
    var cfg = await _ensureCircleConfig();
    return {
      address: cfg.address,
      isRemote: true,
      provider: provider || null
    };
  }

  async function getSignerAddress() {
    if (isBrowserMode()) return null;
    var cfg = await _ensureCircleConfig();
    return cfg.address;
  }

  /* ── Nonce ── */
  async function nextNonce(provider, from) {
    if (isBrowserMode()) {
      var a = _authority();
      if (!a || typeof a.nextNonce !== 'function') throw new Error('Execution authority unavailable (nonce)');
      return await a.nextNonce(provider, from);
    }
    // circle mode: the nonce is resolved SERVER-SIDE for the circle wallet.
    var res = await _postJson('/api/agent-signer/nonce', {
      chainId: _chainIdOf(provider),
      address: (typeof from === 'string') ? from : (from && from.address ? from.address : null)
    });
    if (!res || res.ok !== true || res.nonce == null) {
      throw new Error('Circle nonce unavailable: ' + ((res && (res.error || res.reason)) || 'unknown'));
    }
    return res.nonce;
  }

  /* ── Broadcast (sign + send) ── */
  // browser mode: delegate to the SINGLE execution authority primitive.
  // circle mode: send a structured request to the server; the server signs
  // and broadcasts via the Circle wallet. FAIL-CLOSED — never fall back.
  async function broadcast(signer, provider, rawTx, opts) {
    if (isBrowserMode()) {
      var a = _authority();
      if (!a || typeof a.broadcast !== 'function') throw new Error('Execution authority unavailable (broadcast)');
      return await a.broadcast(signer, provider, rawTx);
    }

    opts = opts || {};
    var circleReq = opts.circle || null;
    if (!circleReq) {
      throw new Error('Circle signer requires a structured request (circle descriptor missing — fail-closed)');
    }

    var body = {
      chainId: rawTx && rawTx.chainId != null ? Number(rawTx.chainId) : _chainIdOf(provider),
      operation: opts.operation || circleReq.operation || '',
      executionId: opts.executionId || null,
      request: circleReq
    };

    var res = await _postJson('/api/agent-signer/broadcast', body);
    if (!res || res.ok !== true || !res.txHash) {
      throw new Error('Circle signer broadcast failed: ' + ((res && (res.error || res.reason)) || 'unknown'));
    }
    return res.txHash;
  }

  /* ── Receipt (read-only — safe in both modes) ── */
  async function waitReceipt(provider, txHash) {
    var a = _authority();
    if (!a || typeof a.waitReceipt !== 'function') throw new Error('Execution authority unavailable (receipt)');
    return await a.waitReceipt(provider, txHash);
  }

  function _postJson(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        return { ok: r.ok, status: r.status, data: data };
      });
    }).then(function (wrapped) {
      if (!wrapped.ok) {
        var err = (wrapped.data && (wrapped.data.error || wrapped.data.reason)) || ('HTTP ' + wrapped.status);
        throw new Error(err);
      }
      return wrapped.data;
    });
  }

  function getStatus() {
    return {
      mode: _mode,
      circleConfigured: !!_circleConfig,
      circleAvailable: _circleConfig ? !!_circleConfig.available : false,
      circleAddress: _circleConfig ? (_circleConfig.address || null) : null
    };
  }

  window.SecureSignerProvider = {
    BROWSER_MODE: BROWSER_MODE,
    CIRCLE_MODE: CIRCLE_MODE,
    getMode: getMode,
    setMode: setMode,
    isCircleMode: isCircleMode,
    isBrowserMode: isBrowserMode,
    reset: reset,
    getSigner: getSigner,
    getSignerAddress: getSignerAddress,
    nextNonce: nextNonce,
    broadcast: broadcast,
    waitReceipt: waitReceipt,
    getStatus: getStatus,
    version: 'AUTONOMA-6B'
  };
})();
