/**
 * TreasuryPage — Extracted Treasury Feature Module (Phase 14.2)
 * Migrates: vault rendering, allocations, treasury actions.
 * Attached to: window.TreasuryPage
 */
(function () {
  'use strict';
  var _init = false, _subs = [];

  function initialize() {
    if (_init) return; _init = true;
    try {
      if (typeof EventBus !== 'undefined') {
        _subs.push(EventBus.on('PAGE_CHANGED', function (p) { if (p && p.page === 'treasury') render(); }));
        _subs.push(EventBus.on('BALANCE_REFRESHED', function () { render(); }));
      }
      if (typeof TabManager !== 'undefined') TabManager.register('treasury', { init: render });
    } catch (_e) {}
  }

  function render() {
    try { if (typeof TreasuryDomain !== 'undefined') TreasuryDomain.refresh(); else if (typeof vaultRefreshUI === 'function') vaultRefreshUI(); } catch (_e) {}
    try { if (typeof renderFeeRevenue === 'function') renderFeeRevenue(); } catch (_e2) {}
  }

  function deposit(amount, token) {
    try { if (typeof CoreMigrate !== 'undefined') return CoreMigrate.treasury_deposit(amount, token); } catch (_e) {}
    return false;
  }

  function getVault() {
    try { if (typeof CoreMigrate !== 'undefined') return CoreMigrate.treasury_getVault(); } catch (_e) {}
    return null;
  }

  function destroy() { _subs.forEach(function (s) { try { s.off(); } catch (_e) {} }); _subs = []; _init = false; }

  window.TreasuryPage = { VERSION: '14.0.0', initialize: initialize, render: render, deposit: deposit, getVault: getVault, destroy: destroy };
})();
