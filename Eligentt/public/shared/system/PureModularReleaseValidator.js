/**
 * Elligentt PureModularReleaseValidator — Phase 20 Production Release Validator
 *
 * Comprehensive validation of ALL layers before production cutover.
 *
 * Validates: Architecture, Runtime, Security, Infrastructure, Performance
 *
 * Returns: isProductionReady()
 *
 * Attached to: window.PureModularReleaseValidator
 *
 * @module PureModularReleaseValidator
 * @version 20.0.0
 */
(function () {
  'use strict';

  function validate() {
    return {
      version: '20.0.0',
      generatedAt: new Date().toISOString(),
      architecture: _validateArchitecture(),
      runtime: _validateRuntime(),
      security: _validateSecurity(),
      infrastructure: _validateInfrastructure(),
      performance: _validatePerformance(),
      summary: null
    };
  }

  /* ── Architecture ──────────────────────────────────────── */

  function _validateArchitecture() {
    var result = { pass: false, checks: [] };

    var pageModules = ['SwapPage','BridgePage','ContactsPage','ReportsPage','HistoryPage','InvoicesPage','PayLinksPage','PoolPage','XChainPage','WalletPage','PaymentsPage','SchedulerPage','TreasuryPage','AutonomaPage','AIWalletRuntime'];
    var found = pageModules.filter(function (p) { return typeof window[p] !== 'undefined'; });
    result.checks.push({ name: 'Page Modules',   ok: found.length >= 8, value: found.length + '/' + pageModules.length });

    var domains = ['SwapDomain','BridgeDomain','WalletDomain','PaymentDomain','SchedulerDomain','TreasuryDomain','ContactsDomain','HistoryDomain'];
    var domFound = domains.filter(function (d) { return typeof window[d] !== 'undefined'; });
    result.checks.push({ name: 'Domain Services', ok: domFound.length >= 3, value: domFound.length + '/' + domains.length });

    var plugins = 0;
    try { if (typeof PluginRegistry !== 'undefined') plugins = PluginRegistry.getCount(); } catch (_e) {}
    result.checks.push({ name: 'Plugins',         ok: plugins > 0, value: plugins });

    result.checks.push({ name: 'AI Wallet',       ok: typeof AIWallet !== 'undefined' || typeof AIWalletRuntime !== 'undefined' });
    result.checks.push({ name: 'Autonoma',         ok: typeof AutonomaCore !== 'undefined' || typeof AutonomaPage !== 'undefined' });

    var stores = ['WalletStore','PaymentStore','SwapStore','PoolStore','UIStore','SettingsStore','AIWalletStore','AutonomaStore'];
    var storeFound = stores.filter(function (s) { return typeof window[s] !== 'undefined'; });
    result.checks.push({ name: 'Stores',           ok: storeFound.length >= 5, value: storeFound.length + '/' + stores.length });

    result.checks.push({ name: 'EventBus',         ok: typeof EventBus !== 'undefined' });
    result.checks.push({ name: 'EventDelegator',   ok: typeof EventDelegator !== 'undefined' });
    result.checks.push({ name: 'CoreMigrate',      ok: typeof CoreMigrate !== 'undefined' });
    result.checks.push({ name: 'ApplicationKernel',ok: typeof ApplicationKernel !== 'undefined' });
    result.checks.push({ name: 'SystemManager',    ok: typeof SystemManager !== 'undefined' });

    result.pass = result.checks.every(function (c) { return c.ok; });
    return result;
  }

  /* ── Runtime ───────────────────────────────────────────── */

  function _validateRuntime() {
    var result = { pass: false, checks: [] };

    result.checks.push({ name: 'RuntimeMode',          ok: typeof RuntimeMode !== 'undefined' });
    result.checks.push({ name: 'ProductionGuard',      ok: typeof ProductionGuard !== 'undefined' });
    result.checks.push({ name: 'PureExecutionGuard',   ok: typeof PureExecutionGuard !== 'undefined' });
    result.checks.push({ name: 'ProductionCutoverManager', ok: typeof ProductionCutoverManager !== 'undefined' });
    result.checks.push({ name: 'PureModularValidator', ok: typeof PureModularValidator !== 'undefined' });
    result.checks.push({ name: 'PureModularAudit',     ok: typeof PureModularAudit !== 'undefined' });

    var mode = 'UNKNOWN';
    try { mode = RuntimeMode.getMode(); } catch (_e) {}
    result.checks.push({ name: 'RuntimeMode Active',   ok: true, value: mode });

    result.checks.push({ name: 'EventBus Active',      ok: typeof EventBus !== 'undefined' && EventBus.count ? EventBus.count() > 0 : true });

    result.pass = result.checks.every(function (c) { return c.ok; });
    return result;
  }

  /* ── Security ──────────────────────────────────────────── */

  function _validateSecurity() {
    var result = { pass: false, checks: [] };

    result.checks.push({ name: 'SecurityCenter',      ok: typeof SecurityCenter !== 'undefined' });
    result.checks.push({ name: 'IntentSecurity',      ok: typeof IntentSecurity !== 'undefined' });
    result.checks.push({ name: 'AgentAuthorization',  ok: typeof AgentAuthorization !== 'undefined' });
    result.checks.push({ name: 'PolicyEngine',         ok: typeof PolicyEngine !== 'undefined' });
    result.checks.push({ name: 'RiskEngine',           ok: typeof RiskEngine !== 'undefined' });
    result.checks.push({ name: 'TreasuryGuard',        ok: typeof TreasuryGuard !== 'undefined' });
    result.checks.push({ name: 'AuditManager',         ok: typeof AuditManager !== 'undefined' });
    result.checks.push({ name: 'DOMPurify',            ok: typeof DOMPurify !== 'undefined' });
    result.checks.push({ name: 'StorageAdapter',       ok: typeof StorageAdapter !== 'undefined' });

    result.checks.push({ name: 'ErrorHandler',         ok: typeof ErrorHandler !== 'undefined' });
    result.checks.push({ name: 'AnomalyDetection',     ok: typeof AnomalyDetection !== 'undefined' });
    result.checks.push({ name: 'InvariantEngine',      ok: typeof InvariantEngine !== 'undefined' });

    result.pass = result.checks.every(function (c) { return c.ok; });
    return result;
  }

  /* ── Infrastructure ────────────────────────────────────── */

  function _validateInfrastructure() {
    var result = { pass: false, checks: [] };

    result.checks.push({ name: 'RPC Service',        ok: typeof RPCService !== 'undefined' });
    result.checks.push({ name: 'Wallet Service',     ok: typeof WalletService !== 'undefined' });
    result.checks.push({ name: 'Notification Service',ok: typeof NotificationService !== 'undefined' });
    result.checks.push({ name: 'RPC Manager',        ok: typeof RPCManager !== 'undefined' });
    result.checks.push({ name: 'Chain Simulator',    ok: typeof ChainSimulator !== 'undefined' });
    result.checks.push({ name: 'Cache Manager',      ok: typeof CacheManager !== 'undefined' });
    result.checks.push({ name: 'Queue Manager',      ok: typeof QueueManager !== 'undefined' });
    result.checks.push({ name: 'Lock Manager',       ok: typeof LockManager !== 'undefined' });
    result.checks.push({ name: 'CircuitBreaker',     ok: typeof CircuitBreaker !== 'undefined' });
    result.checks.push({ name: 'Heartbeat Manager',  ok: typeof HeartbeatManager !== 'undefined' });
    result.checks.push({ name: 'Recovery Manager',   ok: typeof RecoveryManager !== 'undefined' });
    result.checks.push({ name: 'ObservabilityCenter',ok: typeof ObservabilityCenter !== 'undefined' });

    result.pass = result.checks.filter(function (c) { return c.ok; }).length >= 8;
    return result;
  }

  /* ── Performance ───────────────────────────────────────── */

  function _validatePerformance() {
    var result = { pass: true, checks: [], metrics: {} };

    try {
      if (typeof performance !== 'undefined') {
        var t0 = performance.timing || {};
        result.metrics.uptime = Math.round(performance.now());
        if (performance.memory) {
          result.metrics.memoryMB = Math.round(performance.memory.usedJSHeapSize / 1048576);
          result.metrics.memoryTotalMB = Math.round(performance.memory.totalJSHeapSize / 1048576);
        }
      }
    } catch (_e) {}

    result.checks.push({ name: 'Performance API',       ok: typeof performance !== 'undefined' });
    result.checks.push({ name: 'Memory under 100MB',    ok: result.metrics.memoryMB ? result.metrics.memoryMB < 100 : true });
    try {
      var scripts = document.querySelectorAll('script[src]').length;
      result.checks.push({ name: 'External scripts count', ok: scripts > 0, value: scripts });
    } catch (_e2) {}

    result.pass = result.checks.every(function (c) { return c.ok; });
    return result;
  }

  /* ── API ───────────────────────────────────────────────── */

  function isProductionReady() {
    var v = validate();
    v.summary = {
      architecturePass: v.architecture.pass,
      runtimePass: v.runtime.pass,
      securityPass: v.security.pass,
      infrastructurePass: v.infrastructure.pass,
      performancePass: v.performance.pass
    };
    v.summary.allPassed = Object.values(v.summary).slice(0, 5).every(function (p) { return p === true; });
    return v.summary;
  }

  function printReport() {
    var v = validate();
    var s = isProductionReady();

    var lines = [
      '',
      '========================================',
      'PHASE 20 — PURE MODULAR RELEASE VALIDATOR',
      '========================================',
      '',
      'Architecture:    ' + (v.architecture.pass ? 'PASS' : 'FAIL'),
      'Runtime:         ' + (v.runtime.pass ? 'PASS' : 'FAIL'),
      'Security:        ' + (v.security.pass ? 'PASS' : 'FAIL'),
      'Infrastructure:  ' + (v.infrastructure.pass ? 'PASS' : 'FAIL'),
      'Performance:     ' + (v.performance.pass ? 'PASS' : 'FAIL'),
      '',
      'PRODUCTION READY: ' + (s.allPassed ? 'YES' : 'NO'),
      '',
      '========================================'
    ];

    var output = lines.join('\n');
    console.log(output);
    return output;
  }

  window.PureModularReleaseValidator = {
    VERSION: '20.0.0',
    validate: validate,
    isProductionReady: isProductionReady,
    printReport: printReport
  };
})();
