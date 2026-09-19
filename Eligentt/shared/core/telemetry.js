/**
 * Elligentt Telemetry — Internal Diagnostics (Phase 3)
 * Tracks: init time, RPC latency, execution time, errors, retries, cache hits.
 * No personal data. No analytics providers. Internal use only.
 * Attached to: window.Telemetry
 */
(function () {
  'use strict';

  var _metrics = {
    initTotalMs: 0,
    rpcCalls: 0,
    rpcTotalMs: 0,
    rpcErrors: 0,
    rpcRetries: 0,
    cacheHits: 0,
    cacheMisses: 0,
    apiCalls: 0,
    apiErrors: 0,
    uiRenderCount: 0,
    uiRenderTotalMs: 0,
    errors: 0,
    warnings: 0
  };

  var _timers = {};
  var _enabled = true;

  function enable() { _enabled = true; }
  function disable() { _enabled = false; }

  /** Start a named timer. Returns the start time. */
  function start(name) {
    if (!_enabled) return 0;
    _timers[name] = performance.now();
    return _timers[name];
  }

  /** End a named timer. Returns duration in ms. */
  function end(name) {
    if (!_enabled) return 0;
    var startTime = _timers[name];
    if (!startTime) return 0;
    var duration = performance.now() - startTime;
    delete _timers[name];
    return duration;
  }

  /** Record an RPC call with latency. */
  function recordRPC(method, durationMs, success) {
    if (!_enabled) return;
    _metrics.rpcCalls++;
    _metrics.rpcTotalMs += durationMs;
    if (!success) _metrics.rpcErrors++;
  }

  /** Record an RPC retry. */
  function recordRPCRetry(method) {
    if (!_enabled) return;
    _metrics.rpcRetries++;
  }

  /** Record a cache hit or miss. */
  function recordCache(hit) {
    if (!_enabled) return;
    if (hit) _metrics.cacheHits++;
    else _metrics.cacheMisses++;
  }

  /** Record an API call. */
  function recordAPI(endpoint, durationMs, success) {
    if (!_enabled) return;
    _metrics.apiCalls++;
    if (!success) _metrics.apiErrors++;
    // Duration tracked via rpcTotalMs reuse
    _metrics.rpcTotalMs += durationMs;
  }

  /** Record a UI render cycle. */
  function recordRender(component, durationMs) {
    if (!_enabled) return;
    _metrics.uiRenderCount++;
    _metrics.uiRenderTotalMs += durationMs;
  }

  /** Record an error. */
  function recordError(category) {
    if (!_enabled) return;
    _metrics.errors++;
  }

  /** Record a warning. */
  function recordWarning() {
    if (!_enabled) return;
    _metrics.warnings++;
  }

  /** Set total initialization time. */
  function setInitTime(ms) {
    _metrics.initTotalMs = ms;
  }

  /** Get current metrics snapshot. */
  function getSnapshot() {
    return {
      initTotalMs: Math.round(_metrics.initTotalMs),
      rpcCalls: _metrics.rpcCalls,
      rpcAvgMs: _metrics.rpcCalls > 0 ? Math.round(_metrics.rpcTotalMs / _metrics.rpcCalls) : 0,
      rpcErrors: _metrics.rpcErrors,
      rpcRetries: _metrics.rpcRetries,
      cacheHits: _metrics.cacheHits,
      cacheMisses: _metrics.cacheMisses,
      cacheHitRate: (_metrics.cacheHits + _metrics.cacheMisses) > 0
        ? Math.round((_metrics.cacheHits / (_metrics.cacheHits + _metrics.cacheMisses)) * 100) : 0,
      apiCalls: _metrics.apiCalls,
      apiErrors: _metrics.apiErrors,
      uiRenderCount: _metrics.uiRenderCount,
      uiRenderAvgMs: _metrics.uiRenderCount > 0 ? Math.round(_metrics.uiRenderTotalMs / _metrics.uiRenderCount) : 0,
      errors: _metrics.errors,
      warnings: _metrics.warnings
    };
  }

  /** Reset all metrics. */
  function reset() {
    _metrics = {
      initTotalMs: 0, rpcCalls: 0, rpcTotalMs: 0, rpcErrors: 0, rpcRetries: 0,
      cacheHits: 0, cacheMisses: 0, apiCalls: 0, apiErrors: 0,
      uiRenderCount: 0, uiRenderTotalMs: 0, errors: 0, warnings: 0
    };
    _timers = {};
  }

  /** Log summary to console (dev only). */
  function logReport() {
    var s = getSnapshot();
    console.log('[Telemetry] Report:', JSON.stringify(s));
    return s;
  }

  // Hook into EventBus for automatic error recording
  try {
    if (typeof EventBus !== 'undefined' && EventBus.on) {
      EventBus.on('ERROR_OCCURRED', function () { _metrics.errors++; });
    }
  } catch (_e) {}

  window.Telemetry = {
    VERSION: '1.0.0',
    enable: enable, disable: disable,
    start: start, end: end,
    recordRPC: recordRPC, recordRPCRetry: recordRPCRetry,
    recordCache: recordCache, recordAPI: recordAPI,
    recordRender: recordRender, recordError: recordError, recordWarning: recordWarning,
    setInitTime: setInitTime, getSnapshot: getSnapshot, reset: reset, logReport: logReport
  };
})();
