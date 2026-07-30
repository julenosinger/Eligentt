/**
 * Elligentt EventDelegator — Replace onclick with data-action + EventBus Routing (Phase 18.4)
 * Listens at document level for [data-action] clicks. Routes to EventBus.
 * Attached to: window.EventDelegator
 */
(function () {
  'use strict';

  var ACTION_MAP = {
    'swap-execute':    { event: 'SWAP_EXECUTE',    module: 'SwapPage',         method: 'execute' },
    'bridge-execute':  { event: 'BRIDGE_EXECUTE',  module: 'BridgePage',       method: 'execute' },
    'bridge-turbo':    { event: 'BRIDGE_TURBO',    module: 'BridgePage',       method: 'turbo' },
    'payment-execute': { event: 'PAYMENT_EXECUTE', module: 'PaymentsPage',     method: 'execute' },
    'wallet-connect':  { event: 'WALLET_CONNECT',  module: 'WalletPage',       method: 'connect' },
    'wallet-disconnect':{event: 'WALLET_DISCONNECT',module:'WalletPage',       method: 'disconnect' },
    'schedule-create': { event: 'SCHEDULE_CREATE', module: 'SchedulerPage',    method: 'create' },
    'schedule-execute':{ event: 'SCHEDULE_EXECUTE',module: 'SchedulerPage',    method: 'executeAll' },
    'aiw-submit':      { event: 'AIWALLET_EXECUTE',module: 'AIWalletRuntime',   method: 'submit' },
    'aiw-approve':     { event: 'AIWALLET_APPROVAL',module:'AIWalletRuntime',  method: 'approve' },
    'autonoma-send':   { event: 'AUTONOMA_MESSAGE', module: 'AutonomaPage',    method: 'processMessage' },
    'contacts-refresh':{ event: 'CONTACTS_UPDATED', module: 'ContactsPage',    method: 'render' },
    'reports-refresh': { event: 'REPORTS_UPDATED',  module: 'ReportsPage',     method: 'render' },
    'history-refresh': { event: 'HISTORY_REFRESH',  module: 'HistoryPage',     method: 'render' },
    'pool-refresh':    { event: 'POOL_REFRESH',     module: 'PoolPage',        method: 'render' },
    'treasury-refresh':{ event: 'TREASURY_REFRESH', module: 'TreasuryPage',    method: 'render' }
  };

  function start() {
    try {
      document.addEventListener('click', function (e) {
        var target = e.target.closest('[data-action]');
        if (!target) return;
        var action = target.getAttribute('data-action');
        var mapping = ACTION_MAP[action];
        if (!mapping) return;

        e.preventDefault();
        try {
          if (typeof EventBus !== 'undefined') {
            EventBus.emit(mapping.event, { action: action, element: target });
          }
        } catch (_e) {}

        try {
          var mod = window[mapping.module];
          if (mod && typeof mod[mapping.method] === 'function') {
            mod[mapping.method](target);
          }
        } catch (_e2) {}
      });

      console.log('[EventDelegator] Active — routing ' + Object.keys(ACTION_MAP).length + ' data-action handlers');
    } catch (_e) {}
  }

  function getActionMap() { return Object.assign({}, ACTION_MAP); }
  function register(action, event, module, method) {
    ACTION_MAP[action] = { event: event, module: module, method: method };
  }

  window.EventDelegator = {
    VERSION: '18.0.0',
    start: start, getActionMap: getActionMap, register: register
  };
})();
