/**
 * ReportsDomain — Report generation & export (Phase 3)
 * Wraps existing renderReports + txHistory. Never duplicates logic.
 * Attached to: window.ReportsDomain
 */
(function () {
  'use strict';
  var _init = false;

  function initialize() { if (_init) return; _init = true; }

  function getMetrics(periodDays) {
    var days = periodDays || 30;
    var cutoff = new Date(Date.now() - days * 86400000);
    var data;
    try { data = typeof txHistory !== 'undefined' ? txHistory.filter(function (t) { return new Date(t.date) >= cutoff; }) : []; } catch (_e) { data = []; }

    var total = data.reduce(function (s, t) { return s + (t.amount || 0); }, 0);
    var fees = data.reduce(function (s, t) { return s + (t.fee || 0); }, 0);
    var count = data.length;
    var avg = count > 0 ? total / count : 0;

    return { periodDays: days, totalSent: total, totalFees: fees, transactionCount: count, recipientCount: data.reduce(function (s, t) { return s + (t.recipients || 0); }, 0), averageAmount: avg };
  }

  function generateReport(type) {
    try { if (typeof renderReports === 'function') renderReports(); } catch (_e) {}
    return getMetrics(type === 'weekly' ? 7 : type === 'monthly' ? 30 : 1);
  }

  function exportReportCSV(data) {
    try { if (typeof exportReportCSV === 'function') { exportReportCSV(); return true; } } catch (_e) {}
    return false;
  }

  function refresh() {
    try { if (typeof renderReports === 'function') renderReports(); } catch (_e) {}
  }

  function destroy() { _init = false; }

  window.ReportsDomain = {
    VERSION: '1.0.0',
    initialize: initialize, getMetrics: getMetrics, generateReport: generateReport,
    exportReportCSV: exportReportCSV, refresh: refresh, destroy: destroy
  };
})();
