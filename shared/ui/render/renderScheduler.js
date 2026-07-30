/**
 * SchedulerRenderer — Schedule UI wrapper (Phase 2)
 * Attached to: window.SchedulerRenderer
 */
(function () {
  'use strict';
  var _init = false, _subs = [];

  function initialize() {
    if (_init) return; _init = true;
    if (typeof EventBus !== 'undefined') {
      _subs.push(EventBus.on('PAGE_CHANGED', function (p) { if (p && p.page === 'schedule') render(); }));
      _subs.push(EventBus.on('SETTINGS_CHANGED', function () { render(); }));
    }
    try {
      if (typeof ScheduleEngine !== 'undefined') {
        ScheduleEngine.on('CREATED', function () { render(); });
        ScheduleEngine.on('UPDATED', function () { render(); });
        ScheduleEngine.on('DELETED', function () { render(); });
      }
    } catch (_e) {}
  }
  function render() {
    try {
      if (typeof ScheduleEngine !== 'undefined') { schedules = ScheduleEngine.getAll(); }
    } catch (_e) {}
    try { if (typeof renderSchedules === 'function') renderSchedules(); } catch (_e2) {}
  }
  function refresh() { render(); }
  function destroy() { _subs.forEach(function (s) { try { s.off(); } catch (_e) {} }); _subs = []; _init = false; }

  window.SchedulerRenderer = { VERSION: '1.0.0', initialize: initialize, render: render, refresh: refresh, destroy: destroy };
})();
