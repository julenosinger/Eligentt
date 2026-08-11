/**
 * TreasuryRenderer — Treasury/Vault UI wrapper (Phase 2)
 * Attached to: window.TreasuryRenderer
 */
(function () {
  'use strict';
  var _init = false, _subs = [];

  function initialize() {
    if (_init) return; _init = true;
    if (typeof EventBus !== 'undefined') {
      _subs.push(EventBus.on('PAGE_CHANGED', function (p) { if (p && p.page === 'treasury') render(); }));
      _subs.push(EventBus.on('BALANCE_REFRESHED', function () { render(); }));
    }
  }
  function render() {
    try { if (typeof vaultRefreshUI === 'function') vaultRefreshUI(); } catch (_e) {}
    try { if (typeof renderFeeRevenue === 'function') renderFeeRevenue(); } catch (_e2) {}
  }
  function refresh() { render(); }
  function destroy() { _subs.forEach(function (s) { try { s.off(); } catch (_e) {} }); _subs = []; _init = false; }

  window.TreasuryRenderer = { VERSION: '1.0.0', initialize: initialize, render: render, refresh: refresh, destroy: destroy };
})();
