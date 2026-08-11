/**
 * XChainPage — Cross-Chain Feature Module (Phase 15)
 * Migrates: bridge UI, route selection, CCTP status, xchain rendering.
 * Attached to: window.XChainPage
 */
(function () {
  'use strict';
  var _init = false, _subs = [];

  function initialize() {
    if (_init) return; _init = true;
    try {
      if (typeof EventBus !== 'undefined') {
        _subs.push(EventBus.on('PAGE_CHANGED', function (p) { if (p && p.page === 'xchain') render(); }));
        _subs.push(EventBus.on('XCHAIN_EXECUTE', function () { execute(); }));
      }
      if (typeof TabManager !== 'undefined') TabManager.register('xchain', { init: render });
    } catch (_e) {}
  }

  function render() {
    try { if (typeof xcApplyChains === 'function') xcApplyChains(); } catch (_e) {}
    try { if (typeof xcRenderChainList === 'function') xcRenderChainList(); } catch (_e2) {}
    try { if (typeof renderXcHistory === 'function') renderXcHistory(); } catch (_e3) {}
  }

  function execute() {
    try { if (typeof CoreMigrate !== 'undefined') return CoreMigrate.bridge_execute(); } catch (_e) {}
    try { if (typeof BridgeDomain !== 'undefined') return BridgeDomain.executeBridgeOrTurbo(); } catch (_e2) {}
    return false;
  }

  function refreshBalance() {
    try { if (typeof xcRefreshOriginBalance === 'function') xcRefreshOriginBalance(); } catch (_e) {}
  }

  function destroy() { _subs.forEach(function (s) { try { s.off(); } catch (_e) {} }); _subs = []; _init = false; }

  window.XChainPage = { VERSION: '15.0.0', initialize: initialize, render: render, execute: execute, refreshBalance: refreshBalance, destroy: destroy };
})();
