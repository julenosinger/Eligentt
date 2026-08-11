/**
 * SchedulerPage — Extracted Scheduler Feature Module (Phase 14.3)
 * Migrates: renderSchedules, checkDueSchedules, schedule CRUD.
 * Attached to: window.SchedulerPage
 */
(function () {
  'use strict';
  var _init = false, _subs = [];

  function initialize() {
    if (_init) return; _init = true;
    try {
      if (typeof EventBus !== 'undefined') {
        _subs.push(EventBus.on('PAGE_CHANGED', function (p) { if (p && p.page === 'schedule') render(); }));
        _subs.push(EventBus.on('SCHEDULE_CREATED', function () { render(); }));
        _subs.push(EventBus.on('SCHEDULE_UPDATED', function () { render(); }));
      }
      if (typeof TabManager !== 'undefined') TabManager.register('schedule', { init: render });
    } catch (_e) {}
  }

  function render() {
    try { if (typeof Migrate !== 'undefined') Migrate.scheduler_render(); else if (typeof renderSchedules === 'function') renderSchedules(); } catch (_e) {}
  }

  function create(params) {
    try { if (typeof CoreMigrate !== 'undefined') return CoreMigrate.scheduler_create(params); } catch (_e) {}
    try { if (typeof SchedulerDomain !== 'undefined') return SchedulerDomain.create(params); } catch (_e2) {}
    return null;
  }

  function executeAll() {
    try { if (typeof CoreMigrate !== 'undefined') return CoreMigrate.scheduler_executeAll(); } catch (_e) {}
    return false;
  }

  function pause(id) {
    try { if (typeof CoreMigrate !== 'undefined') return CoreMigrate.scheduler_pause(id); } catch (_e) {}
    return false;
  }

  function destroy() { _subs.forEach(function (s) { try { s.off(); } catch (_e) {} }); _subs = []; _init = false; }

  window.SchedulerPage = { VERSION: '14.0.0', initialize: initialize, render: render, create: create, executeAll: executeAll, pause: pause, destroy: destroy };
})();
