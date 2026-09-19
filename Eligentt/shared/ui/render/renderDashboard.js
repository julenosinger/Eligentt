/**
 * DashboardRenderer — Dashboard overview UI wrapper (Phase 2)
 * This wraps the overview/portfolio rendering from AI Wallet + general dashboard.
 * Attached to: window.DashboardRenderer
 */
(function () {
  'use strict';
  var _init = false, _subs = [];

  function initialize() {
    if (_init) return; _init = true;
    if (typeof EventBus !== 'undefined') {
      _subs.push(EventBus.on('BALANCE_REFRESHED', function () { render(); }));
      _subs.push(EventBus.on('WALLET_CONNECTED', function () { render(); }));
    }
  }
  function render() {
    try {
      if (typeof AIWallet !== 'undefined' && AIWallet.onShow) {
        var pg = document.getElementById('page-aiwallet');
        if (pg && pg.classList.contains('active')) AIWallet.onShow();
      }
    } catch (_e) {}
    try { if (typeof updateSwapRate === 'function') updateSwapRate(); } catch (_e2) {}
    try { if (typeof updateBridgeEst === 'function') updateBridgeEst(); } catch (_e3) {}
  }
  function refresh() { render(); }
  function destroy() { _subs.forEach(function (s) { try { s.off(); } catch (_e) {} }); _subs = []; _init = false; }

  window.DashboardRenderer = { VERSION: '1.0.0', initialize: initialize, render: render, refresh: refresh, destroy: destroy };
})();
