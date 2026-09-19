/**
 * Elligentt WorkflowManager — Centralized workflow/automation/schedule orchestrator (Phase 6)
 * Attached to: window.WorkflowManager
 */
(function () {
  'use strict';
  var _workflows = [];
  var TRIGGERS = ['time_daily', 'time_weekly', 'time_monthly', 'asset_received', 'gas_below', 'schedule_executed', 'portfolio_drop', 'custom'];

  function register(wf) {
    if (!wf || !wf.id) return false;
    _workflows.push(wf);
    try { if (typeof EventBus !== 'undefined') EventBus.emit('WORKFLOW_REGISTERED', { id: wf.id }); } catch (_e) {}
    return true;
  }

  function get(id) { return _workflows.find(function (w) { return w.id === id; }) || null; }
  function getAll() { return _workflows.slice(); }
  function getByTrigger(trigger) { return _workflows.filter(function (w) { return w.trigger === trigger; }); }
  function getActive() { return _workflows.filter(function (w) { return w.status === 'active' || w.status === 'running'; }); }

  function update(id, patch) {
    var wf = get(id); if (!wf) return false;
    Object.assign(wf, patch); return true;
  }

  function remove(id) { var len = _workflows.length; _workflows = _workflows.filter(function (w) { return w.id !== id; }); return _workflows.length < len; }

  function getStats() {
    return {
      total: _workflows.length,
      active: _workflows.filter(function (w) { return w.status === 'active'; }).length,
      running: _workflows.filter(function (w) { return w.status === 'running'; }).length,
      completed: _workflows.filter(function (w) { return w.status === 'completed'; }).length,
      failed: _workflows.filter(function (w) { return w.status === 'failed'; }).length
    };
  }

  function clear() { _workflows = []; }

  window.WorkflowManager = {
    VERSION: '1.0.0', TRIGGERS: TRIGGERS,
    register: register, get: get, getAll: getAll, getByTrigger: getByTrigger, getActive: getActive,
    update: update, remove: remove, getStats: getStats, clear: clear
  };
})();
