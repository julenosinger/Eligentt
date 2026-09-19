/**
 * AIWallet ApprovalEngine — Intent Approval Wrapper (Phase 4)
 * Wraps AIWallet.approveRequest / rejectRequest / renderApprovals.
 * Attached to: window.AIWApprovalEngine
 */
(function () {
  'use strict';
  var _init = false;

  function initialize() { if (_init) return; _init = true; }

  function approve(id) {
    try {
      if (typeof AIWallet !== 'undefined' && AIWallet.approveRequest) { AIWallet.approveRequest(id); return true; }
    } catch (e) {
      try { if (typeof ErrorHandler !== 'undefined') ErrorHandler.handle(e, { source: 'aiwallet.approval', operation: 'approve' }); } catch (_e) {}
    }
    return false;
  }

  function reject(id) {
    try {
      if (typeof AIWallet !== 'undefined' && AIWallet.rejectRequest) { AIWallet.rejectRequest(id); return true; }
    } catch (e) {
      try { if (typeof ErrorHandler !== 'undefined') ErrorHandler.handle(e, { source: 'aiwallet.approval', operation: 'reject' }); } catch (_e) {}
    }
    return false;
  }

  function render() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.renderApprovals) AIWallet.renderApprovals(); } catch (_e) {}
  }

  function refresh() { render(); }
  function destroy() { _init = false; }

  window.AIWApprovalEngine = {
    VERSION: '1.0.0',
    initialize: initialize, approve: approve, reject: reject,
    render: render, refresh: refresh, destroy: destroy
  };
})();
