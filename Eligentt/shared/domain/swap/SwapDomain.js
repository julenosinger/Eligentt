/**
 * SwapDomain — Token swap orchestration (Phase 3)
 * Wraps existing swap execution. Never duplicates logic.
 * Attached to: window.SwapDomain
 */
(function () {
  'use strict';
  var _init = false;

  function initialize() { if (_init) return; _init = true; }

  function validate(params) {
    var p = params || {};
    if (!p.amount || Number(p.amount) <= 0) return { valid: false, reason: 'Invalid amount' };
    if (!p.fromToken || !p.toToken) return { valid: false, reason: 'Both tokens required' };
    if (p.fromToken === p.toToken) return { valid: false, reason: 'Same token' };
    try {
      var addr = typeof walletAddress !== 'undefined' ? walletAddress : null;
      if (!addr) return { valid: false, reason: 'Wallet not connected' };
    } catch (_e) { return { valid: false, reason: 'Wallet error' }; }
    return { valid: true };
  }

  function getQuote(amount, fromToken, toToken) {
    try {
      if (typeof updateSwapRate === 'function') updateSwapRate();
      var rateEl = document.getElementById('swap-rate');
      if (rateEl) return { rate: rateEl.textContent, estimated: null };
    } catch (_e) {}
    return null;
  }

  function execute(amount, fromToken, toToken) {
    try {
      if (typeof executeSwap === 'function') { executeSwap(amount, fromToken, toToken); return true; }
    } catch (e) {
      try { if (typeof ErrorHandler !== 'undefined') ErrorHandler.handle(e, { source: 'swap', operation: 'execute' }); } catch (_e) {}
    }
    return false;
  }

  function refresh() {
    try { if (typeof updateSwapRate === 'function') updateSwapRate(); } catch (_e) {}
  }

  function destroy() { _init = false; }

  window.SwapDomain = {
    VERSION: '1.0.0',
    initialize: initialize, validate: validate, getQuote: getQuote,
    execute: execute, refresh: refresh, destroy: destroy
  };
})();
