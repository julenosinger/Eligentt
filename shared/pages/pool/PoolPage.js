/**
 * PoolPage — Liquidity Pool Feature Module (Phase 15)
 * Migrates: pool rendering, TVL, deposits, withdrawals, positions.
 * Attached to: window.PoolPage
 */
(function () {
  'use strict';
  var _init = false, _subs = [];

  function initialize() {
    if (_init) return; _init = true;
    try {
      if (typeof EventBus !== 'undefined') {
        _subs.push(EventBus.on('PAGE_CHANGED', function (p) { if (p && p.page === 'pool') render(); }));
        _subs.push(EventBus.on('POOL_REFRESH', function () { render(); }));
      }
      if (typeof TabManager !== 'undefined') TabManager.register('pool', { init: render });
    } catch (_e) {}
  }

  function render() {
    try { if (typeof renderPoolList === 'function') renderPoolList(); } catch (_e) {}
    try { if (typeof renderMyLPPositions === 'function') renderMyLPPositions(); } catch (_e2) {}
    try { if (typeof updatePoolStats === 'function') updatePoolStats(); } catch (_e3) {}
  }

  function refresh() {
    try { if (typeof loadAllPools === 'function') { loadAllPools().then(function () { render(); }); return; } } catch (_e) {}
    render();
  }

  function destroy() { _subs.forEach(function (s) { try { s.off(); } catch (_e) {} }); _subs = []; _init = false; }

  window.PoolPage = { VERSION: '15.0.0', initialize: initialize, render: render, refresh: refresh, destroy: destroy };
})();
