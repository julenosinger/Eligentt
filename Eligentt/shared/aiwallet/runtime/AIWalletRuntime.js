/**
 * AIWalletRuntime — AI Smart Wallet Runtime Orchestrator (Phase 15)
 * Coordinates: StateManager, ExecutionController, ApprovalController,
 * VaultController, WorkflowController. Delegates to existing AIWallet.
 * Attached to: window.AIWalletRuntime
 */
(function () {
  'use strict';
  var _init = false;

  function initialize() {
    if (_init) return; _init = true;
    try { if (typeof AIWallet !== 'undefined' && AIWallet.onShow) AIWallet.onShow(); } catch (_e) {}
    try {
      if (typeof EventBus !== 'undefined') {
        EventBus.on('AIWALLET_REFRESH', function () { refresh(); });
        EventBus.on('AIWALLET_EXECUTE', function (p) { if (p && p.id) execute(p.id); });
        EventBus.on('AIWALLET_APPROVAL', function (p) { if (p && p.id) approve(p.id); });
      }
    } catch (_e2) {}
  }

  function submit(raw) {
    try { if (typeof CoreMigrate !== 'undefined') return CoreMigrate.aiwallet_submit(raw); } catch (_e) {}
    try { if (typeof AIWallet !== 'undefined' && AIWallet.submitIntent) return AIWallet.submitIntent(raw); } catch (_e2) {}
    return null;
  }

  function execute(id) {
    try { if (typeof CoreMigrate !== 'undefined') return CoreMigrate.aiwallet_execute(id); } catch (_e) {}
    try { if (typeof AIWallet !== 'undefined' && AIWallet.executeIntent) { AIWallet.executeIntent(id); return true; } } catch (_e2) {}
    return false;
  }

  function approve(id) {
    try { if (typeof CoreMigrate !== 'undefined') return CoreMigrate.aiwallet_approve(id); } catch (_e) {}
    return false;
  }

  function isEmergencyStopped() {
    try { if (typeof CoreMigrate !== 'undefined') return CoreMigrate.aiwallet_isEmergencyStopped(); } catch (_e) {}
    return false;
  }

  function getMode() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.getMode) return AIWallet.getMode(); } catch (_e) {}
    return 'hybrid';
  }

  function getIntents() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.getIntents) return AIWallet.getIntents(); } catch (_e) {}
    return [];
  }

  function refresh() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.onShow) AIWallet.onShow(); } catch (_e) {}
  }

  function destroy() { _init = false; }

  window.AIWalletRuntime = {
    VERSION: '15.0.0', initialize: initialize,
    submit: submit, execute: execute, approve: approve,
    isEmergencyStopped: isEmergencyStopped, getMode: getMode,
    getIntents: getIntents, refresh: refresh, destroy: destroy
  };
})();
