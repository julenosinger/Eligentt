/**
 * HistoryRenderer — History/Transactions UI wrapper (Phase 2)
 * Attached to: window.HistoryRenderer
 */
(function () {
  'use strict';
  var _init = false, _subs = [];

  function initialize() {
    if (_init) return; _init = true;
    if (typeof EventBus !== 'undefined') {
      _subs.push(EventBus.on('PAGE_CHANGED', function (p) { if (p && p.page === 'history') render(); }));
    }
  }
  function render() {
    try { if (typeof renderQueueTable === 'function') renderQueueTable(); } catch (_e) {}
    try { if (typeof updateQueueStats === 'function') updateQueueStats(); } catch (_e) {}
  }
  function refresh() { render(); }
  function destroy() { _subs.forEach(function (s) { try { s.off(); } catch (_e) {} }); _subs = []; _init = false; }

  window.HistoryRenderer = { VERSION: '1.0.0', initialize: initialize, render: render, refresh: refresh, destroy: destroy };
})();
