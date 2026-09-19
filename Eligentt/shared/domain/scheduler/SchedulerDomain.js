/**
 * SchedulerDomain — Schedule orchestration (Phase 3)
 * Wraps existing ScheduleEngine. Never duplicates logic.
 * Attached to: window.SchedulerDomain
 */
(function () {
  'use strict';
  var _init = false, _subs = [];

  function initialize() {
    if (_init) return; _init = true;
    if (typeof EventBus !== 'undefined') {
      _subs.push(EventBus.on('PAGE_CHANGED', function (p) { if (p && p.page === 'schedule') refresh(); }));
    }
    try {
      if (typeof ScheduleEngine !== 'undefined') {
        ScheduleEngine.on('CREATED', function () { refresh(); });
        ScheduleEngine.on('UPDATED', function () { refresh(); });
        ScheduleEngine.on('DELETED', function () { refresh(); });
      }
    } catch (_e) {}
  }

  function create(params) {
    try {
      if (typeof ScheduleEngine !== 'undefined' && ScheduleEngine.create) {
        return ScheduleEngine.create(params);
      }
    } catch (e) {
      try { if (typeof ErrorHandler !== 'undefined') ErrorHandler.handle(e, { source: 'scheduler', operation: 'create' }); } catch (_e) {}
    }
    return null;
  }

  function update(id, patch) {
    try {
      if (typeof ScheduleEngine !== 'undefined' && ScheduleEngine.update) {
        ScheduleEngine.update(id, patch);
        return true;
      }
    } catch (_e) {}
    return false;
  }

  function remove(id) {
    try {
      if (typeof ScheduleEngine !== 'undefined' && ScheduleEngine.delete) {
        ScheduleEngine.delete(id);
        return true;
      }
    } catch (_e) {}
    return false;
  }

  function pause(id) {
    return update(id, { status: 'Paused' });
  }

  function resume(id) {
    return update(id, { status: 'Active' });
  }

  function cancel(id) {
    return update(id, { status: 'Cancelled' });
  }

  function getAll() {
    try { if (typeof ScheduleEngine !== 'undefined' && ScheduleEngine.getAll) return ScheduleEngine.getAll(); } catch (_e) {}
    try { if (typeof schedules !== 'undefined') return schedules; } catch (_e2) {}
    return [];
  }

  function getById(id) {
    try { if (typeof ScheduleEngine !== 'undefined' && ScheduleEngine.getById) return ScheduleEngine.getById(id); } catch (_e) {}
    return null;
  }

  function validate(params) {
    var p = params || {};
    if (!p.type) return { valid: false, reason: 'Type required' };
    if (!p.amount || Number(p.amount) <= 0) return { valid: false, reason: 'Amount required' };
    return { valid: true };
  }

  function executeAll() {
    try { if (typeof checkDueSchedules === 'function') checkDueSchedules(); } catch (_e) {}
  }

  function refresh() {
    try {
      if (typeof ScheduleEngine !== 'undefined') { schedules = ScheduleEngine.getAll(); }
      if (typeof renderSchedules === 'function') renderSchedules();
    } catch (_e) {}
  }

  function destroy() { _subs.forEach(function (s) { try { s.off(); } catch (_e) {} }); _subs = []; _init = false; }

  window.SchedulerDomain = {
    VERSION: '1.0.0',
    initialize: initialize, validate: validate, create: create, update: update, remove: remove,
    pause: pause, resume: resume, cancel: cancel, getAll: getAll, getById: getById,
    executeAll: executeAll, refresh: refresh, destroy: destroy
  };
})();
