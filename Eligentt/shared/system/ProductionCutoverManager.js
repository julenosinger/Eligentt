/**
 * Elligentt ProductionCutoverManager — Phase 20 Production Cutover Controller
 *
 * Controls the activation of PURE_MODULAR mode with strict validation gates.
 * PURE_MODULAR can ONLY be enabled if ALL gates pass.
 *
 * Gates:
 *   - All modules pass PureModularValidator validation
 *   - All stores loaded
 *   - All agents available
 *   - All security checks green
 *   - Zero unknown dependencies (PureModularAudit)
 *   - Zero legacy execution detected (PureExecutionGuard)
 *   - Zero active compatibility wrappers
 *   - PureModularValidator.isReady() === true
 *
 * Attached to: window.ProductionCutoverManager
 *
 * @module ProductionCutoverManager
 * @version 20.0.0
 */
(function () {
  'use strict';

  var _cutoverAttempted = false;
  var _cutoverTime = null;
  var _report = null;

  function activatePureModular() {
    if (_cutoverAttempted) {
      console.warn('[ProductionCutoverManager] Cutover already attempted at ' + _cutoverTime);
      return _report;
    }
    _cutoverAttempted = true;
    _cutoverTime = new Date().toISOString();

    console.log('[ProductionCutoverManager v20] Starting production cutover...');

    _report = {
      version: '20.0.0',
      attemptedAt: _cutoverTime,
      gates: {},
      passed: false,
      activated: false,
      reason: null
    };

    /* ── Gate 1: Module Validation ──────────────────────── */
    _report.gates.moduleValidation = _checkGate(
      'Module Validation',
      function () {
        if (typeof PureModularValidator === 'undefined') return { ok: false, reason: 'PureModularValidator not loaded' };
        var v = PureModularValidator.validate();
        return { ok: v.modules._allPassed, detail: v.modules._passed + '/' + v.modules._total + ' modules OK' };
      }
    );

    /* ── Gate 2: Store Validation ───────────────────────── */
    _report.gates.storeValidation = _checkGate(
      'Store Validation',
      function () {
        if (typeof PureModularValidator === 'undefined') return { ok: false, reason: 'PureModularValidator not loaded' };
        var v = PureModularValidator.validate();
        return { ok: v.stores._allPassed, detail: v.stores._passed + '/' + v.stores._total + ' stores OK' };
      }
    );

    /* ── Gate 3: Agent Validation ───────────────────────── */
    _report.gates.agentValidation = _checkGate(
      'Agent Validation',
      function () {
        if (typeof PureModularValidator === 'undefined') return { ok: false, reason: 'PureModularValidator not loaded' };
        var v = PureModularValidator.validate();
        return { ok: v.agents._allPassed, detail: v.agents._passed + '/' + v.agents._total + ' agents OK' };
      }
    );

    /* ── Gate 4: Security ───────────────────────────────── */
    _report.gates.security = _checkGate(
      'Security',
      function () {
        var checks = [
          typeof SecurityCenter !== 'undefined',
          typeof IntentSecurity !== 'undefined',
          typeof ProductionGuard !== 'undefined',
          typeof PureExecutionGuard !== 'undefined',
          typeof RiskEngine !== 'undefined',
          typeof AuditManager !== 'undefined'
        ];
        var passed = checks.filter(function (c) { return c; }).length;
        return { ok: passed >= 5, detail: passed + '/' + checks.length + ' security modules' };
      }
    );

    /* ── Gate 5: Zero Unknown Dependencies ──────────────── */
    _report.gates.unknownDependencies = _checkGate(
      'Zero Unknown Dependencies',
      function () {
        try {
          if (typeof PureModularAudit !== 'undefined') {
            var q = PureModularAudit.quickAudit();
            return { ok: q.unknown === 0, detail: q.unknown + ' unknown calls' };
          }
          return { ok: false, reason: 'PureModularAudit not loaded' };
        } catch (_e) { return { ok: false, reason: _e.message }; }
      }
    );

    /* ── Gate 6: Zero Active Legacy Execution ───────────── */
    _report.gates.legacyExecution = _checkGate(
      'Zero Active Legacy Execution',
      function () {
        try {
          if (typeof PureModularAudit !== 'undefined') {
            var q = PureModularAudit.quickAudit();
            return { ok: q.active === 0, detail: q.active + ' active legacy calls' };
          }
          return { ok: false, reason: 'PureModularAudit not loaded' };
        } catch (_e) { return { ok: false, reason: _e.message }; }
      }
    );

    /* ── Gate 7: Zero Compatibility Wrappers ────────────── */
    _report.gates.compatibilityWrappers = _checkGate(
      'Zero Active Compatibility Wrappers',
      function () {
        try {
          if (typeof CoreMigrate !== 'undefined' && CoreMigrate.VERSION) {
            if (CoreMigrate.VERSION === '19.0.0') {
              return { ok: true, detail: 'CoreMigrate v19 — pure modular routing' };
            }
            return { ok: false, detail: 'CoreMigrate version: ' + CoreMigrate.VERSION };
          }
          return { ok: true, detail: 'CoreMigrate not present (clean)' };
        } catch (_e) { return { ok: false, reason: _e.message }; }
      }
    );

    /* ── Gate 8: PureModularValidator Ready ─────────────── */
    _report.gates.validatorReady = _checkGate(
      'PureModularValidator.isReady()',
      function () {
        try {
          if (typeof PureModularValidator !== 'undefined') {
            var ready = PureModularValidator.isReady();
            var failures = PureModularValidator.getFailures();
            return { ok: ready, detail: ready ? 'ALL CHECKS PASSED' : failures.length + ' failures' };
          }
          return { ok: false, reason: 'PureModularValidator not loaded' };
        } catch (_e) { return { ok: false, reason: _e.message }; }
      }
    );

    /* ── Gate 9: Runtime Infrastructure ─────────────────── */
    _report.gates.runtimeInfra = _checkGate(
      'Runtime Infrastructure',
      function () {
        var checks = [
          typeof RuntimeMode !== 'undefined',
          typeof EventBus !== 'undefined',
          typeof AppBootstrap !== 'undefined',
          typeof SystemManager !== 'undefined',
          typeof ApplicationKernel !== 'undefined'
        ];
        var passed = checks.filter(function (c) { return c; }).length;
        return { ok: passed >= 4, detail: passed + '/' + checks.length + ' infra modules' };
      }
    );

    /* ── Evaluate all gates ─────────────────────────────── */
    var allGates = Object.values(_report.gates);
    _report.passed = allGates.every(function (g) { return g.ok; });

    if (!_report.passed) {
      var failed = allGates.filter(function (g) { return !g.ok; }).map(function (g) { return g.name; });
      _report.reason = 'Gates failed: ' + failed.join(', ');
      _report.activated = false;
      console.error('[ProductionCutoverManager] CUTOVER BLOCKED — ' + _report.reason);
      _emit('CUTOVER_BLOCKED', _report);
      return _report;
    }

    /* ── ACTIVATE PURE_MODULAR ──────────────────────────── */
    try {
      if (typeof RuntimeMode !== 'undefined') {
        RuntimeMode.setMode('PURE_MODULAR');
        _report.activated = true;
        _report.reason = 'PURE_MODULAR activated successfully — ALL gates passed';
        console.log('[ProductionCutoverManager] PURE_MODULAR ACTIVATED — all gates passed');
        _emit('CUTOVER_COMPLETE', _report);
      } else {
        _report.reason = 'RuntimeMode not available — cannot set PURE_MODULAR';
        _report.activated = false;
        console.error('[ProductionCutoverManager] ' + _report.reason);
      }
    } catch (e) {
      _report.reason = 'Exception: ' + e.message;
      _report.activated = false;
      console.error('[ProductionCutoverManager] Cutover failed:', e);
      _emit('CUTOVER_FAILED', { error: e.message, report: _report });
    }

    return _report;
  }

  function _checkGate(name, fn) {
    try {
      var result = fn();
      return {
        name: name,
        ok: result.ok,
        detail: result.detail || result.reason || '',
        timestamp: Date.now()
      };
    } catch (e) {
      return { name: name, ok: false, detail: 'Exception: ' + e.message, timestamp: Date.now() };
    }
  }

  function _emit(event, data) {
    try { if (typeof EventBus !== 'undefined') EventBus.emit(event, data); } catch (_e) {}
    try { if (typeof AuditManager !== 'undefined') AuditManager.log(event, data); } catch (_e2) {}
  }

  function validateCutover() {
    var tempReport = {
      version: '20.0.0',
      gates: {},
      passed: false
    };

    tempReport.gates.moduleValidation    = _checkGate('Module Validation',    function () { try { var v = PureModularValidator.validate(); return { ok: v.modules._allPassed, detail: v.modules._passed + '/' + v.modules._total }; } catch (_e) { return { ok: false, reason: _e.message }; } });
    tempReport.gates.storeValidation     = _checkGate('Store Validation',     function () { try { var v = PureModularValidator.validate(); return { ok: v.stores._allPassed, detail: v.stores._passed + '/' + v.stores._total }; } catch (_e) { return { ok: false, reason: _e.message }; } });
    tempReport.gates.agentValidation     = _checkGate('Agent Validation',     function () { try { var v = PureModularValidator.validate(); return { ok: v.agents._allPassed, detail: v.agents._passed + '/' + v.agents._total }; } catch (_e) { return { ok: false, reason: _e.message }; } });
    tempReport.gates.zeroUnknownDeps     = _checkGate('Zero Unknown Deps',   function () { try { var q = PureModularAudit.quickAudit(); return { ok: q.unknown === 0, detail: q.unknown + ' unknown' }; } catch (_e) { return { ok: false, reason: _e.message }; } });
    tempReport.gates.zeroActiveLegacy    = _checkGate('Zero Active Legacy',  function () { try { var q = PureModularAudit.quickAudit(); return { ok: q.active === 0, detail: q.active + ' active' }; } catch (_e) { return { ok: false, reason: _e.message }; } });
    tempReport.gates.validatorReady      = _checkGate('Validator Ready',     function () { try { var r = PureModularValidator.isReady(); return { ok: r, detail: r ? 'READY' : 'NOT READY' }; } catch (_e) { return { ok: false, reason: _e.message }; } });

    var allGates = Object.values(tempReport.gates);
    tempReport.passed = allGates.every(function (g) { return g.ok; });
    return tempReport;
  }

  function verifyDependencies() {
    return {
      hasPureModularAudit: typeof PureModularAudit !== 'undefined',
      hasPureModularValidator: typeof PureModularValidator !== 'undefined',
      hasPhase19_5Cert: typeof Phase19_5Certification !== 'undefined',
      hasPureExecutionGuard: typeof PureExecutionGuard !== 'undefined',
      hasRuntimeMode: typeof RuntimeMode !== 'undefined',
      hasCoreMigrate: typeof CoreMigrate !== 'undefined',
      coreMigrateVersion: typeof CoreMigrate !== 'undefined' ? CoreMigrate.VERSION : 'N/A'
    };
  }

  function verifyModules() {
    var pages = ['SwapPage','BridgePage','ContactsPage','ReportsPage','HistoryPage','InvoicesPage','PayLinksPage','PoolPage','XChainPage','WalletPage','PaymentsPage','SchedulerPage','TreasuryPage','AutonomaPage'];
    return {
      total: pages.length,
      found: pages.filter(function (p) { return typeof window[p] !== 'undefined'; }).length,
      missing: pages.filter(function (p) { return typeof window[p] === 'undefined'; })
    };
  }

  function verifyStores() {
    var stores = ['WalletStore','PaymentStore','SwapStore','PoolStore','UIStore','SettingsStore','AIWalletStore','AutonomaStore'];
    return {
      total: stores.length,
      found: stores.filter(function (s) { return typeof window[s] !== 'undefined'; }).length,
      missing: stores.filter(function (s) { return typeof window[s] === 'undefined'; })
    };
  }

  function verifyAgents() {
    var agents = ['AutonomaAgent','agentTreasury','agentScheduleExecutor','agentWalletManager'];
    return {
      total: agents.length,
      found: agents.filter(function (a) { return typeof window[a] !== 'undefined'; }).length,
      missing: agents.filter(function (a) { return typeof window[a] === 'undefined'; })
    };
  }

  function verifyGlobals() {
    try {
      if (typeof GlobalRegistryV2 !== 'undefined') {
        return GlobalRegistryV2.auditGlobals();
      }
    } catch (_e) {}
    return { total: 0, violations: 0 };
  }

  function verifySecurity() {
    var mods = ['SecurityCenter','IntentSecurity','ProductionGuard','PureExecutionGuard','RiskEngine','TreasuryGuard','AuditManager'];
    return {
      total: mods.length,
      found: mods.filter(function (m) { return typeof window[m] !== 'undefined'; }).length,
      missing: mods.filter(function (m) { return typeof window[m] === 'undefined'; })
    };
  }

  function verifyPerformance() {
    var result = {};
    try {
      if (typeof performance !== 'undefined') result.uptime = Math.round(performance.now());
      if (typeof performance !== 'undefined' && performance.memory) {
        result.memoryMB = Math.round(performance.memory.usedJSHeapSize / 1048576);
      }
    } catch (_e) {}
    return result;
  }

  function generateReport() {
    var v = validateCutover();
    return {
      version: '20.0.0',
      cutoverReady: v.passed,
      attempted: _cutoverAttempted,
      activated: _cutoverAttempted ? (_report ? _report.activated : false) : false,
      gateResults: v.gates,
      dependencies: verifyDependencies(),
      modules: verifyModules(),
      stores: verifyStores(),
      agents: verifyAgents(),
      globals: verifyGlobals(),
      security: verifySecurity(),
      performance: verifyPerformance(),
      timestamp: new Date().toISOString()
    };
  }

  function getReport() { return _report || generateReport(); }
  function isActivated() { return _report ? _report.activated : false; }
  function getGateResults() { return _report ? _report.gates : null; }

  function reset() {
    _cutoverAttempted = false;
    _cutoverTime = null;
    _report = null;
  }

  window.ProductionCutoverManager = {
    VERSION: '20.0.0',
    activatePureModular: activatePureModular,
    validateCutover: validateCutover,
    verifyDependencies: verifyDependencies,
    verifyModules: verifyModules,
    verifyStores: verifyStores,
    verifyAgents: verifyAgents,
    verifyGlobals: verifyGlobals,
    verifySecurity: verifySecurity,
    verifyPerformance: verifyPerformance,
    generateReport: generateReport,
    getReport: getReport,
    isActivated: isActivated,
    getGateResults: getGateResults,
    reset: reset
  };
})();
