/**
 * Elligentt LegacyPurgeAnalyzer — Phase 19 Comprehensive Legacy Purge Analysis
 *
 * Analyzes:
 *   - legacy functions still in index.html
 *   - compatibility wrappers in CoreMigrationAdapters
 *   - remaining window globals
 *   - inline event handlers (onclick, onchange, oninput)
 *   - runtime dependencies between modules
 *   - remaining monolith references
 *
 * Generates classification:
 *   SAFE_REMOVE     → has modular replacement, zero runtime callers
 *   HIGH_RISK       → blockchain-affecting, needs careful removal
 *   KEEP            → essential infrastructure, must remain
 *   BLOCKED         → cannot remove yet (dependency graph resolution pending)
 *   UNKNOWN         → unclear impact
 *
 * Attached to: window.LegacyPurgeAnalyzer
 *
 * @module LegacyPurgeAnalyzer
 * @version 19.0.0
 */
(function () {
  'use strict';

  /** All known legacy functions with their modular replacements */
  var KNOWN_FUNCTIONS = {
    renderContacts:       { replacement: 'ContactsPage.render()',       domain: 'contacts',   type: 'rendering' },
    renderReports:        { replacement: 'ReportsPage.render()',        domain: 'reports',    type: 'rendering' },
    renderQueueTable:     { replacement: 'HistoryPage.render()',        domain: 'history',    type: 'rendering' },
    renderInvoices:       { replacement: 'InvoicesPage.render()',       domain: 'invoices',   type: 'rendering' },
    renderPayLinks:       { replacement: 'PayLinksPage.render()',       domain: 'paylinks',   type: 'rendering' },
    renderPoolList:       { replacement: 'PoolPage.render()',           domain: 'pool',       type: 'rendering' },
    renderXcHistory:      { replacement: 'XChainPage.render()',         domain: 'xchain',     type: 'rendering' },
    renderFeeRevenue:     { replacement: 'TreasuryPage.render()',       domain: 'treasury',   type: 'rendering' },
    renderTemplates:      { replacement: 'TemplatesPage.render()',      domain: 'templates',  type: 'rendering' },
    renderSchedules:      { replacement: 'SchedulerPage.render()',      domain: 'scheduler',  type: 'rendering' },
    updateSwapRate:       { replacement: 'SwapPage.refresh()',          domain: 'swap',       type: 'rendering' },
    updateBridgeEst:      { replacement: 'BridgePage.refresh()',        domain: 'bridge',     type: 'rendering' },
    vaultRefreshUI:       { replacement: 'TreasuryPage.render()',       domain: 'treasury',   type: 'rendering' },
    executeSwap:          { replacement: 'SwapPage.execute()',          domain: 'swap',       type: 'execution' },
    executeBridgeOrTurbo: { replacement: 'BridgePage.execute()',        domain: 'bridge',     type: 'execution' },
    executeTurboBridge:   { replacement: 'BridgePage.turbo()',          domain: 'bridge',     type: 'execution' },
    signTx:               { replacement: 'PaymentsPage.execute()',      domain: 'payments',   type: 'execution' },
    checkDueSchedules:    { replacement: 'SchedulerPage.executeAll()',  domain: 'scheduler',  type: 'execution' },
    connectWalletConnect: { replacement: 'WalletPage.connect()',        domain: 'wallet',     type: 'wallet' },
    disconnectWallet:     { replacement: 'WalletPage.disconnect()',     domain: 'wallet',     type: 'wallet' },
    refreshBalance:       { replacement: 'WalletPage.refreshBalance()', domain: 'wallet',     type: 'wallet' },
    switchNetwork:        { replacement: 'WalletPage.switchChain()',    domain: 'wallet',     type: 'wallet' }
  };

  /** Global registry v19 allowed window properties */
  var ALLOWED_GLOBALS = [
    'App', 'EventBus', 'AppBootstrap', 'ApplicationKernel', 'SystemManager',
    'RuntimeMode', 'ProductionGuard', 'ProductionConfig', 'GlobalRegistry',
    'ethers', 'DOMPurify', 'QRCode',
    'PageLoader', 'PageController', 'EventDelegator',
    'WalletStore', 'PaymentStore', 'SwapStore', 'PoolStore', 'AIWalletStore',
    'AutonomaStore', 'SettingsStore', 'UIStore',
    'PureExecutionGuard', 'PureRuntimeValidator',
    'ObservabilityCenter', 'AuditManager',
    'SecurityCenter', 'IntentSecurity'
  ];

  /**
   * Full analysis: scan everything and classify.
   * @returns {Object}
   */
  function analyze() {
    var report = {
      generatedAt: new Date().toISOString(),
      version: '19.0.0',
      functions: _analyzeFunctions(),
      globals: _analyzeGlobals(),
      inlineHandlers: _analyzeInlineHandlers(),
      compatibilityWrappers: _analyzeCompatibilityWrappers(),
      runtimeDependencies: _analyzeRuntimeDependencies(),
      summary: null
    };

    report.summary = _generateSummary(report);
    return report;
  }

  /* ── Function Analysis ──────────────────────────────────── */

  function _analyzeFunctions() {
    var removable = [];
    var blocked = [];
    var keep = [];

    Object.keys(KNOWN_FUNCTIONS).forEach(function (name) {
      var info = KNOWN_FUNCTIONS[name];
      var exists = typeof window[name] === 'function';
      var callerCount = _countCallers(name);
      var hasReplacement = _checkReplacementExists(info.replacement);
      var risk = _assessRisk(info);

      var entry = {
        name: name,
        replacement: info.replacement,
        domain: info.domain,
        type: info.type,
        existsOnWindow: exists,
        replacementExists: hasReplacement,
        callerCount: callerCount,
        riskLevel: risk,
        classification: null
      };

      if (risk === 'BLOCKED') {
        entry.classification = 'BLOCKED';
        blocked.push(entry);
      } else if (!hasReplacement) {
        entry.classification = 'HIGH_RISK';
        blocked.push(entry);
      } else if (callerCount > 0 && info.type === 'execution') {
        entry.classification = 'HIGH_RISK';
        blocked.push(entry);
      } else if (existingInlineCaller(name)) {
        entry.classification = 'HIGH_RISK';
        blocked.push(entry);
      } else {
        entry.classification = 'SAFE_REMOVE';
        removable.push(entry);
      }
    });

    return {
      safeRemove: removable,
      blocked: blocked,
      safeRemoveCount: removable.length,
      blockedCount: blocked.length,
      total: removable.length + blocked.length
    };
  }

  function _assessRisk(info) {
    if (info.type === 'execution') return 'HIGH';
    if (info.type === 'wallet') return 'HIGH';
    return 'LOW';
  }

  function _checkReplacementExists(replacementPath) {
    var parts = replacementPath.split('.');
    var root = parts[0];
    try {
      return typeof window[root] !== 'undefined';
    } catch (_e) {
      return false;
    }
  }

  function _countCallers(funcName) {
    var count = 0;
    try {
      var scripts = document.querySelectorAll('script:not([src])');
      scripts.forEach(function (s) {
        if (s.textContent && s.textContent.indexOf(funcName) !== -1) {
          count += (s.textContent.match(new RegExp(funcName, 'g')) || []).length;
        }
      });
    } catch (_e) {}
    return count;
  }

  function existingInlineCaller(funcName) {
    try {
      var body = document.body.innerHTML || '';
      return body.indexOf(funcName + '(') !== -1;
    } catch (_e) {
      return false;
    }
  }

  /* ── Global Analysis ────────────────────────────────────── */

  function _analyzeGlobals() {
    var report = { total: 0, allowed: ALLOWED_GLOBALS.length, removable: [], unknown: [] };
    try {
      var keys = Object.keys(window).filter(function (k) {
        return k.indexOf('_') !== 0 && k.indexOf('$') === -1 && k.indexOf('webkit') === -1 && k.indexOf('on') !== 0 && k.length < 50;
      });
      report.total = keys.length;

      keys.forEach(function (k) {
        if (ALLOWED_GLOBALS.indexOf(k) !== -1) return;
        if (typeof window[k] === 'function') {
          var found = false;
          Object.keys(KNOWN_FUNCTIONS).forEach(function (fn) {
            if (k === fn) { found = true; }
          });
          report.removable.push({
            name: k,
            type: typeof window[k],
            isLegacyFunction: found,
            suggestedAction: found ? 'REMOVE — has modular replacement' : 'UNKNOWN — evaluate'
          });
        } else if (typeof window[k] !== 'undefined' && typeof window[k] !== 'object') {
          report.unknown.push({ name: k, type: typeof window[k] });
        }
      });
    } catch (_e) {}
    report.removableCount = report.removable.length;
    report.reductionTarget = report.total - ALLOWED_GLOBALS.length;
    return report;
  }

  /* ── Inline Handler Analysis ─────────────────────────────── */

  function _analyzeInlineHandlers() {
    var report = { onclick: 0, onchange: 0, oninput: 0, onkeyup: 0, onsubmit: 0, total: 0 };
    try {
      ['onclick', 'onchange', 'oninput', 'onkeyup', 'onsubmit'].forEach(function (attr) {
        report[attr] = document.querySelectorAll('[' + attr + ']').length;
      });
      report.total = report.onclick + report.onchange + report.oninput + report.onkeyup + report.onsubmit;
      report.migrationPossible = report.total;
      report.recommendation = report.total > 0 ? 'MIGRATE TO data-action + EventDelegator' : 'CLEAN';
    } catch (_e) {}
    return report;
  }

  /* ── Compatibility Wrapper Analysis ──────────────────────── */

  function _analyzeCompatibilityWrappers() {
    var wrappers = [];
    try {
      if (typeof CoreMigrate !== 'undefined') {
        Object.keys(CoreMigrate).forEach(function (k) {
          if (typeof CoreMigrate[k] === 'function' && k !== 'VERSION') {
            var src = CoreMigrate[k].toString();
            var hasLegacyFallback = src.indexOf('try') !== -1 && src.indexOf('function') !== -1;
            wrappers.push({
              name: 'CoreMigrate.' + k,
              hasLegacyFallback: hasLegacyFallback,
              action: hasLegacyFallback ? 'REMOVE FALLBACK' : 'KEEP PURE',
              replacement: hasLegacyFallback ? 'PureExecutionGuard blocks direct legacy call' : null
            });
          }
        });
      }
    } catch (_e) {}
    return { total: wrappers.length, withFallback: wrappers.filter(function (w) { return w.hasLegacyFallback; }).length, wrappers: wrappers };
  }

  /* ── Runtime Dependency Analysis ─────────────────────────── */

  function _analyzeRuntimeDependencies() {
    var deps = {
      modularPages: _countModularPages(),
      modularDomains: _countModularDomains(),
      stores: _countStores(),
      plugins: _countPlugins(),
      systemModules: _countSystemModules(),
      securityModules: _countSecurityModules(),
      kernelLoaded: typeof ApplicationKernel !== 'undefined' && ApplicationKernel.isBooted ? ApplicationKernel.isBooted() : false,
      eventBusActive: typeof EventBus !== 'undefined' && EventBus.count ? EventBus.count() : 0,
      runtimeMode: _getRuntimeMode()
    };
    return deps;
  }

  function _countModularPages() {
    var pages = ['SwapPage', 'BridgePage', 'ContactsPage', 'ReportsPage', 'HistoryPage', 'InvoicesPage', 'PayLinksPage', 'PoolPage', 'XChainPage', 'WalletPage', 'PaymentsPage', 'SchedulerPage', 'TreasuryPage', 'AutonomaPage', 'AIWalletRuntime'];
    return pages.filter(function (p) { return typeof window[p] !== 'undefined'; }).length;
  }

  function _countModularDomains() {
    var domains = ['SwapDomain', 'BridgeDomain', 'WalletDomain', 'PaymentDomain', 'SchedulerDomain', 'TreasuryDomain', 'ContactsDomain', 'HistoryDomain'];
    return domains.filter(function (d) { return typeof window[d] !== 'undefined'; }).length;
  }

  function _countStores() {
    var stores = ['WalletStore', 'PaymentStore', 'SwapStore', 'PoolStore', 'AIWalletStore', 'AutonomaStore', 'SettingsStore', 'UIStore'];
    return stores.filter(function (s) { return typeof window[s] !== 'undefined'; }).length;
  }

  function _countPlugins() {
    try {
      if (typeof PluginRegistry !== 'undefined') return PluginRegistry.getCount();
    } catch (_e) {}
    return 0;
  }

  function _countSystemModules() {
    var mods = ['LockManager', 'CacheManager', 'CircuitBreaker', 'QueueManager', 'AgentManager', 'ExecutionCoordinator', 'WorkflowManager', 'ResourceManager', 'HeartbeatManager', 'LifecycleManager', 'MetricsManager', 'AuditManager', 'RecoveryManager', 'VersionManager', 'PolicyCoordinator', 'DiagnosticsManager'];
    return mods.filter(function (m) { return typeof window[m] !== 'undefined'; }).length;
  }

  function _countSecurityModules() {
    var mods = ['SecurityCenter', 'IntentSecurity', 'SecurityValidator', 'SecurityAudit', 'ProductionGuard', 'PureRuntimeValidator', 'PureExecutionGuard'];
    return mods.filter(function (m) { return typeof window[m] !== 'undefined'; }).length;
  }

  function _getRuntimeMode() {
    try { if (typeof RuntimeMode !== 'undefined') return RuntimeMode.getMode(); } catch (_e) {}
    return 'UNKNOWN';
  }

  /* ── Summary Generation ──────────────────────────────────── */

  function _generateSummary(report) {
    return {
      status: _determineStatus(report),
      totalLegacyFunctions: report.functions.total,
      safeToRemove: report.functions.safeRemoveCount,
      blocked: report.functions.blockedCount,
      globalsTotal: report.globals.total,
      globalsAllowed: report.globals.allowed,
      inlineHandlers: report.inlineHandlers.total,
      compatibilityWrappers: report.compatibilityWrappers.total,
      compatibilityWithFallback: report.compatibilityWrappers.withFallback,
      modularPages: report.runtimeDependencies.modularPages,
      modularDomains: report.runtimeDependencies.modularDomains,
      stores: report.runtimeDependencies.stores,
      plugins: report.runtimeDependencies.plugins,
      runtimeMode: report.runtimeDependencies.runtimeMode,
      recommendation: report.functions.blockedCount === 0 && report.inlineHandlers.total === 0 ? 'READY FOR PURE_MODULAR' : 'REMEDIATION REQUIRED'
    };
  }

  function _determineStatus(report) {
    if (report.functions.blockedCount === 0 && report.inlineHandlers.total === 0 && report.compatibilityWrappers.withFallback === 0) {
      return 'PURGE_READY';
    }
    if (report.functions.blockedCount < 5) return 'NEAR_READY';
    return 'REMEDIATION_NEEDED';
  }

  /**
   * Quick scan: just the numbers.
   * @returns {{ legacyFunctions: number, globals: number, inlineHandlers: number }}
   */
  function quickScan() {
    var legacyCount = Object.keys(KNOWN_FUNCTIONS).filter(function (k) {
      return typeof window[k] === 'function';
    }).length;
    var globalCount = 0;
    try { globalCount = Object.keys(window).filter(function (k) { return k.indexOf('_') !== 0 && k.length < 40 && typeof window[k] === 'function'; }).length; } catch (_e) {}
    var handlerCount = 0;
    try { handlerCount = document.querySelectorAll('[onclick],[onchange],[oninput]').length; } catch (_e2) {}
    return { legacyFunctions: legacyCount, globals: globalCount, inlineHandlers: handlerCount };
  }

  /**
   * Generate execution plan — ordered list of steps to achieve PURE_MODULAR.
   * @returns {Object[]}
   */
  function generatePurgePlan() {
    var full = analyze();
    var plan = [];

    // Step 1: Remove rendering functions (SAFE_REMOVE)
    full.functions.safeRemove.forEach(function (f) {
      plan.push({ step: plan.length + 1, action: 'DELETE_FUNCTION', target: f.name, domain: f.domain, risk: 'SAFE' });
    });

    // Step 2: Remove compatibility fallbacks
    full.compatibilityWrappers.wrappers.forEach(function (w) {
      if (w.hasLegacyFallback) {
        plan.push({ step: plan.length + 1, action: 'REMOVE_FALLBACK', target: w.name, risk: 'SAFE' });
      }
    });

    // Step 3: Replace inline handlers
    if (full.inlineHandlers.total > 0) {
      plan.push({ step: plan.length + 1, action: 'MIGRATE_INLINE_HANDLERS', target: 'ALL', count: full.inlineHandlers.total, risk: 'MODERATE' });
    }

    // Step 4: Activate PureExecutionGuard
    plan.push({ step: plan.length + 1, action: 'ACTIVATE_GUARD', target: 'PureExecutionGuard', risk: 'SAFE' });

    // Step 5: Switch to PURE_MODULAR
    plan.push({ step: plan.length + 1, action: 'SET_MODE', target: 'RuntimeMode.PURE_MODULAR', risk: 'HIGH', reversible: true });

    return { plan: plan, totalSteps: plan.length, estimatedImpact: full.summary };
  }

  /** @public */
  window.LegacyPurgeAnalyzer = {
    VERSION: '19.0.0',
    analyze: analyze,
    quickScan: quickScan,
    generatePurgePlan: generatePurgePlan,
    KNOWN_FUNCTIONS: KNOWN_FUNCTIONS,
    ALLOWED_GLOBALS: ALLOWED_GLOBALS
  };
})();
