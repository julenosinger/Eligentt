/**
 * Elligentt PageLoader — Lazy Page Loading System (Phase 16)
 * SwapPage, BridgePage, AIWalletPage, AutonomaPage load only when opened.
 * Attached to: window.PageLoader
 */
(function () {
  'use strict';
  var _loaded = {};
  var _pending = {};

  function load(pageId) {
    if (_loaded[pageId]) return Promise.resolve(true);
    if (_pending[pageId]) return _pending[pageId];

    _pending[pageId] = new Promise(function (resolve) {
      var mod = _resolveModule(pageId);
      if (!mod) { _loaded[pageId] = false; delete _pending[pageId]; resolve(false); return; }

      try {
        if (typeof mod.initialize === 'function') mod.initialize();
        _loaded[pageId] = true;
        delete _pending[pageId];
        try { if (typeof EventBus !== 'undefined') EventBus.emit('PAGE_LOADED', { page: pageId }); } catch (_e) {}
        resolve(true);
      } catch (e) {
        _loaded[pageId] = false;
        delete _pending[pageId];
        resolve(false);
      }
    });

    return _pending[pageId];
  }

  function _resolveModule(pageId) {
    var map = {
      swap: function () { return typeof SwapPage !== 'undefined' ? SwapPage : null; },
      bridge: function () { return typeof BridgePage !== 'undefined' ? BridgePage : null; },
      contacts: function () { return typeof ContactsPage !== 'undefined' ? ContactsPage : null; },
      reports: function () { return typeof ReportsPage !== 'undefined' ? ReportsPage : null; },
      history: function () { return typeof HistoryPage !== 'undefined' ? HistoryPage : null; },
      invoices: function () { return typeof InvoicesPage !== 'undefined' ? InvoicesPage : null; },
      treasury: function () { return typeof TreasuryPage !== 'undefined' ? TreasuryPage : null; },
      wallet: function () { return typeof WalletPage !== 'undefined' ? WalletPage : null; },
      payments: function () { return typeof PaymentsPage !== 'undefined' ? PaymentsPage : null; },
      scheduler: function () { return typeof SchedulerPage !== 'undefined' ? SchedulerPage : null; },
      xchain: function () { return typeof XChainPage !== 'undefined' ? XChainPage : null; },
      pool: function () { return typeof PoolPage !== 'undefined' ? PoolPage : null; },
      paylinks: function () { return typeof PayLinksPage !== 'undefined' ? PayLinksPage : null; },
      autonoma: function () { return typeof AutonomaPage !== 'undefined' ? AutonomaPage : null; },
      aiwallet: function () { return typeof AIWalletRuntime !== 'undefined' ? AIWalletRuntime : null; }
    };
    var resolver = map[pageId];
    return resolver ? resolver() : null;
  }

  function unload(pageId) {
    var mod = _resolveModule(pageId);
    if (mod && typeof mod.destroy === 'function') { try { mod.destroy(); } catch (_e) {} }
    _loaded[pageId] = false;
  }

  function isLoaded(pageId) { return !!_loaded[pageId]; }

  function getLoaded() { return Object.keys(_loaded).filter(function (k) { return _loaded[k]; }); }

  function getReport() {
    return {
      totalPages: 15,
      loaded: getLoaded().length,
      pending: Object.keys(_pending).length,
      loadedList: getLoaded()
    };
  }

  // Auto-load on page change
  try {
    if (typeof EventBus !== 'undefined' && EventBus.on) {
      EventBus.on('PAGE_CHANGED', function (p) {
        if (p && p.page) load(p.page);
      });
    }
  } catch (_e) {}

  window.PageLoader = {
    VERSION: '16.0.0',
    load: load, unload: unload, isLoaded: isLoaded,
    getLoaded: getLoaded, getReport: getReport
  };
})();
