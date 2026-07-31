/**
 * Elligentt EventDelegator — Inline Handler Elimination (Phase 19)
 *
 * Replaces ALL inline event handlers (onclick, onchange, oninput, onkeyup, onsubmit)
 * with a centralized delegation system using data-action attributes.
 *
 * Flow:
 *   DOM Event
 *      |
 *      v
 *   EventDelegator (document-level listener)
 *      |
 *      v
 *   Route by data-action
 *      |
 *      v
 *   EventBus.emit('ACTION:' + data-action, { ... })
 *      |
 *      v
 *   Page Module (EventBus listener)
 *      |
 *      v
 *   Domain Service
 *
 * No direct DOM execution is allowed.
 *
 * Usage:
 *   Before: <button onclick="executeSwap()">
 *   After:  <button data-action="swap-execute" data-amount="100">
 *
 * Attached to: window.EventDelegator
 *
 * @module EventDelegator
 * @version 19.0.0
 */
(function () {
  'use strict';

  var _active = false;
  var _handlers = {};
  var _dispatchedCount = 0;

  /** Action routing map: data-action value → handler function */
  var ACTION_MAP = {
    // Navigation
    'nav-send':             function () { _navigate('send'); },
    'nav-xchain':           function () { _navigate('xchain'); },
    'nav-batch':            function () { _navigate('batch'); },
    'nav-queue':            function () { _navigate('queue'); },
    'nav-links':            function () { _navigate('links'); },
    'nav-invoices':         function () { _navigate('invoices'); },
    'nav-schedule':         function () { _navigate('schedule'); },
    'nav-swap':             function () { _navigate('swap'); },
    'nav-bridge':           function () { _navigate('bridge'); },
    'nav-pool':             function () { _navigate('pool'); },
    'nav-autonoma':         function () { _navigate('autonoma'); },
    'nav-aiwallet':         function () { _navigate('aiwallet'); },
    'nav-treasury':         function () { _navigate('treasury'); },
    'nav-contacts':         function () { _navigate('contacts'); },
    'nav-reports':          function () { _navigate('reports'); },
    'nav-settings':         function () { _navigate('settings'); },
    'nav-templates':        function () { _navigate('templates'); },
    'nav-paylinks':         function () { _navigate('paylinks'); },
    'nav-dashboard':        function () { _navigate('dashboard'); },

    // Swap
    'swap-execute':         function () { _emitAction('SWAP_EXECUTE', 'SwapPage'); },
    'swap-refresh':         function () { _emitAction('SWAP_REFRESH', 'SwapPage'); },
    'swap-token-select':    function (el) { _emitAction('SWAP_TOKEN_SELECT', 'SwapPage', _collectDataset(el)); },
    'swap-amount-change':   function (el) { _emitAction('SWAP_AMOUNT_CHANGE', 'SwapPage', { value: el ? el.value : null }); },

    // Bridge
    'bridge-execute':       function () { _emitAction('BRIDGE_EXECUTE', 'BridgePage'); },
    'bridge-turbo':         function () { _emitAction('BRIDGE_TURBO', 'BridgePage'); },
    'bridge-refresh':       function () { _emitAction('BRIDGE_REFRESH', 'BridgePage'); },
    'bridge-chain-select':  function (el) { _emitAction('BRIDGE_CHAIN_SELECT', 'BridgePage', _collectDataset(el)); },

    // Wallet
    'wallet-connect':       function () { _emitAction('WALLET_CONNECT', 'WalletPage'); },
    'wallet-disconnect':    function () { _emitAction('WALLET_DISCONNECT', 'WalletPage'); },
    'wallet-refresh':       function () { _emitAction('WALLET_REFRESH', 'WalletPage'); },
    'wallet-switch-network':function (el) { _emitAction('WALLET_SWITCH_NETWORK', 'WalletPage', _collectDataset(el)); },

    // Payments
    'payment-execute':      function () { _emitAction('PAYMENT_EXECUTE', 'PaymentsPage'); },
    'payment-add-recipient':function () { _emitAction('PAYMENT_ADD_RECIPIENT', 'PaymentsPage'); },
    'payment-sign':         function () { _emitAction('PAYMENT_SIGN', 'PaymentsPage'); },

    // Modal
    'modal-open':           function (el) { _emitAction('MODAL_OPEN', null, _collectDataset(el)); },
    'modal-close':          function () { _emitAction('MODAL_CLOSE', null); },

    // Contacts
    'contacts-refresh':     function () { _emitAction('CONTACTS_REFRESH', 'ContactsPage'); },
    'contacts-filter':      function (el) { _emitAction('CONTACTS_FILTER', 'ContactsPage', { value: el ? el.value : null }); },

    // Scheduler
    'scheduler-create':     function (el) { _emitAction('SCHEDULER_CREATE', 'SchedulerPage', _collectDataset(el)); },
    'scheduler-pause':      function (el) { _emitAction('SCHEDULER_PAUSE', 'SchedulerPage', _collectDataset(el)); },
    'scheduler-execute':    function (el) { _emitAction('SCHEDULER_EXECUTE', 'SchedulerPage', _collectDataset(el)); },

    // Pool
    'pool-refresh':         function () { _emitAction('POOL_REFRESH', 'PoolPage'); },
    'pool-deposit':         function () { _emitAction('POOL_DEPOSIT', 'PoolPage'); },
    'pool-withdraw':        function () { _emitAction('POOL_WITHDRAW', 'PoolPage'); },

    // Treasury
    'treasury-refresh':     function () { _emitAction('TREASURY_REFRESH', 'TreasuryPage'); },
    'treasury-deposit':     function () { _emitAction('TREASURY_DEPOSIT', 'TreasuryPage'); },

    // Invoices
    'invoice-create':       function () { _emitAction('INVOICE_CREATE', 'InvoicesPage'); },
    'invoice-refresh':      function () { _emitAction('INVOICE_REFRESH', 'InvoicesPage'); },
    'invoice-filter':       function (el) { _emitAction('INVOICE_FILTER', 'InvoicesPage', { value: el ? el.value : null }); },

    // PayLinks
    'paylink-create':       function () { _emitAction('PAYLINK_CREATE', 'PayLinksPage'); },
    'paylink-refresh':      function () { _emitAction('PAYLINK_REFRESH', 'PayLinksPage'); },

    // XChain
    'xchain-refresh':       function () { _emitAction('XCHAIN_REFRESH', 'XChainPage'); },

    // Reports
    'reports-refresh':      function () { _emitAction('REPORTS_REFRESH', 'ReportsPage'); },

    // Settings
    'settings-save':        function () { _emitAction('SETTINGS_SAVE', null); },

    // Autonoma
    'autonoma-send':        function (el) { _emitAction('AUTONOMA_SEND', 'AutonomaPage', { value: el ? el.value : null }); },
    'autonoma-clear':       function () { _emitAction('AUTONOMA_CLEAR', 'AutonomaPage'); },

    // AI Wallet
    'aiwallet-submit':      function () { _emitAction('AIWALLET_SUBMIT', 'AIWalletRuntime'); },
    'aiwallet-approve':     function (el) { _emitAction('AIWALLET_APPROVE', 'AIWalletRuntime', _collectDataset(el)); },

    // Toast (utility)
    'toast-show':           function (el) { _showToast(_collectDataset(el)); }
  };

  /**
   * Activate the delegator. Attaches a single document-level event listener
   * that handles ALL delegated actions. This replaces all inline handlers.
   */
  function activate() {
    if (_active) return;
    _active = true;

    // Click delegation (replaces onclick)
    document.addEventListener('click', _handleClick, false);

    // Change delegation (replaces onchange)
    document.addEventListener('change', _handleChange, false);

    // Input delegation (replaces oninput)
    document.addEventListener('input', _handleInput, false);

    // Submit delegation (replaces onsubmit)
    document.addEventListener('submit', _handleSubmit, false);

    console.log('[EventDelegator] Activated — ' + Object.keys(ACTION_MAP).length + ' actions registered');
  }

  /**
   * Deactivate and remove listeners.
   */
  function deactivate() {
    document.removeEventListener('click', _handleClick, false);
    document.removeEventListener('change', _handleChange, false);
    document.removeEventListener('input', _handleInput, false);
    document.removeEventListener('submit', _handleSubmit, false);
    _active = false;
  }

  /* ── Event Handlers ─────────────────────────────────────── */

  function _handleClick(e) {
    var actionEl = _findActionTarget(e.target, 'click');
    if (!actionEl) return;

    var action = actionEl.getAttribute('data-action');
    var handler = ACTION_MAP[action];
    if (typeof handler === 'function') {
      _dispatchedCount++;
      handler(actionEl);
    }
  }

  function _handleChange(e) {
    var actionEl = _findActionTarget(e.target, 'change');
    if (!actionEl) return;

    var action = actionEl.getAttribute('data-action');
    var handler = ACTION_MAP[action];
    if (typeof handler === 'function') {
      _dispatchedCount++;
      handler(actionEl);
    }
  }

  function _handleInput(e) {
    var actionEl = _findActionTarget(e.target, 'input');
    if (!actionEl) return;

    var action = actionEl.getAttribute('data-action');
    var handler = ACTION_MAP[action];
    if (typeof handler === 'function') {
      _dispatchedCount++;
      handler(actionEl);
    }
  }

  function _handleSubmit(e) {
    var actionEl = _findActionTarget(e.target, 'submit');
    if (!actionEl) return;

    e.preventDefault();
    var action = actionEl.getAttribute('data-action');
    var handler = ACTION_MAP[action];
    if (typeof handler === 'function') {
      _dispatchedCount++;
      handler(actionEl);
    }
  }

  /* ── Helpers ────────────────────────────────────────────── */

  /**
   * Walk up the DOM tree to find an element with data-action.
   * Stops at body.
   */
  function _findActionTarget(el, eventType) {
    var current = el;
    while (current && current !== document.body) {
      if (current.hasAttribute && current.hasAttribute('data-action')) {
        var action = current.getAttribute('data-action');
        if (ACTION_MAP[action]) return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  function _collectDataset(el) {
    if (!el || !el.dataset) return {};
    var data = {};
    try {
      Object.keys(el.dataset).forEach(function (k) {
        if (k === 'action') return;
        data[k] = el.dataset[k];
      });
    } catch (_e) {}
    return data;
  }

  function _navigate(page) {
    _emitAction('PAGE_CHANGE', 'Navigation', { page: page });
    try {
      if (typeof showPage === 'function') showPage(page);
    } catch (_e) {
      _emitAction('PAGE_CHANGE_ERROR', 'Navigation', { page: page, error: 'showPage not available' });
    }
  }

  function _emitAction(action, source, payload) {
    try {
      if (typeof EventBus !== 'undefined' && EventBus.emit) {
        EventBus.emit('ACTION:' + action, {
          action: action,
          source: source,
          payload: payload || {},
          timestamp: Date.now()
        });
      }
    } catch (_e) {}

    try {
      if (typeof PureExecutionGuard !== 'undefined' && PureExecutionGuard.isActive()) {
        // Track that action was routed through modular path — not legacy
      }
    } catch (_e2) {}
  }

  function _showToast(data) {
    var message = data.message || data.content || '';
    var type = data.type || 'info';
    try {
      if (typeof toast === 'function') { toast(message, type); return; }
      if (typeof showToast === 'function') { showToast(message, type); return; }
    } catch (_e) {}
    console.log('[Toast] ' + type.toUpperCase() + ': ' + message);
  }

  /* ── Custom Action Registration ─────────────────────────── */

  /**
   * Register a custom action handler.
   * @param {string} action — the data-action value
   * @param {Function} handler — function(element)
   */
  function registerAction(action, handler) {
    if (typeof handler !== 'function') return false;
    ACTION_MAP[action] = handler;
    return true;
  }

  /**
   * Remove a registered action.
   * @param {string} action
   */
  function unregisterAction(action) {
    delete ACTION_MAP[action];
  }

  /**
   * Register a batch of actions from a page module.
   * @param {Object} actionMap — { 'action-name': function }
   */
  function registerActions(actionMap) {
    var count = 0;
    Object.keys(actionMap).forEach(function (k) {
      if (typeof actionMap[k] === 'function') {
        ACTION_MAP[k] = actionMap[k];
        count++;
      }
    });
    return count;
  }

  /* ── Reporting ──────────────────────────────────────────── */

  /** @returns {boolean} */
  function isActive() { return _active; }

  /** @returns {number} */
  function getDispatchedCount() { return _dispatchedCount; }

  /** @returns {string[]} */
  function getRegisteredActions() { return Object.keys(ACTION_MAP); }

  /** @returns {number} */
  function getActionCount() { return Object.keys(ACTION_MAP).length; }

  /** @returns {Object} */
  function getReport() {
    return {
      active: _active,
      totalActions: getActionCount(),
      dispatched: _dispatchedCount,
      actions: getRegisteredActions()
    };
  }

  /** @public */
  window.EventDelegator = {
    VERSION: '19.0.0',
    activate: activate,
    deactivate: deactivate,
    isActive: isActive,
    registerAction: registerAction,
    registerActions: registerActions,
    unregisterAction: unregisterAction,
    getDispatchedCount: getDispatchedCount,
    getRegisteredActions: getRegisteredActions,
    getActionCount: getActionCount,
    getReport: getReport
  };

  // Auto-activate on load
  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { activate(); });
    } else {
      activate();
    }
  } catch (_e) {}
})();
