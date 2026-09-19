/**
 * Elligentt Pool Retry Manager — Progressive Backoff (FIX EURC POOL)
 * ═══════════════════════════════════════
 * Retries failed pool loads with progressive backoff.
 * Never gives up on a pool after a single RPC failure.
 * Attached to window.PoolRetryManager
 */
(function(){
  'use strict';

  var RETRY_SCHEDULE = [0, 500, 1000, 2000, 5000]; // ms
  var MAX_RETRIES = RETRY_SCHEDULE.length - 1;      // 4 retries = 5 total attempts

  var pendingRetries = {};

  function _now() { return Date.now(); }

  /**
   * Execute a pool load function with retries.
   * @param poolId - Pool identifier
   * @param loadFn - async function that returns { success: bool, data: any, error: string }
   * @returns result from the first successful attempt, or the last error
   */
  async function executeWithRetry(poolId, loadFn) {
    // Cancel any existing retry chain for this pool
    cancel(poolId);

    var ctx = {
      poolId: poolId,
      attempt: 0,
      startedAt: _now(),
      completed: false,
      cancelled: false
    };
    pendingRetries[poolId] = ctx;

    var lastError = null;

    for (var i = 0; i < RETRY_SCHEDULE.length; i++) {
      if (ctx.cancelled) break;

      var delay = RETRY_SCHEDULE[i];
      if (delay > 0) {
        await _sleep(delay);
      }
      if (ctx.cancelled) break;

      ctx.attempt = i + 1;
      try {
        var result = await loadFn();
        if (result && result.success) {
          ctx.completed = true;
          delete pendingRetries[poolId];
          return { success: true, data: result.data, attempts: ctx.attempt, duration: _now() - ctx.startedAt };
        }
        lastError = result ? result.error : 'Unknown error';
      } catch(e) {
        lastError = e.message || 'Exception during load';
      }
    }

    // All retries exhausted
    ctx.completed = true;
    delete pendingRetries[poolId];
    return { success: false, error: lastError, attempts: ctx.attempt, duration: _now() - ctx.startedAt };
  }

  function cancel(poolId) {
    if (pendingRetries[poolId]) {
      pendingRetries[poolId].cancelled = true;
      delete pendingRetries[poolId];
    }
  }

  function cancelAll() {
    var keys = Object.keys(pendingRetries);
    for (var i = 0; i < keys.length; i++) {
      pendingRetries[keys[i]].cancelled = true;
    }
    pendingRetries = {};
  }

  function isRetrying(poolId) {
    return !!pendingRetries[poolId];
  }

  function getRetryStatus(poolId) {
    var ctx = pendingRetries[poolId];
    if (!ctx) return null;
    return {
      poolId: poolId,
      attempt: ctx.attempt,
      maxAttempts: RETRY_SCHEDULE.length,
      startedAt: ctx.startedAt,
      elapsed: _now() - ctx.startedAt
    };
  }

  function getPendingCount() {
    return Object.keys(pendingRetries).length;
  }

  function _sleep(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
  }

  window.PoolRetryManager = {
    executeWithRetry: executeWithRetry,
    cancel: cancel,
    cancelAll: cancelAll,
    isRetrying: isRetrying,
    getRetryStatus: getRetryStatus,
    getPendingCount: getPendingCount,
    RETRY_SCHEDULE: RETRY_SCHEDULE,
    MAX_RETRIES: MAX_RETRIES
  };
})();
