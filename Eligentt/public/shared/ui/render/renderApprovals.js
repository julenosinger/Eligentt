/**
 * ApprovalsRenderer — AI Approval Center UI wrapper (Phase 2)
 * Attached to: window.ApprovalsRenderer
 */
(function () {
  'use strict';
  var _init = false, _subs = [];

  function initialize() {
    if (_init) return; _init = true;
    if (typeof EventBus !== 'undefined') {
      _subs.push(EventBus.on('PAGE_CHANGED', function (p) { if (p && p.page === 'aiwallet') render(); }));
    }
  }
  function render() {
    try {
      if (typeof AIWallet !== 'undefined' && AIWallet.renderApprovals) AIWallet.renderApprovals();
    } catch (_e) {}
  }
  function refresh() { render(); }
  function destroy() { _subs.forEach(function (s) { try { s.off(); } catch (_e) {} }); _subs = []; _init = false; }

  window.ApprovalsRenderer = { VERSION: '1.0.0', initialize: initialize, render: render, refresh: refresh, destroy: destroy };
})();
