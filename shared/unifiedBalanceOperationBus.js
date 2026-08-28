/**
 * UnifiedBalanceOperationBus — single global operation event layer.
 * ═══════════════════════════════════════════════════════════════════════
 * Self-contained (own listener registry) so it works regardless of whether the
 * legacy window.EventBus module is loaded. When EventBus IS available, operation
 * events are also mirrored to it under the "ubop:" prefix — but the bus never
 * depends on it. This keeps ONE source of operation events.
 *
 * Deduplicates by operation.id: the same operation is UPDATED, never duplicated.
 *
 * Events: start | update | pending | confirmed | failed | complete
 *
 * Attached to window.UBOperationBus
 */
(function () {
  'use strict';

  if (typeof window !== 'undefined' && window.UBOperationBus) return;

  var STATUSES = ['start', 'update', 'pending', 'confirmed', 'failed', 'complete'];
  var MAX_HISTORY = 100;

  var _ops = {};        // id → normalized operation (dedup)
  var _history = [];    // most recent first, bounded
  var _listeners = [];  // internal subscribers

  function _now() { return Date.now(); }

  function _idOf(op) {
    if (op && op.id) return String(op.id);
    if (op && op.txHash) return 'tx:' + op.txHash;
    return 'op_' + Math.random().toString(36).slice(2, 10) + '_' + _now();
  }

  function _normalize(op) {
    op = op || {};
    return {
      id: _idOf(op),
      type: op.type || op.source || 'operation',
      source: op.source || op.type || 'operation',
      status: op.status || 'started',
      timestamp: op.timestamp || _now(),
      chainId: op.chainId != null ? op.chainId : null,
      asset: op.asset || null,
      amount: op.amount != null ? op.amount : null,
      destination: op.destination || op.to || null,
      txHash: op.txHash || null,
      progress: op.progress != null ? op.progress : null,
      metadata: op.metadata || null,
    };
  }

  function _bump(op) {
    _ops[op.id] = op;
    for (var i = _history.length - 1; i >= 0; i--) {
      if (_history[i].id === op.id) _history.splice(i, 1);
    }
    _history.unshift(op);
    if (_history.length > MAX_HISTORY) _history.length = MAX_HISTORY;
  }

  function _notify(op, status) {
    for (var i = 0; i < _listeners.length; i++) {
      try { _listeners[i](op, status); } catch (_) {}
    }
  }

  function publish(status, op) {
    if (STATUSES.indexOf(status) === -1) status = 'update';
    var norm = _normalize(op);
    norm.status = status;
    _bump(norm);
    _notify(norm, status);

    // Mirror to the legacy EventBus when it exists (single global bus reuse).
    try {
      if (typeof EventBus !== 'undefined' && EventBus.emit) EventBus.emit('ubop:' + status, norm);
    } catch (_) {}

    return norm;
  }

  function track(op) {
    var base = _normalize(op);
    var last = null;
    function pub(status, patch) {
      var next = Object.assign({}, base, last || {}, patch || {});
      last = publish(status, next);
      return last;
    }
    return {
      start: function (p) { return pub('start', p); },
      update: function (p) { return pub('update', p); },
      pending: function (p) { return pub('pending', p); },
      progress: function (n) { return pub('update', { progress: n }); },
      confirmed: function (p) { return pub('confirmed', p); },
      failed: function (p) { return pub('failed', p); },
      complete: function (p) { return pub('complete', p); },
    };
  }

  /** Single subscription to ALL operation events. */
  function on(fn) {
    if (typeof fn !== 'function') return { off: function () {} };
    _listeners.push(fn);
    return {
      off: function () {
        var i = _listeners.indexOf(fn);
        if (i !== -1) _listeners.splice(i, 1);
      }
    };
  }

  function history(limit) { return _history.slice(0, limit || 20); }
  function get(id) { return _ops[id] || null; }
  function count() { return _listeners.length; }
  function clear() { _ops = {}; _history = []; }

  window.UBOperationBus = {
    STATUSES: STATUSES.slice(),
    publish: publish,
    track: track,
    on: on,
    history: history,
    get: get,
    count: count,
    clear: clear,
    version: '1.0.0',
  };
})();
