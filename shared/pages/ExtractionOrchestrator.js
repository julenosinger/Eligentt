/**
 * ExtractionOrchestrator — Coordinates All Extracted Page Modules (Phase 14)
 * Initializes all 16 page modules. Tracks extraction progress.
 * Attached to: window.ExtractionOrchestrator
 */
(function () {
  'use strict';

  var _registry = [
    { id: 'contacts',  mod: null, risk: 'low' },
    { id: 'reports',   mod: null, risk: 'low' },
    { id: 'history',   mod: null, risk: 'low' },
    { id: 'invoices',  mod: null, risk: 'low' },
    { id: 'swap',      mod: null, risk: 'medium' },
    { id: 'treasury',  mod: null, risk: 'medium' },
    { id: 'bridge',    mod: null, risk: 'high' },
    { id: 'wallet',    mod: null, risk: 'high' },
    { id: 'payments',  mod: null, risk: 'high' },
    { id: 'scheduler', mod: null, risk: 'high' }
  ];

  var MODULE_MAP = {
    contacts:  function () { return typeof ContactsPage !== 'undefined' ? ContactsPage : null; },
    reports:   function () { return typeof ReportsPage !== 'undefined' ? ReportsPage : null; },
    history:   function () { return typeof HistoryPage !== 'undefined' ? HistoryPage : null; },
    invoices:  function () { return typeof InvoicesPage !== 'undefined' ? InvoicesPage : null; },
    swap:      function () { return typeof SwapPage !== 'undefined' ? SwapPage : null; },
    treasury:  function () { return typeof TreasuryPage !== 'undefined' ? TreasuryPage : null; },
    bridge:    function () { return typeof BridgePage !== 'undefined' ? BridgePage : null; },
    wallet:    function () { return typeof WalletPage !== 'undefined' ? WalletPage : null; },
    payments:  function () { return typeof PaymentsPage !== 'undefined' ? PaymentsPage : null; },
    scheduler: function () { return typeof SchedulerPage !== 'undefined' ? SchedulerPage : null; }
  };

  function initializeAll() {
    var ok = 0, failed = 0;
    for (var i = 0; i < _registry.length; i++) {
      var entry = _registry[i];
      var resolver = MODULE_MAP[entry.id];
      if (!resolver) { failed++; continue; }
      var mod = resolver();
      entry.mod = mod;
      if (!mod || typeof mod.initialize !== 'function') { failed++; continue; }
      try { mod.initialize(); ok++; } catch (e) { console.warn('[ExtractionOrchestrator] Init failed: ' + entry.id); failed++; }
    }
    console.log('[ExtractionOrchestrator] ' + ok + '/' + _registry.length + ' page modules initialized (' + failed + ' skipped)');
    return { initialized: ok, failed: failed };
  }

  function getReport() {
    return {
      totalPages: _registry.length,
      extracted: _registry.filter(function (r) { return !!r.mod; }).length,
      lowRisk: _registry.filter(function (r) { return r.risk === 'low' && !!r.mod; }).length,
      mediumRisk: _registry.filter(function (r) { return r.risk === 'medium' && !!r.mod; }).length,
      highRisk: _registry.filter(function (r) { return r.risk === 'high' && !!r.mod; }).length,
      extractPercent: _registry.length > 0 ? Math.round((_registry.filter(function (r) { return !!r.mod; }).length / _registry.length) * 100) : 0
    };
  }

  function destroy() {
    _registry.forEach(function (r) { try { if (r.mod && typeof r.mod.destroy === 'function') r.mod.destroy(); } catch (_e) {} r.mod = null; });
  }

  try { if (typeof EventBus !== 'undefined' && EventBus.on) EventBus.on('APP_BOOT_COMPLETE', initializeAll); } catch (_e) {}

  window.ExtractionOrchestrator = {
    VERSION: '14.0.0',
    initializeAll: initializeAll, getReport: getReport, destroy: destroy
  };
})();
