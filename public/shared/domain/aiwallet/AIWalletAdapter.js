/**
 * AIWalletAdapter — Stable public API for AI Smart Wallet (Phase 3)
 * NEVER exposes internal AIWallet.js details to the UI. Only this adapter.
 * Wraps window.AIWallet. Never duplicates logic.
 * Attached to: window.AIWalletAdapter
 */
(function () {
  'use strict';
  var _init = false;

  function initialize() { if (_init) return; _init = true; }

  function getMode() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.getMode) return AIWallet.getMode(); } catch (_e) {}
    return 'hybrid';
  }

  function setMode(mode) {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.setMode) { AIWallet.setMode(mode); return true; } } catch (_e) {}
    return false;
  }

  function isEmergencyStopped() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.isEmergencyStopped) return AIWallet.isEmergencyStopped(); } catch (_e) {}
    return false;
  }

  function submitIntent(raw) {
    try {
      if (typeof AIWallet !== 'undefined' && AIWallet.submitIntent) return AIWallet.submitIntent(raw);
    } catch (e) {
      try { if (typeof ErrorHandler !== 'undefined') ErrorHandler.handle(e, { source: 'aiwallet', operation: 'submitIntent' }); } catch (_e) {}
    }
    return null;
  }

  function executeIntent(id) {
    try {
      if (typeof AIWallet !== 'undefined' && AIWallet.executeIntent) { AIWallet.executeIntent(id); return true; }
    } catch (e) {}
    return false;
  }

  function cancelIntent(id) {
    try {
      if (typeof AIWallet !== 'undefined' && AIWallet.cancelIntent) { AIWallet.cancelIntent(id); return true; }
    } catch (_e) {}
    return false;
  }

  function validateIntent(intent) {
    try {
      if (typeof AIWallet !== 'undefined' && AIWallet.validateIntent) return AIWallet.validateIntent(intent);
    } catch (_e) {}
    return { valid: false, checks: [] };
  }

  function receiveAutonomaIntent(intent) {
    try {
      if (typeof AIWallet !== 'undefined' && AIWallet.receiveAutonomaIntent) return AIWallet.receiveAutonomaIntent(intent);
    } catch (_e) {}
    return null;
  }

  function getIntents() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.getIntents) return AIWallet.getIntents(); } catch (_e) {}
    return [];
  }

  function getHistory() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.getHistory) return AIWallet.getHistory(); } catch (_e) {}
    return [];
  }

  function getRecommendations() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.getRecommendations) return AIWallet.getRecommendations(); } catch (_e) {}
    return [];
  }

  function runSimulation() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.runSimulation) { AIWallet.runSimulation(); return true; } } catch (_e) {}
    return false;
  }

  function generateReport(type) {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.generateReport) { AIWallet.generateReport(type); return true; } } catch (_e) {}
    return false;
  }

  function showTab(tab) {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.showTab) AIWallet.showTab(tab); } catch (_e) {}
  }

  function getSpendingCapacity() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet._getSpendingCapacity) return AIWallet._getSpendingCapacity(); } catch (_e) {}
    return null;
  }

  function refreshAll() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.onShow) AIWallet.onShow(); } catch (_e) {}
  }

  function refresh() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.renderAll) AIWallet.renderAll(); } catch (_e) {}
  }

  function destroy() { _init = false; }

  window.AIWalletAdapter = {
    VERSION: '1.0.0',
    initialize: initialize, getMode: getMode, setMode: setMode, isEmergencyStopped: isEmergencyStopped,
    submitIntent: submitIntent, executeIntent: executeIntent, cancelIntent: cancelIntent,
    validateIntent: validateIntent, receiveAutonomaIntent: receiveAutonomaIntent,
    getIntents: getIntents, getHistory: getHistory, getRecommendations: getRecommendations,
    runSimulation: runSimulation, generateReport: generateReport, showTab: showTab,
    getSpendingCapacity: getSpendingCapacity, refreshAll: refreshAll, refresh: refresh, destroy: destroy
  };
})();
