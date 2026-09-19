/**
 * HistoryDomain — Transaction history & timeline (Phase 3)
 * Wraps existing txHistory global + queue table. Never duplicates logic.
 * Attached to: window.HistoryDomain
 */
(function () {
  'use strict';
  var _init = false;

  function initialize() { if (_init) return; _init = true; }

  function getAll() {
    try { return typeof txHistory !== 'undefined' ? txHistory.slice() : []; } catch (_e) { return []; }
  }

  function getByDateRange(startDate, endDate) {
    var all = getAll();
    return all.filter(function (t) {
      var d = new Date(t.date);
      return d >= startDate && d <= endDate;
    });
  }

  function getByType(type) {
    return getAll().filter(function (t) { return t.type === type; });
  }

  function getByStatus(status) {
    return getAll().filter(function (t) { return t.status === status; });
  }

  function search(query) {
    if (!query) return getAll();
    var q = query.toLowerCase();
    return getAll().filter(function (t) {
      return (t.id || '').toLowerCase().indexOf(q) !== -1 || (t.txHash || '').toLowerCase().indexOf(q) !== -1 || (t.type || '').toLowerCase().indexOf(q) !== -1;
    });
  }

  function getPaged(page, pageSize) {
    var all = getAll();
    pageSize = pageSize || 20;
    page = Math.max(0, page || 0);
    var start = page * pageSize;
    return {
      items: all.slice(start, start + pageSize),
      total: all.length,
      page: page,
      pageSize: pageSize,
      totalPages: Math.ceil(all.length / pageSize)
    };
  }

  function getTimeline(days) {
    var cutoff = new Date(Date.now() - (days || 30) * 86400000);
    return getAll().filter(function (t) { return new Date(t.date) >= cutoff; }).sort(function (a, b) { return new Date(b.date) - new Date(a.date); });
  }

  function getSummary() {
    var all = getAll();
    return {
      totalTransactions: all.length,
      totalVolume: all.reduce(function (s, t) { return s + (t.amount || 0); }, 0),
      totalFees: all.reduce(function (s, t) { return s + (t.fee || 0); }, 0),
      successRate: all.length > 0 ? Math.round((all.filter(function (t) { return t.status === 'Success' || t.status === 'completed'; }).length / all.length) * 100) : 0
    };
  }

  function refresh() {
    try { if (typeof renderQueueTable === 'function') renderQueueTable(); } catch (_e) {}
    try { if (typeof updateQueueStats === 'function') updateQueueStats(); } catch (_e2) {}
  }

  function destroy() { _init = false; }

  window.HistoryDomain = {
    VERSION: '1.0.0',
    initialize: initialize, getAll: getAll, getByDateRange: getByDateRange,
    getByType: getByType, getByStatus: getByStatus, search: search,
    getPaged: getPaged, getTimeline: getTimeline, getSummary: getSummary,
    refresh: refresh, destroy: destroy
  };
})();
