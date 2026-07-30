/**
 * Elligentt ExecutionCoordinator — Single execution orchestrator (Phase 6)
 * Prevents duplicates, race conditions, concurrency conflicts. Assigns trace IDs.
 * Attached to: window.ExecutionCoordinator
 */
(function () {
  'use strict';
  var _executions = {};
  var _counter = 0;

  function generateId() { _counter++; return 'EXEC_' + Date.now().toString(36) + '_' + _counter; }

  function begin(op, params) {
    var id = generateId();
    var dedupKey = _dedupKey(op, params);
    if (_executions[dedupKey] && Date.now() - _executions[dedupKey].started < 60000) return null; // duplicate
    _executions[dedupKey] = { id: id, op: op, params: params, started: Date.now(), status: 'executing' };
    try { if (typeof EventBus !== 'undefined') EventBus.emit('EXECUTION_BEGAN', { id: id, op: op }); } catch (_e) {}
    return id;
  }

  function complete(execId, result) {
    var keys = Object.keys(_executions);
    for (var i = 0; i < keys.length; i++) {
      if (_executions[keys[i]].id === execId) { _executions[keys[i]].status = 'completed'; _executions[keys[i]].completedAt = Date.now(); _executions[keys[i]].result = result; break; }
    }
    try { if (typeof EventBus !== 'undefined') EventBus.emit('EXECUTION_COMPLETED', { id: execId }); } catch (_e) {}
  }

  function fail(execId, error) {
    var keys = Object.keys(_executions);
    for (var i = 0; i < keys.length; i++) {
      if (_executions[keys[i]].id === execId) { _executions[keys[i]].status = 'failed'; _executions[keys[i]].error = error; break; }
    }
    try { if (typeof EventBus !== 'undefined') EventBus.emit('EXECUTION_FAILED', { id: execId, error: error }); } catch (_e) {}
  }

  function _dedupKey(op, params) {
    var p = params || {};
    return op + '|' + (p.token || '') + '|' + (p.amount || '') + '|' + (p.to || '') + '|' + (p.from || '');
  }

  function getActive() {
    return Object.values(_executions).filter(function (e) { return e.status === 'executing'; });
  }

  function getTimeline(limit) {
    return Object.values(_executions).sort(function (a, b) { return b.started - a.started; }).slice(0, limit || 50);
  }

  function clear() { _executions = {}; _counter = 0; }

  window.ExecutionCoordinator = {
    VERSION: '1.0.0', generateId: generateId, begin: begin, complete: complete, fail: fail,
    getActive: getActive, getTimeline: getTimeline, clear: clear
  };
})();
