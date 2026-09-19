/**
 * Elligentt GlobalRegistry — Centralized Module Registry with Deprecation (Phase 16)
 * Migrates window.* globals to a central registry. Tracks deprecated access.
 * Attached to: window.GlobalRegistry
 */
(function () {
  'use strict';
  var _registry = {};
  var _deprecated = {};
  var _accessCount = {};

  function register(name, module, opts) {
    var o = opts || {};
    _registry[name] = module;
    if (o.deprecated) _deprecated[name] = { message: o.deprecated, replacement: o.replacement || '' };
    _accessCount[name] = 0;
  }

  function get(name) {
    _accessCount[name] = (_accessCount[name] || 0) + 1;
    if (_deprecated[name]) {
      try { if (typeof ProductionGuard !== 'undefined') ProductionGuard.warn('GlobalRegistry: ' + name + ' is deprecated — ' + _deprecated[name].message); } catch (_e) {}
    }
    return _registry[name] || null;
  }

  function isDeprecated(name) { return !!_deprecated[name]; }
  function getDeprecated() { return Object.keys(_deprecated); }
  function getAccessCount(name) { return _accessCount[name] || 0; }
  function getAllRegistered() { return Object.keys(_registry); }
  function getReport() {
    return {
      totalRegistered: Object.keys(_registry).length,
      deprecated: getDeprecated().length,
      mostAccessed: Object.entries(_accessCount).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 10)
    };
  }

  // Register known modules
  try {
    register('EventBus', typeof EventBus !== 'undefined' ? EventBus : null);
    register('AppBootstrap', typeof AppBootstrap !== 'undefined' ? AppBootstrap : null);
    register('AIWallet', typeof AIWallet !== 'undefined' ? AIWallet : null, { deprecated: 'Use AIWalletRuntime', replacement: 'AIWalletRuntime' });
    register('AIWalletRuntime', typeof AIWalletRuntime !== 'undefined' ? AIWalletRuntime : null);
    register('AutonomaCore', typeof AutonomaCore !== 'undefined' ? AutonomaCore : null);
    register('AutonomaPage', typeof AutonomaPage !== 'undefined' ? AutonomaPage : null);
    register('ContactsPage', typeof ContactsPage !== 'undefined' ? ContactsPage : null);
    register('SwapPage', typeof SwapPage !== 'undefined' ? SwapPage : null);
    register('BridgePage', typeof BridgePage !== 'undefined' ? BridgePage : null);
    register('WalletPage', typeof WalletPage !== 'undefined' ? WalletPage : null);
    register('PaymentsPage', typeof PaymentsPage !== 'undefined' ? PaymentsPage : null);
  } catch (_e) {}

  window.GlobalRegistry = {
    VERSION: '16.0.0',
    register: register, get: get, isDeprecated: isDeprecated,
    getDeprecated: getDeprecated, getAccessCount: getAccessCount,
    getAllRegistered: getAllRegistered, getReport: getReport
  };
})();
