/**
 * HistoryPage — Extracted History Feature Module (Phase 14.1)
 * Migrates: renderQueueTable, transaction history, timeline.
 * Attached to: window.HistoryPage
 */
(function () {
  'use strict';
  var _init = false, _subs = [];

  function initialize() {
    if (_init) return; _init = true;
    try {
      if (typeof EventBus !== 'undefined') {
        _subs.push(EventBus.on('PAGE_CHANGED', function (p) { if (p && p.page === 'queue') render(); }));
        _subs.push(EventBus.on('EXECUTION_COMPLETED', function () { render(); }));
      }
      if (typeof TabManager !== 'undefined') TabManager.register('queue', { init: render });
    } catch (_e) {}
  }

  function render() {
    try { if (typeof HistoryDomain !== 'undefined') HistoryDomain.refresh(); else if (typeof renderQueueTable === 'function') renderQueueTable(); } catch (_e) {}
    try { if (typeof updateQueueStats === 'function') updateQueueStats(); } catch (_e2) {}
  }

  function getTimeline(days) {
    try { if (typeof HistoryDomain !== 'undefined') return HistoryDomain.getTimeline(days); } catch (_e) {}
    return [];
  }

  function getSummary() {
    try { if (typeof HistoryDomain !== 'undefined') return HistoryDomain.getSummary(); } catch (_e) {}
    return {};
  }

  function destroy() { _subs.forEach(function (s) { try { s.off(); } catch (_e) {} }); _subs = []; _init = false; }

  window.HistoryPage = { VERSION: '14.0.0', initialize: initialize, render: render, getTimeline: getTimeline, getSummary: getSummary, destroy: destroy };
})();
