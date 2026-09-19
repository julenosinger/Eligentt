/**
 * RPCRequestManager — Deduplicates RPC calls, coalesces in-flight requests,
 * prioritizes execution, cancels obsolete reads. NEVER touches blockchain state.
 * Attached to window.RPCRequestManager
 */
(function () {
  'use strict';

  try { if (typeof FeatureFlags !== 'undefined' && !FeatureFlags.isEnabled('ENABLE_RPC_REQUEST_MANAGER')) { window.RPCRequestManager = { coalesce: function(e,p,fn){return fn()}, cancelReadRequests: function(){}, getStats: function(){return{}}, pause: function(){}, resume: function(){} }; return; } } catch(_f) {}

  var _inflight = {};     // key → {promise, count, priority, ts}
  var _stats = { deduped: 0, coalesced: 0, cancelled: 0, total: 0, byPriority: { high: 0, medium: 0, low: 0 } };
  var _active = true;

  function _key(endpoint, params) {
    try { return endpoint + '::' + JSON.stringify(params || {}); } catch (_e) { return endpoint + '::' + Date.now(); }
  }

  function _priorityFor(endpoint) {
    var ep = (endpoint || '').toLowerCase();
    if (/depositForBurn|receiveMessage|approve|transfer|execute|fulfill|mint|sendTransaction|swap|bridge/.test(ep)) return 'high';
    if (/balanceOf|getBalance|getReserves|getBlockNumber|totalSupply|name|symbol|decimals|portfolio|treasury/.test(ep)) return 'medium';
    return 'low';
  }

  function _cleanup() {
    var now = Date.now();
    var keys = Object.keys(_inflight);
    for (var i = 0; i < keys.length; i++) {
      if (now - _inflight[keys[i]].ts > 60000) { delete _inflight[keys[i]]; _stats.cancelled++; }
    }
  }
  setInterval(_cleanup, 30000);

  function coalesce(endpoint, params, doRequest) {
    if (!_active) return doRequest();
    var key = _key(endpoint, params);
    var pri = _priorityFor(endpoint);
    _stats.total++;
    _stats.byPriority[pri] = (_stats.byPriority[pri] || 0) + 1;

    if (_inflight[key]) {
      _inflight[key].count++;
      _stats.coalesced++;
      if (typeof PerfMetrics !== 'undefined') PerfMetrics.recordRPC(endpoint, 0, true);
      return _inflight[key].promise;
    }

    var startTime = Date.now();
    var promise = doRequest().then(function (result) {
      delete _inflight[key];
      if (typeof RuntimeHealthMonitor !== 'undefined') RuntimeHealthMonitor.recordRPC(Date.now() - startTime, true);
      if (typeof PerfMetrics !== 'undefined') PerfMetrics.recordRPC(endpoint, Date.now() - startTime, true);
      return result;
    }).catch(function (err) {
      delete _inflight[key];
      if (typeof RuntimeHealthMonitor !== 'undefined') RuntimeHealthMonitor.recordRPC(Date.now() - startTime, false);
      if (typeof PerfMetrics !== 'undefined') PerfMetrics.recordRPC(endpoint, Date.now() - startTime, false);
      throw err;
    });

    _inflight[key] = { promise: promise, count: 1, priority: pri, ts: Date.now() };
    return promise;
  }

  function cancelReadRequests() {
    var keys = Object.keys(_inflight);
    for (var i = 0; i < keys.length; i++) {
      var entry = _inflight[keys[i]];
      if (entry.priority !== 'high') { delete _inflight[keys[i]]; _stats.cancelled++; }
    }
  }

  function getStats() {
    var inflightCount = Object.keys(_inflight).length;
    return {
      inflight: inflightCount,
      total: _stats.total,
      coalesced: _stats.coalesced,
      cancelled: _stats.cancelled,
      dedupRatio: _stats.total > 0 ? Math.round((_stats.coalesced / _stats.total) * 100) : 0,
      byPriority: _stats.byPriority
    };
  }

  function pause() { _active = false; }
  function resume() { _active = true; }

  window.RPCRequestManager = {
    coalesce: coalesce,
    cancelReadRequests: cancelReadRequests,
    getStats: getStats,
    pause: pause,
    resume: resume
  };
})();
