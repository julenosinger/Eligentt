/**
 * Elligentt PageController — Extracted Page Lifecycle Module (Phase 13.2)
 * Each page: initialize, render, refresh, destroy. Delegates to Domain + EventBus.
 * Example extraction pattern for swap, bridge, contacts pages.
 * Attached to: window.PageController
 */
(function () {
  'use strict';

  /**
   * Create a page controller for a specific page.
   * @param {Object} opts
   * @param {string} opts.pageId - e.g. 'swap', 'bridge', 'contacts'
   * @param {Function} opts.render - Render function (delegates to existing)
   * @param {Function} [opts.refresh] - Refresh function
   * @param {Function} [opts.onShow] - Called when page becomes active
   * @param {Function} [opts.onHide] - Called when page becomes inactive
   * @param {string[]} [opts.events] - EventBus events to subscribe to
   * @returns {Object} { initialize, render, refresh, destroy }
   */
  function create(opts) {
    var o = opts || {};
    var _init = false;
    var _subs = [];

    function initialize() {
      if (_init) return;
      _init = true;

      // Subscribe to page change events
      try {
        if (typeof EventBus !== 'undefined' && EventBus.on) {
          _subs.push(EventBus.on('PAGE_CHANGED', function (p) {
            if (p && p.page === o.pageId) { render(); }
          }));
        }
      } catch (_e) {}

      // Subscribe to custom events
      (o.events || []).forEach(function (evt) {
        try {
          if (typeof EventBus !== 'undefined' && EventBus.on) {
            _subs.push(EventBus.on(evt, function () { render(); }));
          }
        } catch (_e) {}
      });

      // Register with TabManager
      try {
        if (typeof TabManager !== 'undefined' && TabManager.register) {
          TabManager.register(o.pageId, { init: function () { if (o.onShow) o.onShow(); render(); } });
        }
      } catch (_e) {}
    }

    function render() {
      try {
        if (typeof o.render === 'function') o.render();
      } catch (e) {
        try { if (typeof ErrorHandler !== 'undefined') ErrorHandler.handle(e, { source: 'page.' + o.pageId, operation: 'render' }); } catch (_e) {}
      }
    }

    function refresh() {
      try {
        if (typeof o.refresh === 'function') o.refresh();
        else render();
      } catch (_e) {}
    }

    function destroy() {
      _subs.forEach(function (s) { try { s.off(); } catch (_e) {} });
      _subs = [];
      _init = false;
    }

    return {
      pageId: o.pageId,
      initialize: initialize,
      render: render,
      refresh: refresh,
      destroy: destroy
    };
  }

  /** @public */
  window.PageController = {
    VERSION: '1.0.0',
    create: create
  };

  /* ── Pre-built page controllers for extracted pages ──────────────── */

  // Swap page
  try {
    var SwapPage = PageController.create({
      pageId: 'swap',
      render: function () {
        try { if (typeof updateSwapRate === 'function') updateSwapRate(); } catch (_e) {}
        try { if (typeof renderSwapTokenList === 'function') renderSwapTokenList(); } catch (_e2) {}
      },
      refresh: function () {
        try { if (typeof CoreMigrate !== 'undefined') CoreMigrate.swap_refresh(); else if (typeof updateSwapRate === 'function') updateSwapRate(); } catch (_e) {}
      },
      events: ['BALANCE_REFRESHED']
    });
    window.SwapPage = SwapPage;
  } catch (_e) {}

  // Bridge page
  try {
    var BridgePage = PageController.create({
      pageId: 'bridge',
      render: function () {
        try { if (typeof updateBridgeEst === 'function') updateBridgeEst(); } catch (_e) {}
        try { if (typeof refreshBridgeBalances === 'function') refreshBridgeBalances(); } catch (_e2) {}
        try { if (typeof renderXcHistory === 'function') renderXcHistory(); } catch (_e3) {}
      },
      refresh: function () {
        try { if (typeof CoreMigrate !== 'undefined') CoreMigrate.bridge_refresh(); else if (typeof updateBridgeEst === 'function') updateBridgeEst(); } catch (_e) {}
      },
      events: ['BALANCE_REFRESHED', 'CHAIN_CHANGED']
    });
    window.BridgePage = BridgePage;
  } catch (_e2) {}

  // Contacts page
  try {
    var ContactsPage = PageController.create({
      pageId: 'contacts',
      render: function () {
        try { if (typeof Migrate !== 'undefined') Migrate.contacts_render(); else if (typeof renderContacts === 'function') renderContacts(); } catch (_e) {}
      },
      refresh: function () {
        try { if (typeof ContactsDomain !== 'undefined') ContactsDomain.refresh(); else if (typeof renderContacts === 'function') renderContacts(); } catch (_e) {}
      },
      events: []
    });
    window.ContactsPage = ContactsPage;
  } catch (_e3) {}
})();
