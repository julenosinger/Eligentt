/**
 * SwapRenderer — Swap UI wrapper (Phase 2)
 * Attached to: window.SwapRenderer
 */
(function () {
  'use strict';
  var _init = false, _subs = [];

  function initialize() {
    if (_init) return; _init = true;
    if (typeof EventBus !== 'undefined') {
      _subs.push(EventBus.on('PAGE_CHANGED', function (p) { if (p && p.page === 'swap') render(); }));
      _subs.push(EventBus.on('BALANCE_REFRESHED', function () { render(); }));
    }
  }
  function render() {
    try { if (typeof updateSwapRate === 'function') updateSwapRate(); } catch (_e) {}
    try { if (typeof renderSwapTokenList === 'function') renderSwapTokenList(); } catch (_e2) {}
  }
  function refresh() {
    try { if (typeof updateSwapRate === 'function') updateSwapRate(); } catch (_e) {}
    try { if (typeof refreshBalance === 'function') refreshBalance(); } catch (_e2) {}
  }
  function destroy() { _subs.forEach(function (s) { try { s.off(); } catch (_e) {} }); _subs = []; _init = false; }

  window.SwapRenderer = { VERSION: '1.0.0', initialize: initialize, render: render, refresh: refresh, destroy: destroy };
})();
