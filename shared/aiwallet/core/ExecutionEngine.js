/**
 * AIWallet ExecutionEngine — Intent Execution Wrapper (Phase 4)
 * Wraps AIWallet.submitIntent / executeIntent / cancelIntent.
 * Attached to: window.AIWExecutionEngine
 */
(function () {
  'use strict';
  var _init = false, _subs = [];

  function initialize() {
    if (_init) return; _init = true;
    if (typeof EventBus !== 'undefined') {
      _subs.push(EventBus.on('SCHEDULE_UPDATED', _onScheduleUpdated));
    }
  }

  function _onScheduleUpdated(detail) {
    // Forward schedule updates to AIWallet for intent linking
    try {
      if (typeof AIWallet !== 'undefined' && AIWallet.onScheduleUpdated) {
        // AIWallet listens to document SCHEDULE_UPDATED events directly
      }
    } catch (_e) {}
  }

  /** Submit an intent through the full pipeline */
  function submit(raw) {
    try {
      if (typeof AIWallet !== 'undefined' && AIWallet.submitIntent) return AIWallet.submitIntent(raw);
    } catch (e) {
      try { if (typeof ErrorHandler !== 'undefined') ErrorHandler.handle(e, { source: 'aiwallet.execution', operation: 'submit' }); } catch (_e) {}
    }
    return null;
  }

  /** Execute a validated intent */
  function execute(id) {
    try {
      if (typeof AIWallet !== 'undefined' && AIWallet.executeIntent) { AIWallet.executeIntent(id); return true; }
    } catch (e) {
      try { if (typeof ErrorHandler !== 'undefined') ErrorHandler.handle(e, { source: 'aiwallet.execution', operation: 'execute' }); } catch (_e) {}
    }
    return false;
  }

  /** Cancel a pending intent */
  function cancel(id) {
    try {
      if (typeof AIWallet !== 'undefined' && AIWallet.cancelIntent) { AIWallet.cancelIntent(id); return true; }
    } catch (_e) {}
    return false;
  }

  /** Receive intent from Autonoma */
  function receiveFromAutonoma(intent) {
    try {
      if (typeof AIWallet !== 'undefined' && AIWallet.receiveAutonomaIntent) return AIWallet.receiveAutonomaIntent(intent);
    } catch (_e) {}
    return null;
  }

  /** Get all current intents */
  function getIntents() {
    try {
      if (typeof AIWallet !== 'undefined' && AIWallet.getIntents) return AIWallet.getIntents();
      if (typeof AIWStorageEngine !== 'undefined') return AIWStorageEngine.getIntents();
    } catch (_e) {}
    return [];
  }

  /** Get execution metrics */
  function getMetrics() {
    var intents = getIntents();
    return {
      total: intents.length,
      pending: intents.filter(function (i) { return i.status === 'validating' || i.status === 'approved'; }).length,
      executing: intents.filter(function (i) { return i.status === 'executing'; }).length,
      executed: intents.filter(function (i) { return i.status === 'executed'; }).length,
      rejected: intents.filter(function (i) { return i.status === 'rejected'; }).length,
      cancelled: intents.filter(function (i) { return i.status === 'cancelled'; }).length
    };
  }

  function refresh() {}
  function destroy() { _subs.forEach(function (s) { try { s.off(); } catch (_e) {} }); _subs = []; _init = false; }

  window.AIWExecutionEngine = {
    VERSION: '1.0.0',
    initialize: initialize, submit: submit, execute: execute, cancel: cancel,
    receiveFromAutonoma: receiveFromAutonoma, getIntents: getIntents,
    getMetrics: getMetrics, refresh: refresh, destroy: destroy
  };
})();
