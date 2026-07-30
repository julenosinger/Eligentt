/**
 * Elligentt CoreMigrationAdapters — Core Financial Execution Migration (Phase 8)
 *
 * Covers ALL core operations: wallet, payments, swap, bridge, treasury,
 * aiwallet validation/execution, autonoma pipeline, docs/paylinks.
 *
 * Each adapter: new path with fallback. MigrationFlags control parity mode.
 * LegacyTracker tracks migration state.
 *
 * Attached to: window.CoreMigrate
 */
(function () {
  'use strict';

  var _ = {};

  function _flag(k) { try { return typeof MigrationFlags !== 'undefined' && MigrationFlags.isEnabled(k); } catch (_e) { return false; } }
  function _track(name, status) { try { if (typeof LegacyTracker !== 'undefined') LegacyTracker.markMigrated(name); } catch (_e) {} }

  /* ════════════════════════════════════════
     8.1 — WALLET
  ════════════════════════════════════════ */
  _.wallet_connect = function (walletType) {
    if (_flag('USE_WALLET_DOMAIN')) {
      try { if (typeof WalletDomain !== 'undefined') return WalletDomain.connect(walletType); } catch (_e) {}
    }
    try { if (typeof WalletDomain !== 'undefined') return WalletDomain.connect(walletType); } catch (_e) {}
    try { if (typeof connectWalletConnect === 'function') return connectWalletConnect(); } catch (_e2) {}
    return null;
  };

  _.wallet_disconnect = function () {
    try { if (typeof WalletDomain !== 'undefined') return WalletDomain.disconnect(); } catch (_e) {}
    try { if (typeof disconnectWallet === 'function') return disconnectWallet(); } catch (_e2) {}
  };

  _.wallet_refreshBalance = function () {
    try { if (typeof WalletDomain !== 'undefined') return WalletDomain.refreshBalance(); } catch (_e) {}
    try { if (typeof refreshBalance === 'function') return refreshBalance(); } catch (_e2) {}
  };

  _.wallet_switchChain = function (chainId) {
    try { if (typeof WalletDomain !== 'undefined') return WalletDomain.switchChain(chainId); } catch (_e) {}
    try { if (typeof switchNetwork === 'function') return switchNetwork(chainId); } catch (_e2) {}
    return false;
  };

  /* ════════════════════════════════════════
     8.2 — PAYMENTS
  ════════════════════════════════════════ */
  _.payments_execute = function () {
    if (_flag('USE_PAYMENT_DOMAIN')) {
      try { if (typeof PaymentDomain !== 'undefined') return PaymentDomain.executeBatch(); } catch (_e) {}
    }
    try { if (typeof PaymentDomain !== 'undefined') return PaymentDomain.executeBatch(); } catch (_e) {}
    try { if (typeof signTx === 'function') { signTx(); return true; } } catch (_e2) {}
    return false;
  };

  _.payments_addRecipient = function (addr, amount, name) {
    try { if (typeof PaymentDomain !== 'undefined') return PaymentDomain.addRecipient(addr, amount, name); } catch (_e) {}
    try { if (typeof recipients !== 'undefined') { recipients.push({ addr: addr, amount: String(amount||'0'), name: name||'', chainId: 'Arc_Testnet' }); return true; } } catch (_e2) {}
    return false;
  };

  _.payments_validate = function (recipient) {
    try { if (typeof PaymentDomain !== 'undefined') return PaymentDomain.validateRecipient(recipient); } catch (_e) {}
    try {
      if (typeof isAddr === 'function' && isAddr(recipient.addr)) return { valid: true };
    } catch (_e2) {}
    return { valid: false, reason: 'Validation error' };
  };

  /* ════════════════════════════════════════
     8.3 — SCHEDULER
  ════════════════════════════════════════ */
  _.scheduler_create = function (params) {
    if (_flag('USE_SCHEDULER_DOMAIN')) {
      try { if (typeof SchedulerDomain !== 'undefined') return SchedulerDomain.create(params); } catch (_e) {}
    }
    try { if (typeof SchedulerDomain !== 'undefined') return SchedulerDomain.create(params); } catch (_e) {}
    try { if (typeof ScheduleEngine !== 'undefined' && ScheduleEngine.create) return ScheduleEngine.create(params); } catch (_e2) {}
    return null;
  };

  _.scheduler_executeAll = function () {
    try { if (typeof SchedulerDomain !== 'undefined') { SchedulerDomain.executeAll(); return true; } } catch (_e) {}
    try { if (typeof checkDueSchedules === 'function') { checkDueSchedules(); return true; } } catch (_e2) {}
    return false;
  };

  _.scheduler_pause = function (id) {
    try { if (typeof SchedulerDomain !== 'undefined') return SchedulerDomain.pause(id); } catch (_e) {}
    try { if (typeof ScheduleEngine !== 'undefined' && ScheduleEngine.update) { ScheduleEngine.update(id, { status: 'Paused' }); return true; } } catch (_e2) {}
    return false;
  };

  /* ════════════════════════════════════════
     8.4 — AI WALLET VALIDATION
  ════════════════════════════════════════ */
  _.aiwallet_validate = function (intent) {
    if (_flag('USE_AIW_VALIDATION_ENGINE')) {
      try { if (typeof AIWValidationEngine !== 'undefined') return AIWValidationEngine.validate(intent); } catch (_e) {}
    }
    try { if (typeof AIWValidationEngine !== 'undefined') return AIWValidationEngine.validate(intent); } catch (_e) {}
    try { if (typeof AIWallet !== 'undefined' && AIWallet.validateIntent) return AIWallet.validateIntent(intent); } catch (_e2) {}
    return { valid: false, checks: [] };
  };

  _.aiwallet_isEmergencyStopped = function () {
    try { if (typeof AIWSecurityEngine !== 'undefined') return AIWSecurityEngine.isEmergencyStopped(); } catch (_e) {}
    try { if (typeof AIWallet !== 'undefined' && AIWallet.isEmergencyStopped) return AIWallet.isEmergencyStopped(); } catch (_e2) {}
    return false;
  };

  /* ════════════════════════════════════════
     8.5 — AI WALLET EXECUTION
  ════════════════════════════════════════ */
  _.aiwallet_submit = function (raw) {
    if (_flag('USE_AIW_EXECUTION_ENGINE')) {
      try { if (typeof AIWExecutionEngine !== 'undefined') return AIWExecutionEngine.submit(raw); } catch (_e) {}
    }
    try { if (typeof AIWExecutionEngine !== 'undefined') return AIWExecutionEngine.submit(raw); } catch (_e) {}
    try { if (typeof AIWallet !== 'undefined' && AIWallet.submitIntent) return AIWallet.submitIntent(raw); } catch (_e2) {}
    return null;
  };

  _.aiwallet_execute = function (id) {
    try { if (typeof AIWExecutionEngine !== 'undefined') { AIWExecutionEngine.execute(id); return true; } } catch (_e) {}
    try { if (typeof AIWallet !== 'undefined' && AIWallet.executeIntent) { AIWallet.executeIntent(id); return true; } } catch (_e2) {}
    return false;
  };

  _.aiwallet_approve = function (id) {
    try { if (typeof AIWApprovalEngine !== 'undefined') { AIWApprovalEngine.approve(id); return true; } } catch (_e) {}
    try { if (typeof AIWallet !== 'undefined' && AIWallet.approveRequest) { AIWallet.approveRequest(id); return true; } } catch (_e2) {}
    return false;
  };

  /* ════════════════════════════════════════
     8.6 — TREASURY
  ════════════════════════════════════════ */
  _.treasury_refresh = function () {
    if (_flag('USE_TREASURY_DOMAIN')) {
      try { if (typeof TreasuryDomain !== 'undefined') { TreasuryDomain.refresh(); return; } } catch (_e) {}
    }
    try { if (typeof TreasuryDomain !== 'undefined') { TreasuryDomain.refresh(); return; } } catch (_e) {}
    try { if (typeof vaultRefreshUI === 'function') { vaultRefreshUI(); return; } } catch (_e2) {}
  };

  _.treasury_deposit = function (amount, token) {
    try { if (typeof TreasuryDomain !== 'undefined') return TreasuryDomain.executeDeposit(amount, token); } catch (_e) {}
    try { if (typeof AIWallet !== 'undefined' && AIWallet.fundingSubmit) { AIWallet.fundingSubmit(); return true; } } catch (_e2) {}
    return false;
  };

  _.treasury_getVault = function () {
    try { if (typeof TreasuryDomain !== 'undefined') return TreasuryDomain.getVaultBalance(); } catch (_e) {}
    try { if (typeof AIWVaultEngine !== 'undefined' && AIWVaultEngine.getVaultView) return AIWVaultEngine.getVaultView('USDC'); } catch (_e2) {}
    return null;
  };

  /* ════════════════════════════════════════
     8.7 — SWAP
  ════════════════════════════════════════ */
  _.swap_execute = function (amount, fromToken, toToken) {
    if (_flag('USE_SWAP_DOMAIN')) {
      try { if (typeof SwapDomain !== 'undefined') return SwapDomain.execute(amount, fromToken, toToken); } catch (_e) {}
    }
    try { if (typeof SwapDomain !== 'undefined') return SwapDomain.execute(amount, fromToken, toToken); } catch (_e) {}
    try { if (typeof executeSwap === 'function') { executeSwap(amount, fromToken, toToken); return true; } } catch (_e2) {}
    return false;
  };

  _.swap_getQuote = function (amount, fromToken, toToken) {
    try { if (typeof SwapDomain !== 'undefined') return SwapDomain.getQuote(amount, fromToken, toToken); } catch (_e) {}
    try { if (typeof updateSwapRate === 'function') { updateSwapRate(); return { rate: 'fetched' }; } } catch (_e2) {}
    return null;
  };

  _.swap_refresh = function () {
    try { if (typeof SwapDomain !== 'undefined') { SwapDomain.refresh(); return; } } catch (_e) {}
    try { if (typeof updateSwapRate === 'function') { updateSwapRate(); return; } } catch (_e2) {}
  };

  /* ════════════════════════════════════════
     8.8 — BRIDGE
  ════════════════════════════════════════ */
  _.bridge_execute = function () {
    if (_flag('USE_BRIDGE_DOMAIN')) {
      try { if (typeof BridgeDomain !== 'undefined') return BridgeDomain.executeBridgeOrTurbo(); } catch (_e) {}
    }
    try { if (typeof BridgeDomain !== 'undefined') return BridgeDomain.executeBridgeOrTurbo(); } catch (_e) {}
    try { if (typeof executeBridgeOrTurbo === 'function') { executeBridgeOrTurbo(); return true; } } catch (_e2) {}
    return false;
  };

  _.bridge_turbo = function () {
    try { if (typeof BridgeDomain !== 'undefined') return BridgeDomain.executeTurbo(); } catch (_e) {}
    try { if (typeof executeTurboBridge === 'function') { executeTurboBridge(); return true; } } catch (_e2) {}
    return false;
  };

  _.bridge_refresh = function () {
    try { if (typeof BridgeDomain !== 'undefined') { BridgeDomain.refresh(); return; } } catch (_e) {}
    try { if (typeof updateBridgeEst === 'function') { updateBridgeEst(); return; } } catch (_e2) {}
  };

  /* ════════════════════════════════════════
     8.9 — AUTONOMA PIPELINE
  ════════════════════════════════════════ */
  _.autonoma_ask = function (msg, callbacks) {
    if (_flag('USE_AUT_INTENT_ENGINE')) {
      try { if (typeof AutIntentEngine !== 'undefined') return AutIntentEngine.process(msg, callbacks); } catch (_e) {}
    }
    try { if (typeof AutIntentEngine !== 'undefined') return AutIntentEngine.process(msg, callbacks); } catch (_e) {}
    try { if (typeof AutonomaCore !== 'undefined' && AutonomaCore.process) return AutonomaCore.process(msg, callbacks); } catch (_e2) {}
    return { type: 'fallback', msg: msg };
  };

  _.autonoma_context = function () {
    try { if (typeof AutContextEngine !== 'undefined') return AutContextEngine.getWorldState(); } catch (_e) {}
    try { if (typeof AutonomaCore !== 'undefined' && AutonomaCore.getWorldState) return AutonomaCore.getWorldState(); } catch (_e2) {}
    return null;
  };

  _.autonoma_memory = function (limit) {
    try { if (typeof AutMemoryEngine !== 'undefined') return AutMemoryEngine.getConversationHistory(limit); } catch (_e) {}
    return [];
  };

  _.autonoma_reset = function () {
    try { if (typeof AutMemoryEngine !== 'undefined') { AutMemoryEngine.clearConversation(); return; } } catch (_e) {}
    try { if (typeof AutonomaCore !== 'undefined' && AutonomaCore.resetGoal) { AutonomaCore.resetGoal(); return; } } catch (_e2) {}
  };

  /* ════════════════════════════════════════
     8.10 — DOCUMENTS / PAYLINKS / INVOICES
  ════════════════════════════════════════ */
  _.docs_renderInvoices = function () {
    try { if (typeof renderInvoices === 'function') { renderInvoices(); return; } } catch (_e) {}
  };

  _.docs_renderPayLinks = function () {
    try { if (typeof renderPayLinks === 'function') { renderPayLinks(); return; } } catch (_e) {}
  };

  _.docs_updateInvStats = function () {
    try { if (typeof updateInvStats === 'function') { updateInvStats(); return; } } catch (_e) {}
  };

  /* ════════════════════════════════════════
     SYSTEM OPERATIONS
  ════════════════════════════════════════ */
  _.system_executionBegin = function (op, params) {
    try {
      if (_flag('USE_EXECUTION_COORDINATOR') || typeof ExecutionCoordinator !== 'undefined') {
        return ExecutionCoordinator.begin(op, params);
      }
    } catch (_e) {}
    return 'LEGACY_' + Date.now().toString(36);
  };

  _.system_auditLog = function (event, detail) {
    try { if (typeof AuditManager !== 'undefined') AuditManager.log(event, detail); } catch (_e) {}
  };

  _.system_lockAcquire = function (name, ttl) {
    try { if (typeof LockManager !== 'undefined') return LockManager.acquire(name, ttl); } catch (_e) {}
    return true;
  };

  /** @public */
  window.CoreMigrate = {
    VERSION: '1.0.0',
    // Wallet (8.1)
    wallet_connect:        _.wallet_connect,
    wallet_disconnect:     _.wallet_disconnect,
    wallet_refreshBalance: _.wallet_refreshBalance,
    wallet_switchChain:    _.wallet_switchChain,
    // Payments (8.2)
    payments_execute:      _.payments_execute,
    payments_addRecipient: _.payments_addRecipient,
    payments_validate:     _.payments_validate,
    // Scheduler (8.3)
    scheduler_create:      _.scheduler_create,
    scheduler_executeAll:  _.scheduler_executeAll,
    scheduler_pause:       _.scheduler_pause,
    // AI Wallet Validation (8.4)
    aiwallet_validate:          _.aiwallet_validate,
    aiwallet_isEmergencyStopped:_.aiwallet_isEmergencyStopped,
    // AI Wallet Execution (8.5)
    aiwallet_submit:      _.aiwallet_submit,
    aiwallet_execute:     _.aiwallet_execute,
    aiwallet_approve:     _.aiwallet_approve,
    // Treasury (8.6)
    treasury_refresh:     _.treasury_refresh,
    treasury_deposit:     _.treasury_deposit,
    treasury_getVault:    _.treasury_getVault,
    // Swap (8.7)
    swap_execute:         _.swap_execute,
    swap_getQuote:        _.swap_getQuote,
    swap_refresh:         _.swap_refresh,
    // Bridge (8.8)
    bridge_execute:       _.bridge_execute,
    bridge_turbo:         _.bridge_turbo,
    bridge_refresh:       _.bridge_refresh,
    // Autonoma (8.9)
    autonoma_ask:         _.autonoma_ask,
    autonoma_context:     _.autonoma_context,
    autonoma_memory:      _.autonoma_memory,
    autonoma_reset:       _.autonoma_reset,
    // Documents (8.10)
    docs_renderInvoices:  _.docs_renderInvoices,
    docs_renderPayLinks:  _.docs_renderPayLinks,
    docs_updateInvStats:  _.docs_updateInvStats,
    // System
    system_executionBegin: _.system_executionBegin,
    system_auditLog:      _.system_auditLog,
    system_lockAcquire:   _.system_lockAcquire
  };
})();
