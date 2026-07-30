/**
 * Elligentt DomainTestSuite — Unit Tests for All 10 Domains (Phase 9)
 * Tests: availability, initialization, API methods, edge cases.
 * Read-only. Never executes transactions.
 * Attached to: window.DomainTestSuite
 */
(function () {
  'use strict';

  var _results = {};

  function runAll() {
    _results = { domains: {}, summary: {}, timestamp: Date.now() };
    var total = 0, passed = 0;

    // WalletDomain
    var wallet = _testDomain('WalletDomain', function () {
      return typeof WalletDomain !== 'undefined' && typeof WalletDomain.isConnected === 'function';
    }, [
      { name: 'getAddress', fn: function () { try { var a = WalletDomain.getAddress(); return a === null || typeof a === 'string'; } catch (_e) { return false; } } },
      { name: 'getChainId', fn: function () { try { var c = WalletDomain.getChainId(); return typeof c === 'number'; } catch (_e) { return false; } } },
      { name: 'isConnected', fn: function () { try { return typeof WalletDomain.isConnected() === 'boolean'; } catch (_e) { return false; } } }
    ]);

    // PaymentDomain
    var payments = _testDomain('PaymentDomain', function () {
      return typeof PaymentDomain !== 'undefined' && typeof PaymentDomain.validateRecipient === 'function';
    }, [
      { name: 'validate_good_addr', fn: function () { try { var r = PaymentDomain.validateRecipient({ addr: '0x3600000000000000000000000000000000000000', amount: '100' }); return r && r.valid; } catch (_e) { return false; } } },
      { name: 'validate_bad_addr', fn: function () { try { var r = PaymentDomain.validateRecipient({ addr: 'invalid', amount: '0' }); return r && !r.valid; } catch (_e) { return false; } } }
    ]);

    // SchedulerDomain
    var scheduler = _testDomain('SchedulerDomain', function () {
      return typeof SchedulerDomain !== 'undefined' && typeof SchedulerDomain.getAll === 'function';
    }, [
      { name: 'getAll_returns_array', fn: function () { try { return Array.isArray(SchedulerDomain.getAll()); } catch (_e) { return false; } } },
      { name: 'validate_valid', fn: function () { try { var r = SchedulerDomain.validate({ type: 'payment', amount: 100 }); return r && r.valid; } catch (_e) { return false; } } },
      { name: 'validate_invalid', fn: function () { try { var r = SchedulerDomain.validate({}); return r && !r.valid; } catch (_e) { return false; } } }
    ]);

    // TreasuryDomain
    var treasury = _testDomain('TreasuryDomain', function () {
      return typeof TreasuryDomain !== 'undefined' && typeof TreasuryDomain.getVaultBalance === 'function';
    }, [
      { name: 'getVaultBalance', fn: function () { try { return TreasuryDomain.getVaultBalance() !== undefined; } catch (_e) { return false; } } }
    ]);

    // SwapDomain
    var swap = _testDomain('SwapDomain', function () {
      return typeof SwapDomain !== 'undefined' && typeof SwapDomain.validate === 'function';
    }, [
      { name: 'validate_missing_amount', fn: function () { try { var r = SwapDomain.validate({ fromToken: 'USDC', toToken: 'EURC' }); return r && !r.valid; } catch (_e) { return false; } } },
      { name: 'validate_same_token', fn: function () { try { var r = SwapDomain.validate({ amount: 100, fromToken: 'USDC', toToken: 'USDC' }); return r && !r.valid; } catch (_e) { return false; } } }
    ]);

    // BridgeDomain
    var bridge = _testDomain('BridgeDomain', function () {
      return typeof BridgeDomain !== 'undefined' && typeof BridgeDomain.validate === 'function';
    }, [
      { name: 'validate_missing_from', fn: function () { try { var r = BridgeDomain.validate({ amount: 100, toChain: 'Base_Sepolia' }); return r && !r.valid; } catch (_e) { return false; } } },
      { name: 'validate_same_chain', fn: function () { try { var r = BridgeDomain.validate({ amount: 100, fromChain: 'Arc_Testnet', toChain: 'Arc_Testnet' }); return r && !r.valid; } catch (_e) { return false; } } }
    ]);

    // ContactsDomain
    var contacts = _testDomain('ContactsDomain', function () {
      return typeof ContactsDomain !== 'undefined' && typeof ContactsDomain.getAll === 'function';
    }, [
      { name: 'getAll_returns_array', fn: function () { try { return Array.isArray(ContactsDomain.getAll()); } catch (_e) { return false; } } },
      { name: 'search_empty_query', fn: function () { try { return Array.isArray(ContactsDomain.search('')); } catch (_e) { return false; } } }
    ]);

    // ReportsDomain
    var reports = _testDomain('ReportsDomain', function () {
      return typeof ReportsDomain !== 'undefined' && typeof ReportsDomain.getMetrics === 'function';
    }, [
      { name: 'getMetrics', fn: function () { try { var m = ReportsDomain.getMetrics(30); return m && typeof m.totalSent === 'number'; } catch (_e) { return false; } } }
    ]);

    // HistoryDomain
    var history = _testDomain('HistoryDomain', function () {
      return typeof HistoryDomain !== 'undefined' && typeof HistoryDomain.getAll === 'function';
    }, [
      { name: 'getAll_returns_array', fn: function () { try { return Array.isArray(HistoryDomain.getAll()); } catch (_e) { return false; } } },
      { name: 'getPaged', fn: function () { try { var p = HistoryDomain.getPaged(0, 20); return p && typeof p.total === 'number' && Array.isArray(p.items); } catch (_e) { return false; } } }
    ]);

    // NotificationDomain
    var notifications = _testDomain('NotificationDomain', function () {
      return typeof NotificationDomain !== 'undefined' && typeof NotificationDomain.info === 'function';
    }, [
      { name: 'info_method_exists', fn: function () { try { NotificationDomain.info('test'); return true; } catch (_e) { return false; } } }
    ]);

    var domainResults = [wallet, payments, scheduler, treasury, swap, bridge, contacts, reports, history, notifications];
    domainResults.forEach(function (d) {
      _results.domains[d.name] = d;
      total += d.tests.length;
      passed += d.passed;
    });
    _results.summary = { total: total, passed: passed, failed: total - passed, rate: total > 0 ? Math.round((passed / total) * 100) : 0, domains: domainResults.length };

    console.log('[DomainTestSuite] ' + passed + '/' + total + ' tests passed (' + _results.summary.rate + '%)');
    if (typeof EventBus !== 'undefined') EventBus.emit('DOMAIN_TESTS_COMPLETE', _results.summary);
    return _results;
  }

  function _testDomain(name, checkAvailable, tests) {
    var available = false;
    try { available = checkAvailable(); } catch (_e) {}
    var testResults = [];
    var passed = 0;
    tests.forEach(function (t) {
      var ok = false;
      try { ok = t.fn(); } catch (_e) {}
      testResults.push({ name: t.name, passed: ok });
      if (ok) passed++;
    });
    return { name: name, available: available, tests: testResults, total: tests.length, passed: passed, failed: tests.length - passed };
  }

  function getResults() { return _results; }

  window.DomainTestSuite = {
    VERSION: '1.0.0',
    runAll: runAll, getResults: getResults
  };
})();
