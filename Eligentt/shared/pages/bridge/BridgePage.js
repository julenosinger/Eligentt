/**
 * BridgePage — Extracted Bridge Feature Module (Phase 14.3)
 * Migrates: executeBridgeOrTurbo, estimation, status UI.
 * Attached to: window.BridgePage
 */
(function () {
  'use strict';
  var _init = false, _subs = [];

  function initialize() {
    if (_init) return; _init = true;
    try {
      if (typeof EventBus !== 'undefined') {
        _subs.push(EventBus.on('PAGE_CHANGED', function (p) { if (p && p.page === 'bridge') render(); }));
        _subs.push(EventBus.on('BALANCE_REFRESHED', function () { render(); }));
        _subs.push(EventBus.on('CHAIN_CHANGED', function () { render(); }));
      }
      if (typeof TabManager !== 'undefined') TabManager.register('bridge', { init: render });
    } catch (_e) {}
  }

  function render() {
    try { if (typeof CoreMigrate !== 'undefined') CoreMigrate.bridge_refresh(); else if (typeof updateBridgeEst === 'function') updateBridgeEst(); } catch (_e) {}
    try { if (typeof refreshBridgeBalances === 'function') refreshBridgeBalances(); } catch (_e2) {}
    try { if (typeof renderXcHistory === 'function') renderXcHistory(); } catch (_e3) {}
  }

  function execute() {
    try { if (typeof CoreMigrate !== 'undefined') return CoreMigrate.bridge_execute(); } catch (_e) {}
    try { if (typeof BridgeDomain !== 'undefined') return BridgeDomain.executeBridgeOrTurbo(); } catch (_e2) {}
    try { if (typeof executeBridgeOrTurbo === 'function') { executeBridgeOrTurbo(); return true; } } catch (_e3) {}
    return false;
  }

  function turbo() {
    try { if (typeof CoreMigrate !== 'undefined') return CoreMigrate.bridge_turbo(); } catch (_e) {}
    return false;
  }

  function destroy() { _subs.forEach(function (s) { try { s.off(); } catch (_e) {} }); _subs = []; _init = false; }

  window.BridgePage = { VERSION: '14.0.0', initialize: initialize, render: render, execute: execute, turbo: turbo, destroy: destroy };
})();
