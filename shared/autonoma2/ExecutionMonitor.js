/**
 * Autonoma 2 — Execution Monitor
 * Tracks real execution states and emits updates back to chat.
 * States: preparing → awaiting_approval → approved → submitted →
 *         pending → confirming → completed | failed | cancelled
 * For bridge: source_submitted → source_confirmed → processing →
 *             destination_submitted → destination_confirmed → completed
 * Attached to window.A2Monitor
 */
(function () {
  'use strict';

  var _ops = {}; // executionId → operation state

  var STATES = {
    PREPARING: 'preparing',
    AWAITING_APPROVAL: 'awaiting_approval',
    APPROVED: 'approved',
    SUBMITTED: 'submitted',
    PENDING: 'pending',
    CONFIRMING: 'confirming',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
    // Bridge-specific
    SOURCE_SUBMITTED: 'source_submitted',
    SOURCE_CONFIRMED: 'source_confirmed',
    PROCESSING: 'processing',
    DESTINATION_SUBMITTED: 'destination_submitted',
    DESTINATION_CONFIRMED: 'destination_confirmed'
  };

  var STATE_LABELS = {
    preparing: 'Preparing',
    awaiting_approval: 'Awaiting your approval',
    approved: 'Approved',
    submitted: 'Submitted to network',
    pending: 'Pending',
    confirming: 'Confirming',
    completed: 'Completed',
    failed: 'Failed',
    cancelled: 'Cancelled',
    source_submitted: 'Source tx submitted',
    source_confirmed: 'Source chain confirmed',
    processing: 'Attestation / processing',
    destination_submitted: 'Destination tx submitted',
    destination_confirmed: 'Destination chain confirmed'
  };

  function create(id, type, meta) {
    _ops[id] = {
      id: id,
      type: type, // send | swap | bridge | schedule | invoice | payment_link
      state: STATES.PREPARING,
      meta: meta || {},
      txHash: null,
      error: null,
      startTs: Date.now(),
      updateTs: Date.now(),
      history: [{ state: STATES.PREPARING, ts: Date.now() }]
    };
    return _ops[id];
  }

  function update(id, state, extra) {
    var op = _ops[id];
    if (!op) return;
    op.state = state;
    op.updateTs = Date.now();
    if (extra) Object.assign(op, extra);
    op.history.push({ state: state, ts: Date.now() });
    _emit(id, op);
    return op;
  }

  function get(id) { return _ops[id] || null; }

  function stateLabel(state) { return STATE_LABELS[state] || state; }

  var _listeners = [];
  function onUpdate(fn) { _listeners.push(fn); }
  function _emit(id, op) { _listeners.forEach(function (fn) { try { fn(id, op); } catch (e) {} }); }

  // Poll LI.FI bridge status until final state
  async function pollBridge(id, txHash, onStep) {
    var op = _ops[id];
    if (!op) return;
    var maxPolls = 40;
    var pollInterval = 5000;
    for (var i = 0; i < maxPolls; i++) {
      await _sleep(pollInterval);
      try {
        var res = await fetch('/api/lifi/status?txHash=' + txHash);
        if (res.ok) {
          var data = await res.json();
          var st = (data.status || '').toUpperCase();
          if (st === 'DONE') {
            update(id, STATES.DESTINATION_CONFIRMED, { destinationTxHash: data.receiving && data.receiving.txHash });
            update(id, STATES.COMPLETED);
            if (onStep) onStep(STATES.COMPLETED, data);
            return;
          } else if (st === 'FAILED') {
            update(id, STATES.FAILED, { error: data.substatusMessage || 'Bridge failed' });
            if (onStep) onStep(STATES.FAILED, data);
            return;
          } else if (st === 'PENDING' || st === 'NOT_FOUND') {
            update(id, STATES.PROCESSING);
            if (onStep) onStep(STATES.PROCESSING, data);
          }
        }
      } catch (e) { /* continue polling */ }
    }
    update(id, STATES.FAILED, { error: 'Status polling timed out' });
  }

  function _sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  window.A2Monitor = {
    STATES: STATES,
    stateLabel: stateLabel,
    create: create,
    update: update,
    get: get,
    onUpdate: onUpdate,
    pollBridge: pollBridge
  };

})();
