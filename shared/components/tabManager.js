/**
 * Elligentt TabManager — Centralized Tab/Page Navigation System (Phase 1 Architecture)
 *
 * Wraps existing showPage() function. Does NOT change navigation behavior.
 * Provides structured API for future consumers. Keeps current tab system fully compatible.
 *
 * Delegates to existing showPage() for rendering. Emits through EventBus for future decoupling.
 *
 * Attached to: window.TabManager
 *
 * @module tabManager
 * @version 1.0.0
 */
(function () {
  'use strict';

  /** @type {Record<string, { init: Function|null, destroy: Function|null, lazyModules: string[] }>} */
  var _registry = {};

  /* ════════════════════════════════════════════
     REGISTRATION
  ════════════════════════════════════════════ */

  /**
   * Register a tab/page with optional init/destroy hooks.
   * Hooks are called when the tab becomes active/inactive.
   *
   * @param {string} tabId - e.g. 'send', 'swap', 'autonoma'
   * @param {Object} [opts]
   * @param {Function} [opts.init] - Called when tab becomes active
   * @param {Function} [opts.destroy] - Called when tab is navigated away from
   * @param {string[]} [opts.lazyModules] - Modules to lazy-load for this tab
   */
  function register(tabId, opts) {
    var o = opts || {};
    _registry[tabId] = {
      init: typeof o.init === 'function' ? o.init : null,
      destroy: typeof o.destroy === 'function' ? o.destroy : null,
      lazyModules: Array.isArray(o.lazyModules) ? o.lazyModules : []
    };
  }

  /**
   * Unregister a tab.
   * @param {string} tabId
   */
  function unregister(tabId) {
    delete _registry[tabId];
  }

  /* ════════════════════════════════════════════
     NAVIGATION — delegates to showPage()
  ════════════════════════════════════════════ */

  /**
   * Navigate to a page/tab. Delegates to existing showPage().
   *
   * @param {string} pageId - e.g. 'send', 'swap', 'bridge', 'autonoma'
   * @emits TAB_CHANGED
   */
  function activate(pageId) {
    var prev = _getActivePage();

    // Call destroy hook on previous tab
    if (prev && _registry[prev] && _registry[prev].destroy) {
      try { _registry[prev].destroy(); } catch (_e) {}
    }

    // Navigate via existing showPage
    try {
      if (typeof showPage === 'function') {
        showPage(pageId);
      }
    } catch (_e2) { /* ignore */ }

    // Update UIStore
    try {
      if (typeof UIStore !== 'undefined' && UIStore.setActivePage) {
        UIStore.setActivePage(pageId);
      }
    } catch (_e3) {}

    // Call init hook on new tab
    if (_registry[pageId] && _registry[pageId].init) {
      try { _registry[pageId].init(); } catch (_e4) {}
    }

    // Emit event
    try {
      if (typeof EventBus !== 'undefined' && EventBus.emit) {
        EventBus.emit('TAB_CHANGED', { page: pageId, previous: prev });
      }
    } catch (_e5) {}
  }

  /**
   * Navigate to a page (alias for activate).
   * @param {string} pageId
   */
  function go(pageId) { activate(pageId); }

  /* ════════════════════════════════════════════
     QUERIES
  ════════════════════════════════════════════ */

  /**
   * Get the currently active page ID.
   * @returns {string}
   */
  function getActivePage() { return _getActivePage(); }

  function _getActivePage() {
    try {
      if (typeof UIStore !== 'undefined' && UIStore.getActivePage) {
        var p = UIStore.getActivePage();
        if (p) return p;
      }
    } catch (_e) {}
    try {
      var saved = localStorage.getItem('elligente_current_page');
      return saved || 'send';
    } catch (_e2) { return 'send'; }
  }

  /**
   * Get all registered tab IDs.
   * @returns {string[]}
   */
  function getRegistered() {
    return Object.keys(_registry);
  }

  /**
   * Check if a tab is registered.
   * @param {string} tabId
   * @returns {boolean}
   */
  function isRegistered(tabId) {
    return !!_registry[tabId];
  }

  /** @public */
  window.TabManager = {
    VERSION: '1.0.0',
    register: register,
    unregister: unregister,
    activate: activate,
    go: go,
    getActivePage: getActivePage,
    getRegistered: getRegistered,
    isRegistered: isRegistered
  };
})();
