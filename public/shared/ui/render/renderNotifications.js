/**
 * NotificationsRenderer — Notifications UI wrapper (Phase 2)
 * Attached to: window.NotificationsRenderer
 */
(function () {
  'use strict';
  var _init = false, _subs = [];

  function initialize() {
    if (_init) return; _init = true;
    if (typeof EventBus !== 'undefined') {
      _subs.push(EventBus.on('NOTIFICATION', function (payload) { _renderToast(payload); }));
    }
  }
  function _renderToast(payload) {
    try { if (typeof toast !== 'function') return; toast(payload.message, payload.type); } catch (_e) {}
  }
  function render() {
    try { if (typeof updateQueueStats === 'function') updateQueueStats(); } catch (_e) {}
    try { if (typeof updateInvStats === 'function') updateInvStats(); } catch (_e2) {}
  }
  function refresh() { render(); }
  function destroy() { _subs.forEach(function (s) { try { s.off(); } catch (_e) {} }); _subs = []; _init = false; }

  window.NotificationsRenderer = { VERSION: '1.0.0', initialize: initialize, render: render, refresh: refresh, destroy: destroy };
})();
