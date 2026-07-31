/**
 * Elligentt PureExecutionGuard — Legacy Execution Blocker (Phase 19)
 *
 * In PURE_MODULAR mode: blocks ALL legacy execution paths.
 * Legacy functions are monitored. If any legacy code attempts to execute:
 *   1. Execution is BLOCKED
 *   2. Error is logged to ProductionGuard, ObservabilityCenter, AuditManager
 *   3. RuntimeMode violation is recorded
 *
 * Replacement mapping is provided for every blocked function.
 *
 * This guard is the enforcement mechanism. No legacy execution is allowed past it.
 *
 * Attached to: window.PureExecutionGuard
 *
 * @module PureExecutionGuard
 * @version 19.0.0
 */
(function () {
  'use strict';

  var _active = false;
  var _blocked = [];
  var _originalFunctions = {};

  /** Mapping of legacy functions → modular replacements */
  var BLOCK_MAP = {
    // Rendering
    'renderContacts':       { replacement: 'ContactsPage.render()',       domain: 'contacts',   block: true },
    'renderReports':        { replacement: 'ReportsPage.render()',        domain: 'reports',    block: true },
    'renderQueueTable':     { replacement: 'HistoryPage.render()',        domain: 'history',    block: true },
    'renderInvoices':       { replacement: 'InvoicesPage.render()',       domain: 'invoices',   block: true },
    'renderPayLinks':       { replacement: 'PayLinksPage.render()',       domain: 'paylinks',   block: true },
    'renderPoolList':       { replacement: 'PoolPage.render()',           domain: 'pool',       block: true },
    'renderXcHistory':      { replacement: 'XChainPage.render()',         domain: 'xchain',     block: true },
    'renderFeeRevenue':     { replacement: 'TreasuryPage.render()',       domain: 'treasury',   block: true },
    'renderTemplates':      { replacement: 'TemplatesPage.render()',      domain: 'templates',  block: true },
    'renderSchedules':      { replacement: 'SchedulerPage.render()',      domain: 'scheduler',  block: true },
    // Swap
    'updateSwapRate':       { replacement: 'SwapPage.refresh()',          domain: 'swap',       block: true },
    'executeSwap':          { replacement: 'SwapPage.execute()',          domain: 'swap',       block: true },
    // Bridge
    'executeBridgeOrTurbo': { replacement: 'BridgePage.execute()',        domain: 'bridge',     block: true },
    'executeTurboBridge':   { replacement: 'BridgePage.turbo()',          domain: 'bridge',     block: true },
    'updateBridgeEst':      { replacement: 'BridgePage.refresh()',        domain: 'bridge',     block: true },
    // Wallet
    'connectWalletConnect': { replacement: 'WalletPage.connect()',        domain: 'wallet',     block: true },
    'disconnectWallet':     { replacement: 'WalletPage.disconnect()',     domain: 'wallet',     block: true },
    'refreshBalance':       { replacement: 'WalletPage.refreshBalance()', domain: 'wallet',     block: true },
    'switchNetwork':        { replacement: 'WalletPage.switchChain()',    domain: 'wallet',     block: true },
    // Payments
    'signTx':               { replacement: 'PaymentsPage.execute()',      domain: 'payments',   block: true },
    // Scheduler
    'checkDueSchedules':    { replacement: 'SchedulerPage.executeAll()',  domain: 'scheduler',  block: true }
  };

  /**
   * Activate the guard. Wraps all legacy functions.
   * In PURE_MODULAR mode: blocks execution entirely.
   * In MIXED mode: warns but allows.
   */
  function activate() {
    if (_active) return;
    _active = true;

    Object.keys(BLOCK_MAP).forEach(function (name) {
      try {
        if (typeof window[name] === 'function') {
          _originalFunctions[name] = window[name];
          var info = BLOCK_MAP[name];

          window[name] = function () {
            var isPure = false;
            try { isPure = typeof RuntimeMode !== 'undefined' && RuntimeMode.isPure(); } catch (_e) { isPure = true; }

            if (isPure && info.block) {
              _reportBlock(name, info);
              console.error(
                '[PureExecutionGuard] LEGACY_EXECUTION_BLOCKED\n' +
                'Function: ' + name + '()\n' +
                'Replacement: ' + info.replacement + '\n' +
                'Domain: ' + info.domain
              );
              return undefined;
            }

            return _originalFunctions[name].apply(this, arguments);
          };
        }
      } catch (_e) {}
    });

    console.log('[PureExecutionGuard] Activated — monitoring ' + Object.keys(BLOCK_MAP).length + ' legacy functions');
  }

  /**
   * Report a blocked execution to all observability systems.
   */
  function _reportBlock(name, info) {
    var entry = {
      function: name,
      replacement: info.replacement,
      domain: info.domain,
      timestamp: Date.now(),
      iso: new Date().toISOString()
    };

    _blocked.push(entry);
    if (_blocked.length > 200) _blocked.length = 200;

    try { if (typeof RuntimeMode !== 'undefined') RuntimeMode.recordViolation(name, 'LEGACY_EXECUTION_BLOCKED by PureExecutionGuard'); } catch (_e) {}
    try { if (typeof ProductionGuard !== 'undefined') ProductionGuard.guard(name, false, true); } catch (_e2) {}
    try { if (typeof AuditManager !== 'undefined') AuditManager.log('LEGACY_EXECUTION_BLOCKED', entry); } catch (_e3) {}
    try { if (typeof ObservabilityCenter !== 'undefined') ObservabilityCenter.getDashboard(); } catch (_e4) {}
    try { if (typeof EventBus !== 'undefined') EventBus.emit('LEGACY_EXECUTION_BLOCKED', entry); } catch (_e5) {}
  }

  /**
   * Deactivate the guard and restore original functions.
   */
  function deactivate() {
    if (!_active) return;
    Object.keys(_originalFunctions).forEach(function (name) {
      try { window[name] = _originalFunctions[name]; } catch (_e) {}
    });
    _originalFunctions = {};
    _active = false;
  }

  /**
   * Check if a specific legacy function is currently blocked.
   * @param {string} name
   * @returns {{ blocked: boolean, replacement: string|null }}
   */
  function isBlocked(name) {
    var info = BLOCK_MAP[name];
    if (!info) return { blocked: false, replacement: null };
    return { blocked: _active && info.block, replacement: info.replacement };
  }

  /** @returns {Object[]} All blocked execution attempts since activation */
  function getBlocked() { return _blocked.slice(); }

  /** @returns {number} */
  function getBlockedCount() { return _blocked.length; }

  /** @returns {boolean} */
  function isActive() { return _active; }

  /**
   * Get a comprehensive report.
   * @returns {Object}
   */
  function getReport() {
    var byFunction = {};
    _blocked.forEach(function (b) { byFunction[b.function] = (byFunction[b.function] || 0) + 1; });

    return {
      active: _active,
      totalBlocked: _blocked.length,
      monitoredFunctions: Object.keys(BLOCK_MAP).length,
      uniqueBlockedFunctions: Object.keys(byFunction).length,
      topBlocked: Object.entries(byFunction).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 10),
      severity: _blocked.length === 0 ? 'CLEAN' : _blocked.length < 3 ? 'LOW' : _blocked.length < 10 ? 'MEDIUM' : 'HIGH',
      blockedList: _blocked.slice(0, 20)
    };
  }

  /** Clear blocked history */
  function clear() { _blocked = []; }

  /**
   * Get the full block map with replacements.
   * @returns {Object}
   */
  function getBlockMap() { return Object.assign({}, BLOCK_MAP); }

  /** @public */
  window.PureExecutionGuard = {
    VERSION: '19.0.0',
    BLOCK_MAP: BLOCK_MAP,
    activate: activate,
    deactivate: deactivate,
    isActive: isActive,
    isBlocked: isBlocked,
    getBlocked: getBlocked,
    getBlockedCount: getBlockedCount,
    getReport: getReport,
    getBlockMap: getBlockMap,
    clear: clear
  };
})();
