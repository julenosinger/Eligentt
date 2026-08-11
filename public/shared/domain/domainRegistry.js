/**
 * Elligentt DomainRegistry — Centralized Domain Service Orchestrator (Phase 3)
 *
 * Initializes all domain services in dependency order.
 * Provides unified public API. Hooks into AppBootstrap lifecycle.
 * Contains ZERO business logic. Only orchestration.
 *
 * Attached to: window.DomainRegistry
 *
 * @module domainRegistry
 * @version 1.0.0
 */
(function () {
  'use strict';

  var _initialized = false;

  /** Ordered list of domain services */
  var _domains = [
    { name: 'wallet',        mod: null, api: null, init: 'initialize', refresh: 'refresh', destroy: 'destroy' },
    { name: 'payments',      mod: null, api: null, init: 'initialize', refresh: 'refresh', destroy: 'destroy' },
    { name: 'swap',          mod: null, api: null, init: 'initialize', refresh: 'refresh', destroy: 'destroy' },
    { name: 'bridge',        mod: null, api: null, init: 'initialize', refresh: 'refresh', destroy: 'destroy' },
    { name: 'treasury',      mod: null, api: null, init: 'initialize', refresh: 'refresh', destroy: 'destroy' },
    { name: 'scheduler',     mod: null, api: null, init: 'initialize', refresh: 'refresh', destroy: 'destroy' },
    { name: 'contacts',      mod: null, api: null, init: 'initialize', refresh: 'refresh', destroy: 'destroy' },
    { name: 'reports',       mod: null, api: null, init: 'initialize', refresh: 'refresh', destroy: 'destroy' },
    { name: 'history',       mod: null, api: null, init: 'initialize', refresh: 'refresh', destroy: 'destroy' },
    { name: 'notifications', mod: null, api: null, init: 'initialize', refresh: 'refresh', destroy: 'destroy' },
    { name: 'autonoma',      mod: null, api: null, init: 'initialize', refresh: 'refresh', destroy: 'destroy' },
    { name: 'aiwallet',      mod: null, api: null, init: 'initialize', refresh: 'refresh', destroy: 'destroy' }
  ];

  var DOMAIN_API_MAP = {
    wallet:        function () { return typeof WalletDomain !== 'undefined' ? WalletDomain : null; },
    payments:      function () { return typeof PaymentDomain !== 'undefined' ? PaymentDomain : null; },
    swap:          function () { return typeof SwapDomain !== 'undefined' ? SwapDomain : null; },
    bridge:        function () { return typeof BridgeDomain !== 'undefined' ? BridgeDomain : null; },
    treasury:      function () { return typeof TreasuryDomain !== 'undefined' ? TreasuryDomain : null; },
    scheduler:     function () { return typeof SchedulerDomain !== 'undefined' ? SchedulerDomain : null; },
    contacts:      function () { return typeof ContactsDomain !== 'undefined' ? ContactsDomain : null; },
    reports:       function () { return typeof ReportsDomain !== 'undefined' ? ReportsDomain : null; },
    history:       function () { return typeof HistoryDomain !== 'undefined' ? HistoryDomain : null; },
    notifications: function () { return typeof NotificationDomain !== 'undefined' ? NotificationDomain : null; },
    autonoma:      function () { return typeof AutonomaAdapter !== 'undefined' ? AutonomaAdapter : null; },
    aiwallet:      function () { return typeof AIWalletAdapter !== 'undefined' ? AIWalletAdapter : null; }
  };

  /** Initialize all domain services */
  function initialize() {
    if (_initialized) return;
    _initialized = true;

    var ok = 0, failed = 0;
    for (var i = 0; i < _domains.length; i++) {
      var entry = _domains[i];
      var resolver = DOMAIN_API_MAP[entry.name];
      if (!resolver) { failed++; continue; }
      var mod = resolver();
      entry.mod = mod;
      entry.api = mod;
      if (!mod || typeof mod[entry.init] !== 'function') { failed++; continue; }
      try { mod[entry.init](); ok++; } catch (e) { console.warn('[DomainRegistry] Init failed: ' + entry.name, e.message); failed++; }
    }
    console.log('[DomainRegistry] Initialized ' + ok + '/' + _domains.length + ' domains (' + failed + ' skipped)');
  }

  /** Refresh all domains */
  function refreshAll() {
    for (var i = 0; i < _domains.length; i++) {
      var entry = _domains[i];
      var mod = entry.mod;
      if (!mod || typeof mod[entry.refresh] !== 'function') continue;
      try { mod[entry.refresh](); } catch (_e) {}
    }
  }

  /** Get a domain by name */
  function get(name) {
    var resolver = DOMAIN_API_MAP[name];
    return resolver ? resolver() : null;
  }

  /** Destroy all domains */
  function destroy() {
    for (var i = _domains.length - 1; i >= 0; i--) {
      var entry = _domains[i];
      var mod = entry.mod;
      if (!mod || typeof mod[entry.destroy] !== 'function') continue;
      try { mod[entry.destroy](); } catch (_e) {}
      entry.mod = null; entry.api = null;
    }
    _initialized = false;
  }

  function getReport() {
    return _domains.map(function (d) { return { name: d.name, initialized: !!d.mod }; });
  }

  // Hook into AppBootstrap
  try {
    if (typeof EventBus !== 'undefined' && EventBus.on) {
      EventBus.on('APP_BOOT_COMPLETE', function () { initialize(); });
    }
  } catch (_e) {}

  /** @public */
  window.DomainRegistry = {
    VERSION: '1.0.0',
    initialize: initialize, refreshAll: refreshAll, get: get,
    destroy: destroy, getReport: getReport
  };

  /* ════════════════════════════════════════
     LEGACY COMPATIBILITY WRAPPERS
     Ensures ALL existing global calls continue working.
  ════════════════════════════════════════ */

  // These DO NOT replace any existing function.
  // They only provide alternative access paths via DomainRegistry.
  // Original globals remain untouched and fully functional.

  // Examples for future migration:
  // Old: executeSwap(amount, from, to)
  // New: DomainRegistry.get('swap').execute(amount, from, to)
  //
  // Old: createSchedule(params)
  // New: DomainRegistry.get('scheduler').create(params)
  //
  // Old: renderContacts()
  // New: DomainRegistry.get('contacts').refresh()

  console.log('[DomainRegistry] Phase 3 domain layer initialized. Legacy globals preserved.');
})();
