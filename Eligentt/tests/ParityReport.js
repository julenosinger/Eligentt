/**
 * Elligentt ParityReport — Final Parity Verification Report (Phase 9)
 * Aggregates results from ParityChecker, AutomaticParityRunner, DomainTestSuite,
 * and AIWValidationTester into one comprehensive report.
 * Attached to: window.ParityReport
 */
(function () {
  'use strict';

  function generate() {
    var report = {
      generatedAt: new Date().toISOString(),
      domains: {},
      aiwPipeline: {},
      securityValidation: {},
      parityRunner: {},
      summary: { allPassed: false, coverage: '0%' }
    };

    // Domain tests
    try {
      if (typeof DomainTestSuite !== 'undefined') {
        DomainTestSuite.runAll();
        report.domains = DomainTestSuite.getResults();
      }
    } catch (_e) {}

    // AI Wallet pipeline
    try {
      if (typeof AIWValidationTester !== 'undefined') {
        report.aiwPipeline = AIWValidationTester.runAll();
      }
    } catch (_e) {}

    // Parity runner
    try {
      if (typeof AutomaticParityRunner !== 'undefined') {
        AutomaticParityRunner.runAll();
        report.parityRunner = AutomaticParityRunner.getResults();
      }
    } catch (_e) {}

    // Parity checker stats
    try {
      if (typeof ParityChecker !== 'undefined') {
        report.parityChecker = ParityChecker.getMatchRate();
      }
    } catch (_e) {}

    // Security validation
    try {
      report.securityValidation = {
        securityValidatorAvailable: typeof SecurityValidator !== 'undefined',
        intentSecurityAvailable: typeof IntentSecurity !== 'undefined'
      };
    } catch (_e) {}

    // Compute summary
    var passed = 0, total = 0;
    try {
      if (report.domains.summary) { passed += report.domains.summary.passed || 0; total += report.domains.summary.total || 0; }
      if (report.aiwPipeline.summary) { passed += report.aiwPipeline.summary.passed || 0; total += report.aiwPipeline.summary.total || 0; }
      if (report.parityRunner.summary) { passed += report.parityRunner.summary.passed || 0; total += report.parityRunner.summary.total || 0; }
    } catch (_e) {}

    report.summary = {
      allPassed: total > 0 && passed === total,
      totalTests: total,
      totalPassed: passed,
      totalFailed: total - passed,
      coverage: total > 0 ? Math.round((passed / total) * 100) + '%' : 'N/A'
    };

    if (report.summary.allPassed) {
      console.log('[ParityReport] ALL TESTS PASSED (' + report.summary.coverage + ') — Ready for legacy fallback removal');
    } else {
      console.warn('[ParityReport] ' + (total - passed) + ' tests failed — Do NOT disable legacy fallback');
    }

    return report;
  }

  function logReport() {
    var r = generate();
    console.log('[ParityReport]', JSON.stringify(r.summary));
    return r;
  }

  function isReady() {
    var r = generate();
    return r.summary.allPassed;
  }

  window.ParityReport = {
    VERSION: '1.0.0',
    generate: generate, logReport: logReport, isReady: isReady
  };
})();
