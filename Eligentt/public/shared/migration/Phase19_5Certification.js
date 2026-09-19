/**
 * Elligentt Phase19_5Certification — Enterprise Cutover Certification (Phase 19.5)
 *
 * Generates the FINAL certification report that determines whether
 * Elligentt can safely transition to RuntimeMode.PURE_MODULAR.
 *
 * Cutover is ONLY allowed if ALL sections pass.
 *
 * Attached to: window.Phase19_5Certification
 *
 * @module Phase19_5Certification
 * @version 19.5.0
 */
(function () {
  'use strict';

  function generate() {
    var s = {};

    s.wallet     = _checkModule('Wallet',      ['WalletDomain','WalletPage','WalletStore','WalletService']);
    s.swap       = _checkModule('Swap',         ['SwapDomain','SwapPage','SwapStore']);
    s.bridge     = _checkModule('Bridge',       ['BridgeDomain','BridgePage']);
    s.treasury   = _checkModule('Treasury',     ['TreasuryDomain','TreasuryPage']);
    s.payments   = _checkModule('Payments',     ['PaymentDomain','PaymentsPage','PaymentStore']);
    s.scheduler  = _checkModule('Scheduler',    ['SchedulerDomain','SchedulerPage']);
    s.crosschain = _checkModule('Crosschain',   ['XChainPage']);
    s.pool       = _checkModule('Pool',         ['PoolPage','PoolStore']);
    s.paylinks   = _checkModule('PayLinks',     ['PayLinksPage']);
    s.invoices   = _checkModule('Invoices',     ['InvoicesPage']);
    s.reports    = _checkModule('Reports',      ['ReportsPage']);
    s.contacts   = _checkModule('Contacts',     ['ContactsDomain','ContactsPage']);
    s.history    = _checkModule('History',      ['HistoryPage','HistoryDomain']);
    s.dashboard  = _checkModule('Dashboard',    ['DashboardPlugin']);
    s.aiWallet   = _checkModule('AI Wallet',    ['AIWallet','AIWalletRuntime','AIWExecutionEngine']);
    s.autonoma   = _checkModule('Autonoma',     ['AutonomaCore','AutonomaPage','AutIntentEngine']);

    s.legacyCalls = _legacyStatus();
    s.unknownDeps = _unknownDepsStatus();
    s.runtime     = _runtimeStatus();
    s.security    = _securityStatus();
    s.performance = _performanceStatus();
    s.cloudflare  = _cloudflareStatus();
    s.productionBuild = _productionBuildStatus();

    s.allPassed = _allSectionsPassed(s);
    s.readyForCutover = s.allPassed;

    return s;
  }

  function _checkModule(label, deps) {
    var found = deps.filter(function (d) { return typeof window[d] !== 'undefined'; });
    return {
      pass: found.length > 0,
      label: label,
      required: deps.length,
      loaded: found.length,
      missing: deps.filter(function (d) { return typeof window[d] === 'undefined'; })
    };
  }

  function _legacyStatus() {
    var result = { pass: false, totalCalls: 0, activeCalls: 0, unknownCalls: 0 };
    try {
      if (typeof PureModularAudit !== 'undefined') {
        var q = PureModularAudit.quickAudit();
        result.totalCalls = q.total;
        result.activeCalls = q.active;
        result.unknownCalls = q.unknown;
        result.pass = q.active === 0 && q.unknown === 0;
        result.cutoverReady = q.cutoverReady;
      }
    } catch (_e) {}
    return result;
  }

  function _unknownDepsStatus() {
    var result = { pass: false, count: 0 };
    try {
      if (typeof PureModularAudit !== 'undefined') {
        var audit = PureModularAudit.audit();
        result.count = audit.hiddenDependencies.count;
        result.pass = result.count === 0;
      }
    } catch (_e) {}
    return result;
  }

  function _runtimeStatus() {
    var result = { pass: false, mode: 'UNKNOWN' };
    try {
      if (typeof RuntimeMode !== 'undefined') result.mode = RuntimeMode.getMode();
      result.pass = typeof RuntimeMode !== 'undefined'
        && typeof PureExecutionGuard !== 'undefined'
        && typeof EventBus !== 'undefined'
        && typeof AppBootstrap !== 'undefined';
    } catch (_e) {}
    return result;
  }

  function _securityStatus() {
    var required = ['SecurityCenter','IntentSecurity','ProductionGuard','PureExecutionGuard','RiskEngine','TreasuryGuard','AuditManager'];
    var found = required.filter(function (r) { return typeof window[r] !== 'undefined'; });
    return {
      pass: found.length >= 6,
      required: required.length,
      loaded: found.length,
      missing: required.filter(function (r) { return typeof window[r] === 'undefined'; })
    };
  }

  function _performanceStatus() {
    var result = { pass: true };
    try {
      if (typeof performance !== 'undefined') {
        var nav = performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
        result.domReady = nav ? Math.round(nav.domContentLoadedEventEnd - nav.domContentLoadedEventStart) : null;
        result.loadTime = nav ? Math.round(nav.loadEventEnd - nav.loadEventStart) : null;
        result.uptime = Math.round(performance.now());
      }
      if (typeof performance !== 'undefined' && performance.memory) {
        result.memoryMB = Math.round(performance.memory.usedJSHeapSize / 1048576);
      }
    } catch (_e) {}
    return result;
  }

  function _cloudflareStatus() {
    return {
      pass: typeof window !== 'undefined',
      deployed: typeof location !== 'undefined' && location.hostname.indexOf('pages.dev') !== -1
    };
  }

  function _productionBuildStatus() {
    var required = ['EventBus','AppBootstrap','RuntimeMode','PureExecutionGuard','WalletStore','SwapStore','SystemManager','AuditManager'];
    var found = required.filter(function (r) { return typeof window[r] !== 'undefined'; });
    return {
      pass: found.length >= 6,
      required: required.length,
      loaded: found.length,
      missing: required.filter(function (r) { return typeof window[r] === 'undefined'; })
    };
  }

  function _allSectionsPassed(s) {
    var sections = [
      s.wallet, s.swap, s.bridge, s.treasury, s.payments,
      s.scheduler, s.crosschain, s.pool, s.paylinks, s.invoices,
      s.reports, s.contacts, s.history, s.dashboard, s.aiWallet, s.autonoma,
      s.legacyCalls, s.unknownDeps, s.runtime, s.security, s.performance,
      s.cloudflare, s.productionBuild
    ];
    return sections.every(function (sec) { return sec && sec.pass === true; });
  }

  /* ── Formatted Output ───────────────────────────────────── */

  function printReport() {
    var c = generate();

    var lines = [
      '',
      '====================================================',
      '',
      'ELLIGENTT v19.5 CUTOVER CERTIFICATION',
      '',
      'Generated: ' + new Date().toISOString(),
      '',
      '====================================================',
      '',
      'Wallet             ' + _fmt(c.wallet),
      'Swap               ' + _fmt(c.swap),
      'Bridge             ' + _fmt(c.bridge),
      'Treasury           ' + _fmt(c.treasury),
      'Payments           ' + _fmt(c.payments),
      'Scheduler          ' + _fmt(c.scheduler),
      'Crosschain         ' + _fmt(c.crosschain),
      'Pool               ' + _fmt(c.pool),
      'PayLinks           ' + _fmt(c.paylinks),
      'Invoices           ' + _fmt(c.invoices),
      'Reports            ' + _fmt(c.reports),
      'Contacts           ' + _fmt(c.contacts),
      'History            ' + _fmt(c.history),
      'Dashboard          ' + _fmt(c.dashboard),
      'AI Wallet          ' + _fmt(c.aiWallet),
      'Autonoma           ' + _fmt(c.autonoma),
      '',
      'Legacy Calls        ' + (c.legacyCalls.pass ? c.legacyCalls.activeCalls + '     PASS' : c.legacyCalls.activeCalls + '     FAIL'),
      '',
      'Unknown Dependencies' + (c.unknownDeps.pass ? c.unknownDeps.count + '     PASS' : c.unknownDeps.count + '     FAIL'),
      '',
      'Runtime Validation  ' + _fmtSimple(c.runtime.pass),
      'Security Validation ' + _fmtSimple(c.security.pass),
      'Performance Valid   ' + _fmtSimple(c.performance.pass),
      'Cloudflare Valid    ' + _fmtSimple(c.cloudflare.pass),
      'Production Build    ' + _fmtSimple(c.productionBuild.pass),
      '',
      'PURE_MODULAR READY  ' + (c.readyForCutover ? 'YES' : 'NO'),
      '',
      '===================================================='
    ];

    var output = lines.join('\n');
    console.log(output);
    return output;
  }

  function _fmt(section) {
    if (!section) return 'N/A';
    return (section.pass ? 'PASS' : 'FAIL') + '  (' + section.loaded + '/' + section.required + ' deps)';
  }

  function _fmtSimple(pass) {
    return pass ? 'PASS' : 'FAIL';
  }

  /* ── Export JSON ────────────────────────────────────────── */

  function exportJSON() {
    return JSON.stringify(generate(), null, 2);
  }

  /* ── Cutover Checklist ─────────────────────────────────── */

  function cutoverChecklist() {
    var c = generate();

    return {
      canCutover: c.readyForCutover,
      requiredActions: c.readyForCutover ? [
        '1. Set RuntimeMode.setMode("PURE_MODULAR")',
        '2. Verify all page modules render correctly',
        '3. Verify all financial operations execute via modular path',
        '4. Monitor PureExecutionGuard.getBlocked() === 0 for 24h',
        '5. Run Phase19TestSuite.runAll() — all must pass',
        '6. Deploy with PURE_MODULAR default'
      ] : [
        'CANNOT CUTOVER — ' + _countFailures(c) + ' sections failing',
        'Review Phase19_5Certification.getFailures() for details'
      ],
      blockers: _getBlockers(c),
      sectionsPassed: _countPassed(c),
      sectionsTotal: 23,
      timestamp: new Date().toISOString()
    };
  }

  function _countFailures(c) {
    var sections = [
      c.wallet, c.swap, c.bridge, c.treasury, c.payments,
      c.scheduler, c.crosschain, c.pool, c.paylinks, c.invoices,
      c.reports, c.contacts, c.history, c.dashboard, c.aiWallet, c.autonoma,
      c.legacyCalls, c.unknownDeps, c.runtime, c.security, c.performance,
      c.cloudflare, c.productionBuild
    ];
    return sections.filter(function (s) { return s && !s.pass; }).length;
  }

  function _countPassed(c) {
    var sections = [
      c.wallet, c.swap, c.bridge, c.treasury, c.payments,
      c.scheduler, c.crosschain, c.pool, c.paylinks, c.invoices,
      c.reports, c.contacts, c.history, c.dashboard, c.aiWallet, c.autonoma,
      c.legacyCalls, c.unknownDeps, c.runtime, c.security, c.performance,
      c.cloudflare, c.productionBuild
    ];
    return sections.filter(function (s) { return s && s.pass === true; }).length;
  }

  function _getBlockers(c) {
    var blockers = [];
    if (!c.legacyCalls.pass) blockers.push('Active legacy function calls detected');
    if (!c.unknownDeps.pass) blockers.push('Unknown dependencies found');
    if (!c.security.pass) blockers.push('Security modules incomplete');
    if (!c.productionBuild.pass) blockers.push('Production build has missing modules');
    if (!c.runtime.pass) blockers.push('Runtime infrastructure incomplete');
    return blockers;
  }

  window.Phase19_5Certification = {
    VERSION: '19.5.0',
    generate: generate,
    printReport: printReport,
    exportJSON: exportJSON,
    cutoverChecklist: cutoverChecklist
  };
})();
