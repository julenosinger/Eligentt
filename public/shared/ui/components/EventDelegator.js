/**
 * Elligentt EventDelegator — Replace onclick with data-action + EventBus Routing (Phase 19)
 * Upgraded from Phase 18.4 to Phase 19: full delegation (click, change, input, submit).
 * Routes ALL DOM interactions through EventBus to Page Modules → Domain Services.
 * Attached to: window.EventDelegator
 * @module EventDelegator
 * @version 19.0.0
 */
(function () {
  'use strict';

  var _active = false;
  var _dispatched = 0;

  var ACTION_MAP = {
    // Swap
    'swap-execute':    { event: 'SWAP_EXECUTE',       module: 'SwapPage',         method: 'execute' },
    'swap-refresh':    { event: 'SWAP_REFRESH',       module: 'SwapPage',         method: 'refresh' },
    // Bridge
    'bridge-execute':  { event: 'BRIDGE_EXECUTE',     module: 'BridgePage',       method: 'execute' },
    'bridge-turbo':    { event: 'BRIDGE_TURBO',       module: 'BridgePage',       method: 'turbo' },
    'bridge-refresh':  { event: 'BRIDGE_REFRESH',     module: 'BridgePage',       method: 'refresh' },
    // Payments
    'payment-execute': { event: 'PAYMENT_EXECUTE',    module: 'PaymentsPage',     method: 'execute' },
    'payment-sign':    { event: 'PAYMENT_SIGN',       module: 'PaymentsPage',     method: 'sign' },
    // Wallet
    'wallet-connect':  { event: 'WALLET_CONNECT',     module: 'WalletPage',       method: 'connect' },
    'wallet-disconnect':{event:'WALLET_DISCONNECT',   module: 'WalletPage',       method: 'disconnect' },
    'wallet-refresh':  { event: 'WALLET_REFRESH',     module: 'WalletPage',       method: 'refreshBalance' },
    // Scheduler
    'schedule-create': { event: 'SCHEDULE_CREATE',    module: 'SchedulerPage',    method: 'create' },
    'schedule-execute':{ event: 'SCHEDULE_EXECUTE',   module: 'SchedulerPage',    method: 'executeAll' },
    // AI Wallet
    'aiw-submit':      { event: 'AIWALLET_EXECUTE',   module: 'AIWalletRuntime',  method: 'submit' },
    'aiw-approve':     { event: 'AIWALLET_APPROVAL',  module: 'AIWalletRuntime',  method: 'approve' },
    // Autonoma
    'autonoma-send':   { event: 'AUTONOMA_MESSAGE',   module: 'AutonomaPage',     method: 'processMessage' },
    // Contacts
    'contacts-refresh':{ event: 'CONTACTS_UPDATED',   module: 'ContactsPage',     method: 'render' },
    // Reports
    'reports-refresh': { event: 'REPORTS_UPDATED',    module: 'ReportsPage',      method: 'render' },
    // History
    'history-refresh': { event: 'HISTORY_REFRESH',    module: 'HistoryPage',      method: 'render' },
    // Pool
    'pool-refresh':    { event: 'POOL_REFRESH',       module: 'PoolPage',         method: 'render' },
    // Treasury
    'treasury-refresh':{ event: 'TREASURY_REFRESH',   module: 'TreasuryPage',     method: 'render' },
    // Invoices
    'invoice-refresh': { event: 'INVOICE_REFRESH',    module: 'InvoicesPage',     method: 'render' },
    // PayLinks
    'paylink-refresh': { event: 'PAYLINK_REFRESH',    module: 'PayLinksPage',     method: 'render' },
    // XChain
    'xchain-refresh':  { event: 'XCHAIN_REFRESH',     module: 'XChainPage',       method: 'render' },
    // Modal
    'modal-open':      { event: 'MODAL_OPEN',         module: null,               method: null },
    'modal-close':     { event: 'MODAL_CLOSE',        module: null,               method: null }
  };

  function _dispatch(target) {
    var action = target.getAttribute('data-action');
    var mapping = ACTION_MAP[action];
    if (!mapping) return;

    _dispatched++;

    try {
      if (typeof EventBus !== 'undefined') {
        EventBus.emit(mapping.event, { action: action, element: target, source: 'EventDelegator' });
      }
    } catch (_e) {}

    try {
      if (mapping.module) {
        var mod = window[mapping.module];
        if (mod && typeof mod[mapping.method] === 'function') {
          mod[mapping.method](target);
        }
      }
    } catch (_e2) {}

    try {
      if (typeof PureExecutionGuard !== 'undefined' && PureExecutionGuard.isActive()) {
        // Action routed through modular path - no legacy bypass
      }
    } catch (_e3) {}
  }

  function activate() {
    if (_active) return;
    _active = true;

    document.addEventListener('click', function (e) {
      var target = e.target.closest('[data-action]');
      if (!target) return;
      e.preventDefault();
      _dispatch(target);
    });

    document.addEventListener('change', function (e) {
      var target = e.target.closest('[data-action]');
      if (!target) return;
      _dispatch(target);
    });

    document.addEventListener('input', function (e) {
      var target = e.target.closest('[data-action]');
      if (!target) return;
      _dispatch(target);
    });

    document.addEventListener('submit', function (e) {
      var target = e.target.closest('[data-action]');
      if (!target) return;
      e.preventDefault();
      _dispatch(target);
    });

    console.log('[EventDelegator v19] Active — routing ' + Object.keys(ACTION_MAP).length + ' data-action handlers');
  }

  function deactivate() { _active = false; }
  function isActive() { return _active; }
  function getDispatchedCount() { return _dispatched; }

  /** @deprecated Use activate() instead — kept for backward compatibility */
  function start() { activate(); }

  function getActionMap() { return Object.assign({}, ACTION_MAP); }

  function register(action, event, module, method) {
    ACTION_MAP[action] = { event: event, module: module, method: method };
  }

  function getActionCount() { return Object.keys(ACTION_MAP).length; }
  function getRegisteredActions() { return Object.keys(ACTION_MAP); }

  function getReport() {
    return {
      active: _active,
      totalActions: getActionCount(),
      dispatched: _dispatched
    };
  }

  window.EventDelegator = {
    VERSION: '19.0.0',
    start: start, activate: activate, deactivate: deactivate, isActive: isActive,
    getActionMap: getActionMap, register: register,
    getDispatchedCount: getDispatchedCount, getActionCount: getActionCount,
    getRegisteredActions: getRegisteredActions, getReport: getReport
  };
})();
