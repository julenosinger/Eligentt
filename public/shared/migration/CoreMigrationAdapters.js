/**
 * Elligentt CoreMigrationAdapters — Pure Modular Routing (Phase 19)
 *
 * ALL legacy fallbacks removed. Every adapter routes through modular
 * Domain/Page path ONLY. If modular path fails, PureExecutionGuard
 * reports the failure and execution is blocked.
 *
 * No silent compatibility routing. No deprecated execution paths.
 *
 * CoreMigrate → Modular Path (ONLY)
 *               |
 *               v
 *            Domain Service
 *               |
 *               v
 *            PureExecutionGuard (catches any legacy bypass)
 *
 * Attached to: window.CoreMigrate
 *
 * @module CoreMigrationAdapters
 * @version 19.0.0
 */
(function () {
  'use strict';

  var _ = {};

  /* ════════════════════════════════════════
     8.1 — WALLET (pure)
  ════════════════════════════════════════ */

  _.wallet_connect = function (walletType) {
    try {
      if (typeof WalletDomain !== 'undefined') return WalletDomain.connect(walletType);
    } catch (_e) {
      _reportFailure('wallet_connect', 'WalletDomain.connect', _e);
    }
    try {
      if (typeof WalletPage !== 'undefined') return WalletPage.connect();
    } catch (_e2) {
      _reportFailure('wallet_connect', 'WalletPage.connect', _e2);
    }
    return _blocked('wallet_connect', 'WalletDomain / WalletPage');
  };

  _.wallet_disconnect = function () {
    try {
      if (typeof WalletDomain !== 'undefined') return WalletDomain.disconnect();
    } catch (_e) {
      _reportFailure('wallet_disconnect', 'WalletDomain.disconnect', _e);
    }
    return _blocked('wallet_disconnect', 'WalletDomain');
  };

  _.wallet_refreshBalance = function () {
    try {
      if (typeof WalletDomain !== 'undefined') return WalletDomain.refreshBalance();
    } catch (_e) {
      _reportFailure('wallet_refreshBalance', 'WalletDomain.refreshBalance', _e);
    }
    try {
      if (typeof WalletPage !== 'undefined' && WalletPage.refreshBalance) return WalletPage.refreshBalance();
    } catch (_e2) {}
    return _blocked('wallet_refreshBalance', 'WalletDomain / WalletPage');
  };

  _.wallet_switchChain = function (chainId) {
    try {
      if (typeof WalletDomain !== 'undefined') return WalletDomain.switchChain(chainId);
    } catch (_e) {
      _reportFailure('wallet_switchChain', 'WalletDomain.switchChain', _e);
    }
    return _blocked('wallet_switchChain', 'WalletDomain');
  };

  /* ════════════════════════════════════════
     8.2 — PAYMENTS (pure)
  ════════════════════════════════════════ */

  _.payments_execute = function () {
    try {
      if (typeof PaymentDomain !== 'undefined') return PaymentDomain.executeBatch();
    } catch (_e) {
      _reportFailure('payments_execute', 'PaymentDomain.executeBatch', _e);
    }
    try {
      if (typeof PaymentsPage !== 'undefined' && PaymentsPage.execute) return PaymentsPage.execute();
    } catch (_e2) {}
    return _blocked('payments_execute', 'PaymentDomain / PaymentsPage');
  };

  _.payments_addRecipient = function (addr, amount, name) {
    try {
      if (typeof PaymentDomain !== 'undefined') return PaymentDomain.addRecipient(addr, amount, name);
    } catch (_e) {
      _reportFailure('payments_addRecipient', 'PaymentDomain.addRecipient', _e);
    }
    return _blocked('payments_addRecipient', 'PaymentDomain');
  };

  _.payments_validate = function (recipient) {
    try {
      if (typeof PaymentDomain !== 'undefined') return PaymentDomain.validateRecipient(recipient);
    } catch (_e) {
      _reportFailure('payments_validate', 'PaymentDomain.validateRecipient', _e);
    }
    return { valid: false, reason: 'Validation blocked — PaymentDomain unavailable' };
  };

  /* ════════════════════════════════════════
     8.3 — SCHEDULER (pure)
  ════════════════════════════════════════ */

  _.scheduler_create = function (params) {
    try {
      if (typeof SchedulerDomain !== 'undefined') return SchedulerDomain.create(params);
    } catch (_e) {
      _reportFailure('scheduler_create', 'SchedulerDomain.create', _e);
    }
    return _blocked('scheduler_create', 'SchedulerDomain');
  };

  _.scheduler_executeAll = function () {
    try {
      if (typeof SchedulerDomain !== 'undefined') { SchedulerDomain.executeAll(); return true; }
    } catch (_e) {
      _reportFailure('scheduler_executeAll', 'SchedulerDomain.executeAll', _e);
    }
    try {
      if (typeof SchedulerPage !== 'undefined' && SchedulerPage.executeAll) { SchedulerPage.executeAll(); return true; }
    } catch (_e2) {}
    return _blocked('scheduler_executeAll', 'SchedulerDomain / SchedulerPage');
  };

  _.scheduler_pause = function (id) {
    try {
      if (typeof SchedulerDomain !== 'undefined') return SchedulerDomain.pause(id);
    } catch (_e) {
      _reportFailure('scheduler_pause', 'SchedulerDomain.pause', _e);
    }
    return _blocked('scheduler_pause', 'SchedulerDomain');
  };

  /* ════════════════════════════════════════
     8.4 — AI WALLET VALIDATION (pure)
  ════════════════════════════════════════ */

  _.aiwallet_validate = function (intent) {
    try {
      if (typeof AIWValidationEngine !== 'undefined') return AIWValidationEngine.validate(intent);
    } catch (_e) {
      _reportFailure('aiwallet_validate', 'AIWValidationEngine.validate', _e);
    }
    return { valid: false, checks: [], reason: 'AIWValidationEngine unavailable in PURE_MODULAR' };
  };

  _.aiwallet_isEmergencyStopped = function () {
    try {
      if (typeof AIWSecurityEngine !== 'undefined') return AIWSecurityEngine.isEmergencyStopped();
    } catch (_e) {}
    return false;
  };

  /* ════════════════════════════════════════
     8.5 — AI WALLET EXECUTION (pure)
  ════════════════════════════════════════ */

  _.aiwallet_submit = function (raw) {
    try {
      if (typeof AIWExecutionEngine !== 'undefined') return AIWExecutionEngine.submit(raw);
    } catch (_e) {
      _reportFailure('aiwallet_submit', 'AIWExecutionEngine.submit', _e);
    }
    return _blocked('aiwallet_submit', 'AIWExecutionEngine');
  };

  _.aiwallet_execute = function (id) {
    try {
      if (typeof AIWExecutionEngine !== 'undefined') { AIWExecutionEngine.execute(id); return true; }
    } catch (_e) {
      _reportFailure('aiwallet_execute', 'AIWExecutionEngine.execute', _e);
    }
    return _blocked('aiwallet_execute', 'AIWExecutionEngine');
  };

  _.aiwallet_approve = function (id) {
    try {
      if (typeof AIWApprovalEngine !== 'undefined') { AIWApprovalEngine.approve(id); return true; }
    } catch (_e) {
      _reportFailure('aiwallet_approve', 'AIWApprovalEngine.approve', _e);
    }
    return _blocked('aiwallet_approve', 'AIWApprovalEngine');
  };

  /* ════════════════════════════════════════
     8.6 — TREASURY (pure)
  ════════════════════════════════════════ */

  _.treasury_refresh = function () {
    try {
      if (typeof TreasuryDomain !== 'undefined') { TreasuryDomain.refresh(); return; }
    } catch (_e) {
      _reportFailure('treasury_refresh', 'TreasuryDomain.refresh', _e);
    }
    try {
      if (typeof TreasuryPage !== 'undefined' && TreasuryPage.render) { TreasuryPage.render(); return; }
    } catch (_e2) {}
    _blocked('treasury_refresh', 'TreasuryDomain / TreasuryPage');
  };

  _.treasury_deposit = function (amount, token) {
    try {
      if (typeof TreasuryDomain !== 'undefined') return TreasuryDomain.executeDeposit(amount, token);
    } catch (_e) {
      _reportFailure('treasury_deposit', 'TreasuryDomain.executeDeposit', _e);
    }
    return _blocked('treasury_deposit', 'TreasuryDomain');
  };

  _.treasury_getVault = function () {
    try {
      if (typeof TreasuryDomain !== 'undefined') return TreasuryDomain.getVaultBalance();
    } catch (_e) {
      _reportFailure('treasury_getVault', 'TreasuryDomain.getVaultBalance', _e);
    }
    return _blocked('treasury_getVault', 'TreasuryDomain');
  };

  /* ════════════════════════════════════════
     8.7 — SWAP (pure)
  ════════════════════════════════════════ */

  _.swap_execute = function (amount, fromToken, toToken) {
    try {
      if (typeof SwapDomain !== 'undefined') return SwapDomain.execute(amount, fromToken, toToken);
    } catch (_e) {
      _reportFailure('swap_execute', 'SwapDomain.execute', _e);
    }
    try {
      if (typeof SwapPage !== 'undefined' && SwapPage.execute) return SwapPage.execute(amount, fromToken, toToken);
    } catch (_e2) {}
    return _blocked('swap_execute', 'SwapDomain / SwapPage');
  };

  _.swap_getQuote = function (amount, fromToken, toToken) {
    try {
      if (typeof SwapDomain !== 'undefined') return SwapDomain.getQuote(amount, fromToken, toToken);
    } catch (_e) {
      _reportFailure('swap_getQuote', 'SwapDomain.getQuote', _e);
    }
    return _blocked('swap_getQuote', 'SwapDomain');
  };

  _.swap_refresh = function () {
    try {
      if (typeof SwapDomain !== 'undefined') { SwapDomain.refresh(); return; }
    } catch (_e) {
      _reportFailure('swap_refresh', 'SwapDomain.refresh', _e);
    }
    try {
      if (typeof SwapPage !== 'undefined' && SwapPage.refresh) { SwapPage.refresh(); return; }
    } catch (_e2) {}
    _blocked('swap_refresh', 'SwapDomain / SwapPage');
  };

  /* ════════════════════════════════════════
     8.8 — BRIDGE (pure)
  ════════════════════════════════════════ */

  _.bridge_execute = function () {
    try {
      if (typeof BridgeDomain !== 'undefined') return BridgeDomain.executeBridgeOrTurbo();
    } catch (_e) {
      _reportFailure('bridge_execute', 'BridgeDomain.executeBridgeOrTurbo', _e);
    }
    try {
      if (typeof BridgePage !== 'undefined' && BridgePage.execute) return BridgePage.execute();
    } catch (_e2) {}
    return _blocked('bridge_execute', 'BridgeDomain / BridgePage');
  };

  _.bridge_turbo = function () {
    try {
      if (typeof BridgeDomain !== 'undefined') return BridgeDomain.executeTurbo();
    } catch (_e) {
      _reportFailure('bridge_turbo', 'BridgeDomain.executeTurbo', _e);
    }
    try {
      if (typeof BridgePage !== 'undefined' && BridgePage.turbo) return BridgePage.turbo();
    } catch (_e2) {}
    return _blocked('bridge_turbo', 'BridgeDomain / BridgePage');
  };

  _.bridge_refresh = function () {
    try {
      if (typeof BridgeDomain !== 'undefined') { BridgeDomain.refresh(); return; }
    } catch (_e) {
      _reportFailure('bridge_refresh', 'BridgeDomain.refresh', _e);
    }
    try {
      if (typeof BridgePage !== 'undefined' && BridgePage.refresh) { BridgePage.refresh(); return; }
    } catch (_e2) {}
    _blocked('bridge_refresh', 'BridgeDomain / BridgePage');
  };

  /* ════════════════════════════════════════
     8.9 — AUTONOMA PIPELINE (pure)
  ════════════════════════════════════════ */

  _.autonoma_ask = function (msg, callbacks) {
    try {
      if (typeof AutIntentEngine !== 'undefined') return AutIntentEngine.process(msg, callbacks);
    } catch (_e) {
      _reportFailure('autonoma_ask', 'AutIntentEngine.process', _e);
    }
    try {
      if (typeof AutonomaPage !== 'undefined' && AutonomaPage.process) return AutonomaPage.process(msg, callbacks);
    } catch (_e2) {}
    return _blocked('autonoma_ask', 'AutIntentEngine / AutonomaPage');
  };

  _.autonoma_context = function () {
    try {
      if (typeof AutContextEngine !== 'undefined') return AutContextEngine.getWorldState();
    } catch (_e) {
      _reportFailure('autonoma_context', 'AutContextEngine.getWorldState', _e);
    }
    return _blocked('autonoma_context', 'AutContextEngine');
  };

  _.autonoma_memory = function (limit) {
    try {
      if (typeof AutMemoryEngine !== 'undefined') return AutMemoryEngine.getConversationHistory(limit);
    } catch (_e) {
      _reportFailure('autonoma_memory', 'AutMemoryEngine.getConversationHistory', _e);
    }
    return [];
  };

  _.autonoma_reset = function () {
    try {
      if (typeof AutMemoryEngine !== 'undefined') { AutMemoryEngine.clearConversation(); return; }
    } catch (_e) {}
  };

  /* ════════════════════════════════════════
     8.10 — DOCUMENTS / PAYLINKS / INVOICES
  ════════════════════════════════════════ */

  _.docs_renderInvoices = function () {
    try {
      if (typeof InvoicesPage !== 'undefined' && InvoicesPage.render) { InvoicesPage.render(); return; }
    } catch (_e) {}
    _blocked('docs_renderInvoices', 'InvoicesPage');
  };

  _.docs_renderPayLinks = function () {
    try {
      if (typeof PayLinksPage !== 'undefined' && PayLinksPage.render) { PayLinksPage.render(); return; }
    } catch (_e) {}
    _blocked('docs_renderPayLinks', 'PayLinksPage');
  };

  _.docs_updateInvStats = function () {
    try {
      if (typeof InvoicesPage !== 'undefined' && InvoicesPage.refreshStats) { InvoicesPage.refreshStats(); return; }
    } catch (_e) {}
  };

  /* ════════════════════════════════════════
     SYSTEM OPERATIONS
  ════════════════════════════════════════ */

  _.system_executionBegin = function (op, params) {
    try {
      if (typeof ExecutionCoordinator !== 'undefined') {
        return ExecutionCoordinator.begin(op, params);
      }
    } catch (_e) {
      _reportFailure('system_executionBegin', 'ExecutionCoordinator.begin', _e);
    }
    return _blocked('system_executionBegin', 'ExecutionCoordinator');
  };

  _.system_auditLog = function (event, detail) {
    try {
      if (typeof AuditManager !== 'undefined') AuditManager.log(event, detail);
    } catch (_e) {}
  };

  _.system_lockAcquire = function (name, ttl) {
    try {
      if (typeof LockManager !== 'undefined') return LockManager.acquire(name, ttl);
    } catch (_e) {}
    return null;
  };

  /* ════════════════════════════════════════
     INTERNAL — Blocked execution reporting
  ════════════════════════════════════════ */

  function _reportFailure(name, target, error) {
    console.warn('[CoreMigrate v19] Modular path failed: ' + name + ' → ' + target + ' — ' + (error ? error.message : 'unknown'));
    try {
      if (typeof RuntimeMode !== 'undefined') RuntimeMode.recordViolation(name, 'Modular path failed: ' + target);
    } catch (_e) {}
    try {
      if (typeof AuditManager !== 'undefined') AuditManager.log('MODULAR_PATH_FAILURE', {
        adapter: name,
        target: target,
        error: error ? error.message : 'unknown'
      });
    } catch (_e2) {}
  }

  function _blocked(name, target) {
    var msg = 'CoreMigrate.' + name + ' → ' + target + ' — NO LEGACY FALLBACK in PURE_MODULAR';
    console.error('[CoreMigrate v19] BLOCKED: ' + msg);
    try {
      if (typeof ProductionGuard !== 'undefined') ProductionGuard.guard(name, false, true);
    } catch (_e) {}
    try {
      if (typeof PureExecutionGuard !== 'undefined' && PureExecutionGuard.isActive()) {
        PureExecutionGuard.getBlocked();
      }
    } catch (_e2) {}
    try {
      if (typeof EventBus !== 'undefined') EventBus.emit('EXECUTION_BLOCKED_NO_LEGACY_FALLBACK', {
        adapter: name,
        target: target,
        timestamp: Date.now()
      });
    } catch (_e3) {}
    return null;
  }

  /** @public */
  window.CoreMigrate = {
    VERSION: '19.0.0',
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
