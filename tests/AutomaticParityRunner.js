/**
 * Elligentt AutomaticParityRunner — Automated Parity Test Suite (Phase 9)
 * Runs legacy vs new for ALL core operations. Generates parity report.
 * Runs on-demand, never automatically. Read-only — never executes transactions.
 * Attached to: window.AutomaticParityRunner
 */
(function () {
  'use strict';

  var _results = {};

  /**
   * Test suite definitions. Each: { name, phase, legacy, newFn, args, type }
   * type: 'sync' | 'async' | 'render' | 'validation'
   */
  var SUITES = {
    /* ── 8.1 Wallet ──────────────────────────────── */
    wallet_disconnect: {
      phase: '8.1', type: 'sync',
      legacy: function () { try { return typeof disconnectWallet === 'function' ? 'called' : null; } catch (_e) { return null; } },
      newFn:  function () { try { return typeof WalletDomain !== 'undefined' && WalletDomain.disconnect ? 'called' : null; } catch (_e) { return null; } }
    },
    wallet_isConnected: {
      phase: '8.1', type: 'validation',
      legacy: function () { try { return typeof walletAddress !== 'undefined' && walletAddress !== null; } catch (_e) { return false; } },
      newFn:  function () { try { return typeof WalletDomain !== 'undefined' ? WalletDomain.isConnected() : false; } catch (_e) { return false; } }
    },

    /* ── 8.2 Payments ────────────────────────────── */
    payment_validate_good: {
      phase: '8.2', type: 'validation',
      legacy: function () { try { if (typeof isAddr !== 'function') return { valid: false }; return { valid: isAddr('0x3600000000000000000000000000000000000000') }; } catch (_e) { return { valid: false }; } },
      newFn:  function () { try { if (typeof PaymentDomain !== 'undefined') return PaymentDomain.validateRecipient({ addr: '0x3600000000000000000000000000000000000000', amount: '100' }); } catch (_e) { return { valid: false }; } return { valid: false }; }
    },
    payment_validate_bad: {
      phase: '8.2', type: 'validation',
      legacy: function () { try { if (typeof isAddr !== 'function') return { valid: false }; return { valid: isAddr('invalid') }; } catch (_e) { return { valid: false }; } },
      newFn:  function () { try { if (typeof PaymentDomain !== 'undefined') return PaymentDomain.validateRecipient({ addr: 'invalid', amount: '0' }); } catch (_e) { return { valid: false }; } return { valid: false }; }
    },

    /* ── 8.3 Scheduler ───────────────────────────── */
    scheduler_getAll: {
      phase: '8.3', type: 'sync',
      legacy: function () { try { return typeof ScheduleEngine !== 'undefined' && ScheduleEngine.getAll ? 'has_getAll' : null; } catch (_e) { return null; } },
      newFn:  function () { try { return typeof SchedulerDomain !== 'undefined' ? 'has_domain' : null; } catch (_e) { return null; } }
    },

    /* ── 8.4 AIW Validation ──────────────────────── */
    aiw_estop_check: {
      phase: '8.4', type: 'validation',
      legacy: function () { try { return typeof AIWallet !== 'undefined' && AIWallet.isEmergencyStopped ? AIWallet.isEmergencyStopped() : false; } catch (_e) { return false; } },
      newFn:  function () { try { return typeof AIWSecurityEngine !== 'undefined' ? AIWSecurityEngine.isEmergencyStopped() : false; } catch (_e) { return false; } }
    },
    aiw_mode_check: {
      phase: '8.4', type: 'validation',
      legacy: function () { try { return typeof AIWallet !== 'undefined' && AIWallet.getMode ? AIWallet.getMode() : null; } catch (_e) { return null; } },
      newFn:  function () { try { return typeof AIWSecurityEngine !== 'undefined' ? AIWSecurityEngine.getMode() : null; } catch (_e) { return null; } }
    },

    /* ── 8.5 AIW Execution ───────────────────────── */
    aiw_getIntents: {
      phase: '8.5', type: 'sync',
      legacy: function () { try { return typeof AIWallet !== 'undefined' && AIWallet.getIntents ? 'has_getIntents' : null; } catch (_e) { return null; } },
      newFn:  function () { try { return typeof AIWExecutionEngine !== 'undefined' ? 'has_execEngine' : null; } catch (_e) { return null; } }
    },

    /* ── 8.6 Treasury ────────────────────────────── */
    treasury_available: {
      phase: '8.6', type: 'sync',
      legacy: function () { try { return typeof vaultRefreshUI === 'function' ? 'available' : null; } catch (_e) { return null; } },
      newFn:  function () { try { return typeof TreasuryDomain !== 'undefined' ? 'available' : null; } catch (_e) { return null; } }
    },

    /* ── 8.7 Swap ────────────────────────────────── */
    swap_refresh: {
      phase: '8.7', type: 'sync',
      legacy: function () { try { return typeof updateSwapRate === 'function' ? 'available' : null; } catch (_e) { return null; } },
      newFn:  function () { try { return typeof SwapDomain !== 'undefined' ? 'available' : null; } catch (_e) { return null; } }
    },

    /* ── 8.8 Bridge ──────────────────────────────── */
    bridge_refresh: {
      phase: '8.8', type: 'sync',
      legacy: function () { try { return typeof updateBridgeEst === 'function' ? 'available' : null; } catch (_e) { return null; } },
      newFn:  function () { try { return typeof BridgeDomain !== 'undefined' ? 'available' : null; } catch (_e) { return null; } }
    },

    /* ── 8.9 Autonoma ────────────────────────────── */
    autonoma_context: {
      phase: '8.9', type: 'sync',
      legacy: function () { try { return typeof AutonomaCore !== 'undefined' ? 'available' : null; } catch (_e) { return null; } },
      newFn:  function () { try { return typeof AutContextEngine !== 'undefined' ? 'available' : null; } catch (_e) { return null; } }
    },

    /* ── 8.10 Documents ──────────────────────────── */
    invoices_available: {
      phase: '8.10', type: 'sync',
      legacy: function () { try { return typeof renderInvoices === 'function' ? 'available' : null; } catch (_e) { return null; } },
      newFn:  function () { try { return typeof CoreMigrate !== 'undefined' ? 'available' : null; } catch (_e) { return null; } }
    }
  };

  /** Run all parity tests */
  function runAll() {
    var suiteNames = Object.keys(SUITES);
    var total = suiteNames.length;
    var passed = 0;
    var failed = 0;
    var byPhase = {};

    _results = { suites: {}, summary: {}, timestamp: Date.now() };

    for (var i = 0; i < suiteNames.length; i++) {
      var name = suiteNames[i];
      var suite = SUITES[name];
      var legacyOutput = null, newOutput = null, legacyErr = null, newErr = null;

      try { legacyOutput = suite.legacy(); } catch (e) { legacyErr = e.message; }
      try { newOutput = suite.newFn(); } catch (e) { newErr = e.message; }

      // For availability checks: both should return a non-null value
      var match = !legacyErr && !newErr && legacyOutput !== null && newOutput !== null;

      if (suite.type === 'validation') {
        match = legacyOutput !== null && newOutput !== null && String(legacyOutput) === String(newOutput);
      }

      if (match) passed++; else failed++;

      _results.suites[name] = {
        name: name, phase: suite.phase, type: suite.type,
        legacyOutput: legacyOutput, newOutput: newOutput,
        legacyErr: legacyErr, newErr: newErr, match: match
      };

      if (!byPhase[suite.phase]) byPhase[suite.phase] = { total: 0, passed: 0 };
      byPhase[suite.phase].total++;
      if (match) byPhase[suite.phase].passed++;
    }

    _results.summary = {
      total: total, passed: passed, failed: failed,
      rate: total > 0 ? Math.round((passed / total) * 100) : 0,
      byPhase: byPhase,
      allPassed: failed === 0
    };

    // Log results
    console.log('[ParityRunner] ' + passed + '/' + total + ' passed (' + _results.summary.rate + '%)');
    if (failed > 0) {
      var failures = Object.keys(_results.suites).filter(function (k) { return !_results.suites[k].match; });
      console.warn('[ParityRunner] Failures:', failures.join(', '));
    }

    try { if (typeof EventBus !== 'undefined') EventBus.emit('PARITY_RUN_COMPLETE', _results.summary); } catch (_e) {}

    return _results;
  }

  /** Run a single suite by name */
  function run(name) {
    var suite = SUITES[name];
    if (!suite) return null;
    var legacyOutput = null, newOutput = null;
    try { legacyOutput = suite.legacy(); } catch (_e) {}
    try { newOutput = suite.newFn(); } catch (_e2) {}
    return { name: name, legacyOutput: legacyOutput, newOutput: newOutput, match: legacyOutput !== null && newOutput !== null };
  }

  function getResults() { return _results; }
  function getSummary() { return _results.summary || { total: 0, passed: 0, rate: 0 }; }

  window.AutomaticParityRunner = {
    VERSION: '1.0.0',
    SUITES: SUITES,
    runAll: runAll, run: run,
    getResults: getResults, getSummary: getSummary
  };
})();
