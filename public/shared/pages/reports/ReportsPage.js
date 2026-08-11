/**
 * ReportsPage — Extracted Reports Feature Module (Phase 14.1)
 * Migrates: renderReports, report filters, metrics display.
 * Attached to: window.ReportsPage
 */
(function () {
  'use strict';
  var _init = false, _subs = [];

  function initialize() {
    if (_init) return; _init = true;
    try {
      if (typeof EventBus !== 'undefined') {
        _subs.push(EventBus.on('PAGE_CHANGED', function (p) { if (p && p.page === 'reports') render(); }));
      }
      if (typeof TabManager !== 'undefined') TabManager.register('reports', { init: render });
    } catch (_e) {}
  }

  function render() {
    try { if (typeof ReportsDomain !== 'undefined') ReportsDomain.refresh(); else if (typeof renderReports === 'function') renderReports(); } catch (_e) {}
  }

  function generate(type) {
    try { if (typeof ReportsDomain !== 'undefined') return ReportsDomain.generateReport(type); } catch (_e) {}
    try { if (typeof renderReports === 'function') { renderReports(); return { type: type }; } } catch (_e2) {}
    return null;
  }

  function exportCSV() {
    try { if (typeof ReportsDomain !== 'undefined') return ReportsDomain.exportReportCSV(); } catch (_e) {}
    return false;
  }

  function destroy() { _subs.forEach(function (s) { try { s.off(); } catch (_e) {} }); _subs = []; _init = false; }

  window.ReportsPage = { VERSION: '14.0.0', initialize: initialize, render: render, generate: generate, exportCSV: exportCSV, destroy: destroy };
})();
