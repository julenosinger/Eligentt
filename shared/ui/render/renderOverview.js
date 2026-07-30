/**
 * OverviewRenderer — AI Wallet Overview UI wrapper (Phase 2)
 * Attached to: window.OverviewRenderer
 */
(function () {
  'use strict';
  var _init = false, _subs = [];

  function initialize() {
    if (_init) return; _init = true;
    if (typeof EventBus !== 'undefined') {
      _subs.push(EventBus.on('PAGE_CHANGED', function (p) { if (p && p.page === 'aiwallet') render(); }));
      _subs.push(EventBus.on('BALANCE_REFRESHED', function () { render(); }));
    }
  }
  function render() {
    try {
      if (typeof AIWallet !== 'undefined') {
        if (AIWallet.renderPortfolioIntelligence) AIWallet.renderPortfolioIntelligence();
        if (AIWallet.refreshPortfolio) AIWallet.refreshPortfolio(false);
      }
    } catch (_e) {}
  }
  function refresh() { render(); }
  function destroy() { _subs.forEach(function (s) { try { s.off(); } catch (_e) {} }); _subs = []; _init = false; }

  window.OverviewRenderer = { VERSION: '1.0.0', initialize: initialize, render: render, refresh: refresh, destroy: destroy };
})();
