/**
 * Elligentt MigrationReport — Complete Migration Coverage Report (Phase 8)
 * Generates comprehensive migration status: functions migrated, parity results,
 * flags enabled, coverage %, remaining work.
 * Attached to: window.MigrationReport
 */
(function () {
  'use strict';

  /** Generate complete migration report */
  function generate() {
    var report = {
      generatedAt: new Date().toISOString(),
      coverage: {},
      flags: {},
      parity: {},
      legacy: {},
      corePhases: {},
      remaining: [],
      estimatedPercent: 0
    };

    // Coverage from LegacyTracker
    try { if (typeof LegacyTracker !== 'undefined') report.coverage = LegacyTracker.getCoverage(); } catch (_e) {}

    // Flags from MigrationFlags
    try { if (typeof MigrationFlags !== 'undefined') {
      report.flags.enabled = MigrationFlags.getEnabled();
      report.flags.disabled = MigrationFlags.getDisabled();
      report.flags.total = report.flags.enabled.length + report.flags.disabled.length;
    }} catch (_e) {}

    // Parity from ParityChecker
    try { if (typeof ParityChecker !== 'undefined') report.parity = ParityChecker.getMatchRate(); } catch (_e) {}

    // Core phase status
    report.corePhases = {
      '8.1_wallet':    _status('USE_WALLET_DOMAIN'),
      '8.2_payments':  _status('USE_PAYMENT_DOMAIN'),
      '8.3_scheduler': _status('USE_SCHEDULER_DOMAIN'),
      '8.4_aiw_validation': _status('USE_AIW_VALIDATION_ENGINE'),
      '8.5_aiw_execution':  _status('USE_AIW_EXECUTION_ENGINE'),
      '8.6_treasury':  _status('USE_TREASURY_DOMAIN'),
      '8.7_swap':      _status('USE_SWAP_DOMAIN'),
      '8.8_bridge':    _status('USE_BRIDGE_DOMAIN'),
      '8.9_autonoma':  _status('USE_AUT_INTENT_ENGINE'),
      '8.10_docs':     'available'
    };

    // Remaining work
    report.remaining = _getRemaining();

    // Estimate
    var totalFlags = report.flags.total || 25;
    var enabled = report.flags.enabled ? report.flags.enabled.length : 0;
    report.estimatedPercent = Math.round((enabled / Math.max(totalFlags, 1)) * 100);

    return report;
  }

  function _status(flag) {
    try { if (typeof MigrationFlags !== 'undefined') return MigrationFlags.isEnabled(flag) ? 'new_active' : 'pending'; } catch (_e) {}
    return 'pending';
  }

  function _getRemaining() {
    return [
      '8.1: Enable USE_WALLET_DOMAIN after parity verification',
      '8.2: Enable USE_PAYMENT_DOMAIN after recipient validation parity',
      '8.3: Enable USE_SCHEDULER_DOMAIN after schedule CRUD parity',
      '8.4: Enable USE_AIW_VALIDATION_ENGINE after 13-stage pipeline parity',
      '8.5: Enable USE_AIW_EXECUTION_ENGINE after intent lifecycle parity',
      '8.6: Enable USE_TREASURY_DOMAIN after vault allocation parity',
      '8.7: Enable USE_SWAP_DOMAIN after swap quote+exec parity',
      '8.8: Enable USE_BRIDGE_DOMAIN after CCTP turbo parity',
      '8.9: Enable USE_AUT_INTENT_ENGINE after NLU output parity',
      'Split aiSmartWallet.js (3,311 lines) into engine files',
      'Split index.html inline JS (45,710 lines) into per-page modules',
      'Add unit tests for all domain services',
      'Add integration tests for AI Wallet validation pipeline',
      'Extract inline CSS to external stylesheet'
    ];
  }

  function logReport() {
    var r = generate();
    console.log('[MigrationReport]', JSON.stringify(r, null, 2));
    return r;
  }

  /** Get simple summary for console */
  function summary() {
    var r = generate();
    return {
      coverage: r.coverage.percent + '%',
      flagsEnabled: r.flags.enabled ? r.flags.enabled.length : 0,
      parityRate: r.parity.rate !== undefined ? r.parity.rate + '%' : 'N/A',
      corePhasesActive: Object.values(r.corePhases).filter(function (v) { return v === 'new_active'; }).length + '/10',
      estimatedMigration: r.estimatedPercent + '%'
    };
  }

  window.MigrationReport = {
    VERSION: '1.0.0',
    generate: generate, logReport: logReport, summary: summary
  };
})();
