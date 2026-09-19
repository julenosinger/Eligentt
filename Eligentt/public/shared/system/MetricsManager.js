/**
 * Elligentt MetricsManager — Enterprise Metrics Collector (Phase 6)
 * Startup time, render time, execution latency, RPC latency, cache ratio, queue length.
 * Attached to: window.MetricsManager
 */
(function () {
  'use strict';
  var _metrics = {
    startupMs: 0, executions: 0, executionTotalMs: 0,
    walletOps: 0, bridgeOps: 0, swapOps: 0, treasuryOps: 0,
    autonomaRequests: 0, aiwalletRequests: 0, rpcCalls: 0,
    queueLength: 0, cacheHitRate: 0, failedExecutions: 0, retries: 0
  };

  function record(metric, value) {
    if (_metrics[metric] !== undefined) {
      if (typeof value === 'number') _metrics[metric] += value;
      else _metrics[metric] = value;
    }
  }

  function get(name) { return _metrics[name] !== undefined ? _metrics[name] : 0; }
  function getAll() { return Object.assign({}, _metrics); }

  function recordOperation(op, durationMs, success) {
    _metrics.executions++;
    _metrics.executionTotalMs += durationMs;
    if (!success) _metrics.failedExecutions++;
    switch (op) {
      case 'wallet': _metrics.walletOps++; break;
      case 'bridge': case 'cctp': _metrics.bridgeOps++; break;
      case 'swap': _metrics.swapOps++; break;
      case 'treasury': case 'vault': _metrics.treasuryOps++; break;
      case 'autonoma': _metrics.autonomaRequests++; break;
      case 'aiwallet': _metrics.aiwalletRequests++; break;
    }
  }

  function getSummary() {
    return {
      startupMs: _metrics.startupMs,
      avgExecutionMs: _metrics.executions > 0 ? Math.round(_metrics.executionTotalMs / _metrics.executions) : 0,
      totalExecutions: _metrics.executions,
      failedExecutions: _metrics.failedExecutions,
      walletOps: _metrics.walletOps,
      bridgeOps: _metrics.bridgeOps,
      swapOps: _metrics.swapOps,
      treasuryOps: _metrics.treasuryOps,
      autonomaRequests: _metrics.autonomaRequests,
      aiwalletRequests: _metrics.aiwalletRequests,
      rpcCalls: _metrics.rpcCalls,
      successRate: _metrics.executions > 0 ? Math.round(((_metrics.executions - _metrics.failedExecutions) / _metrics.executions) * 100) : 0
    };
  }

  function reset() {
    Object.keys(_metrics).forEach(function (k) { _metrics[k] = 0; });
  }

  window.MetricsManager = {
    VERSION: '1.0.0', record: record, get: get, getAll: getAll,
    recordOperation: recordOperation, getSummary: getSummary, reset: reset
  };
})();
