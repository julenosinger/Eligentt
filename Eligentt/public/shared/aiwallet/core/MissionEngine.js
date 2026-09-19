/**
 * AIWallet MissionEngine — Mission Control Wrapper (Phase 4)
 * Attached to: window.AIWMissionEngine
 */
(function () {
  'use strict';
  var _init = false;

  function initialize() { if (_init) return; _init = true; }

  function render() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.renderAll) AIWallet.renderAll(); } catch (_e) {}
    try { if (typeof AIWallet !== 'undefined' && AIWallet.renderPortfolioIntelligence) AIWallet.renderPortfolioIntelligence(); } catch (_e2) {}
  }

  function refreshPortfolio(force) {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.refreshPortfolio) AIWallet.refreshPortfolio(force); } catch (_e) {}
  }

  function getPortfolioData() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet._portfolioData) return AIWallet._portfolioData(); } catch (_e) {}
    return { totalUsd: 0, wallets: [] };
  }

  function getSpendingCapacity() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet._getSpendingCapacity) return AIWallet._getSpendingCapacity(); } catch (_e) {}
    return null;
  }

  function refresh() { render(); }
  function destroy() { _init = false; }

  window.AIWMissionEngine = {
    VERSION: '1.0.0',
    initialize: initialize, render: render, refreshPortfolio: refreshPortfolio,
    getPortfolioData: getPortfolioData, getSpendingCapacity: getSpendingCapacity,
    refresh: refresh, destroy: destroy
  };
})();
