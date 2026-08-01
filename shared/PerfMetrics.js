/**
 * PerfMetrics — Performance instrumentation. Read-only. Never blocks.
 * Attached to window.PerfMetrics
 */
(function () {
  'use strict';

  try { if (typeof FeatureFlags !== 'undefined' && !FeatureFlags.isEnabled('ENABLE_PERF_METRICS')) { window.PerfMetrics = { recordModuleLoad: function(){}, recordRPC: function(){}, recordExec: function(){}, recordRender: function(){}, getReport: function(){return{}} }; return; } } catch(_f) {}

  var _pageStart = performance.timing ? performance.timing.navigationStart : Date.now();
  var _moduleLoads = {};
  var _rpcRecords = [];
  var _execRecords = [];
  var _renderRecords = [];

  function recordModuleLoad(name, durationMs) { _moduleLoads[name] = durationMs; }

  function recordRPC(endpoint, durationMs, success) {
    _rpcRecords.push({ endpoint: endpoint, duration: durationMs, success: success, ts: Date.now() });
    if (_rpcRecords.length > 200) _rpcRecords.shift();
  }

  function recordExec(operation, durationMs) { _execRecords.push({ op: operation, dur: durationMs, ts: Date.now() }); if (_execRecords.length > 100) _execRecords.shift(); }
  function recordRender(page, durationMs) { _renderRecords.push({ page: page, dur: durationMs, ts: Date.now() }); if (_renderRecords.length > 50) _renderRecords.shift(); }

  function _avg(arr, field) { if (!arr.length) return 0; var s = 0; for (var i = 0; i < arr.length; i++) s += arr[i][field]; return Math.round(s / arr.length); }

  function getReport() {
    var now = Date.now();
    return {
      pageLoadMs: now - _pageStart,
      moduleCount: Object.keys(_moduleLoads).length,
      moduleLoadTotalMs: Object.values(_moduleLoads).reduce(function(a,b){return a+b;},0),
      rpcCount: _rpcRecords.length,
      rpcAvgMs: _avg(_rpcRecords, 'duration'),
      rpcSuccessRate: _rpcRecords.length ? Math.round(_rpcRecords.filter(function(r){return r.success;}).length / _rpcRecords.length * 100) : 100,
      execCount: _execRecords.length,
      execAvgMs: _avg(_execRecords, 'dur'),
      renderAvgMs: _avg(_renderRecords, 'dur'),
      moduleLoads: _moduleLoads
    };
  }

  window.PerfMetrics = {
    recordModuleLoad: recordModuleLoad,
    recordRPC: recordRPC,
    recordExec: recordExec,
    recordRender: recordRender,
    getReport: getReport
  };
})();
