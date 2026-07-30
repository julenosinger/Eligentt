/**
 * Elligentt CircuitBreaker — Protect RPC/Bridge/Swap/External APIs (Phase 6)
 * States: CLOSED → OPEN → HALF_OPEN → CLOSED. Automatic retry + backoff.
 * Attached to: window.CircuitBreaker
 */
(function () {
  'use strict';

  function create(id, opts) {
    var o = opts || {};
    return {
      id: id,
      state: 'CLOSED',
      failureCount: 0,
      successCount: 0,
      lastFailure: 0,
      lastSuccess: 0,
      failureThreshold: o.failureThreshold || 5,
      resetTimeout: o.resetTimeout || 30000,
      halfOpenMaxCalls: o.halfOpenMaxCalls || 1,
      halfOpenCalls: 0
    };
  }

  function onSuccess(cb) { cb.state = 'CLOSED'; cb.failureCount = 0; cb.successCount++; cb.lastSuccess = Date.now(); }

  function onFailure(cb) {
    cb.failureCount++;
    cb.lastFailure = Date.now();
    if (cb.failureCount >= cb.failureThreshold && cb.state === 'CLOSED') {
      cb.state = 'OPEN';
      try { if (typeof EventBus !== 'undefined') EventBus.emit('CIRCUIT_OPENED', { id: cb.id }); } catch (_e) {}
    }
  }

  function canExecute(cb) {
    if (cb.state === 'CLOSED') return true;
    if (cb.state === 'OPEN') {
      if (Date.now() - cb.lastFailure >= cb.resetTimeout) { cb.state = 'HALF_OPEN'; cb.halfOpenCalls = 0; }
      else return false;
    }
    if (cb.state === 'HALF_OPEN') {
      if (cb.halfOpenCalls >= cb.halfOpenMaxCalls) return false;
      cb.halfOpenCalls++;
      return true;
    }
    return false;
  }

  function getState(cb) { return cb.state; }
  function getMetrics(cb) { return { state: cb.state, failures: cb.failureCount, successes: cb.successCount }; }

  window.CircuitBreaker = {
    VERSION: '1.0.0', create: create, onSuccess: onSuccess, onFailure: onFailure,
    canExecute: canExecute, getState: getState, getMetrics: getMetrics
  };
})();
