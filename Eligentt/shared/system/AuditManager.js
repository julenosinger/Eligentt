/**
 * Elligentt AuditManager — Immutable audit trail (Phase 6)
 * Intent → Validation → Approval → Execution → Completion → Failure → Cancellation → Recovery.
 * Generates trace IDs. No business logic.
 * Attached to: window.AuditManager
 */
(function () {
  'use strict';
  var _trail = [];
  var MAX_TRAIL = 500;
  var _counter = 0;

  function generateTraceId() { _counter++; return 'TRACE_' + Date.now().toString(36).toUpperCase() + '_' + _counter; }

  function log(event, detail) {
    var entry = {
      traceId: detail && detail.traceId ? detail.traceId : generateTraceId(),
      event: event,
      detail: detail || {},
      timestamp: Date.now(),
      iso: new Date().toISOString()
    };
    _trail.unshift(entry);
    if (_trail.length > MAX_TRAIL) _trail.length = MAX_TRAIL;
    try { if (typeof EventBus !== 'undefined') EventBus.emit('AUDIT_LOG', entry); } catch (_e) {}
    return entry.traceId;
  }

  function getTrail(limit) { return _trail.slice(0, limit || 50); }
  function getByTrace(traceId) { return _trail.filter(function (t) { return t.traceId === traceId; }); }
  function getByEvent(event, limit) { return _trail.filter(function (t) { return t.event === event; }).slice(0, limit || 50); }
  function getCount() { return _trail.length; }
  function exportTrail() { return { exportedAt: new Date().toISOString(), count: _trail.length, trail: _trail.slice() }; }
  function clear() { _trail = []; _counter = 0; }

  window.AuditManager = {
    VERSION: '1.0.0', generateTraceId: generateTraceId, log: log,
    getTrail: getTrail, getByTrace: getByTrace, getByEvent: getByEvent,
    getCount: getCount, exportTrail: exportTrail, clear: clear
  };
})();
