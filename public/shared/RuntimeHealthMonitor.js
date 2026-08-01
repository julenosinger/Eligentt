/**
 * RuntimeHealthMonitor — Lightweight read-only diagnostic tracker.
 * NEVER interferes with runtime. Purely diagnostic.
 * Attached to window.RuntimeHealthMonitor
 */
(function () {
  'use strict';

  try { if (typeof FeatureFlags !== 'undefined' && !FeatureFlags.isEnabled('ENABLE_RUNTIME_HEALTH')) { window.RuntimeHealthMonitor = { getSnapshot: function(){return{}}, recordRPC: function(){}, recordRender: function(){}, recordExec: function(){}, recordMemory: function(){}, updateQueue: function(){} }; return; } } catch(_f) {}

  var _startTime = Date.now();
  var _metrics = { timers: 0, intervals: 0, listeners: 0, rpcCalls: 0, rpcFailures: 0, rpcLatencies: [] };
  var _queues = { schedule: 0, approval: 0, autonoma: 0, agentWallet: 0, crosschain: 0, bridge: 0, swap: 0 };
  var _renderCount = 0;
  var _renderTimes = [];
  var _execTimes = [];
  var _memorySnapshots = [];

  var _origSetInterval = window.setInterval;
  var _origSetTimeout = window.setTimeout;
  var _origAddEventListener = EventTarget.prototype.addEventListener;

  window.setInterval = function (fn, ms) {
    _metrics.intervals++;
    return _origSetInterval.call(window, fn, ms);
  };
  window.setTimeout = function (fn, ms) {
    _metrics.timers++;
    return _origSetTimeout.call(window, fn, ms);
  };
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    _metrics.listeners++;
    return _origAddEventListener.call(this, type, listener, options);
  };

  function recordRPC(latencyMs, success) {
    _metrics.rpcCalls++;
    if (!success) _metrics.rpcFailures++;
    if (_metrics.rpcLatencies.length > 200) _metrics.rpcLatencies.shift();
    _metrics.rpcLatencies.push(latencyMs);
  }

  function recordRender(durationMs) { _renderCount++; _renderTimes.push(durationMs); if (_renderTimes.length > 100) _renderTimes.shift(); }
  function recordExec(durationMs) { _execTimes.push(durationMs); if (_execTimes.length > 100) _execTimes.shift(); }
  function recordMemory() { if (window.performance && performance.memory) _memorySnapshots.push({ ts: Date.now(), used: performance.memory.usedJSHeapSize }); if (_memorySnapshots.length > 50) _memorySnapshots.shift(); }
  function updateQueue(name, size) { if (_queues[name] !== undefined) _queues[name] = size; }

  function _avg(arr) { if (!arr.length) return 0; var s = 0; for (var i = 0; i < arr.length; i++) s += arr[i]; return Math.round(s / arr.length); }

  function getSnapshot() {
    recordMemory();
    return {
      uptime: Math.round((Date.now() - _startTime) / 1000),
      timers: _metrics.timers,
      intervals: _metrics.intervals,
      listeners: _metrics.listeners,
      rpcCalls: _metrics.rpcCalls,
      rpcFailures: _metrics.rpcFailures,
      rpcAvgLatency: _avg(_metrics.rpcLatencies),
      renderCount: _renderCount,
      renderAvgMs: _avg(_renderTimes),
      execAvgMs: _avg(_execTimes),
      memoryUsed: _memorySnapshots.length ? _memorySnapshots[_memorySnapshots.length - 1].used : 0,
      queues: _queues,
      startTime: _startTime
    };
  }

  setInterval(recordMemory, 30000);

  window.RuntimeHealthMonitor = {
    getSnapshot: getSnapshot,
    recordRPC: recordRPC,
    recordRender: recordRender,
    recordExec: recordExec,
    recordMemory: recordMemory,
    updateQueue: updateQueue
  };
})();
