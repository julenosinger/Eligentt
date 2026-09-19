/**
 * SwapPage — Extracted Swap Feature Module (Phase 14.2)
 * Migrates: updateSwapRate, swap UI, quote rendering, execution routing.
 * Attached to: window.SwapPage
 */
(function () {
  'use strict';
  var _init = false, _subs = [];

  function initialize() {
    if (_init) return; _init = true;
    try {
      if (typeof EventBus !== 'undefined') {
        _subs.push(EventBus.on('PAGE_CHANGED', function (p) { if (p && p.page === 'swap') render(); }));
        _subs.push(EventBus.on('BALANCE_REFRESHED', function () { render(); }));
      }
      if (typeof TabManager !== 'undefined') TabManager.register('swap', { init: render });
    } catch (_e) {}
  }

  function render() {
    try { if (typeof CoreMigrate !== 'undefined') CoreMigrate.swap_refresh(); else if (typeof updateSwapRate === 'function') updateSwapRate(); } catch (_e) {}
    try { if (typeof renderSwapTokenList === 'function') renderSwapTokenList(); } catch (_e2) {}
  }

  function execute(amount, fromToken, toToken) {
    try { if (typeof CoreMigrate !== 'undefined') return CoreMigrate.swap_execute(amount, fromToken, toToken); } catch (_e) {}
    try { if (typeof SwapDomain !== 'undefined') return SwapDomain.execute(amount, fromToken, toToken); } catch (_e2) {}
    try { if (typeof executeSwap === 'function') { executeSwap(amount, fromToken, toToken); return true; } } catch (_e3) {}
    return false;
  }

  function getQuote(amount, fromToken, toToken) {
    try { if (typeof CoreMigrate !== 'undefined') return CoreMigrate.swap_getQuote(amount, fromToken, toToken); } catch (_e) {}
    try { if (typeof SwapDomain !== 'undefined') return SwapDomain.getQuote(amount, fromToken, toToken); } catch (_e2) {}
    return null;
  }

  function destroy() { _subs.forEach(function (s) { try { s.off(); } catch (_e) {} }); _subs = []; _init = false; }

  window.SwapPage = { VERSION: '14.0.0', initialize: initialize, render: render, execute: execute, getQuote: getQuote, destroy: destroy };
})();
