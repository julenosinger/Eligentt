/**
 * AIWallet NotificationEngine — Assistant & Notifications (Phase 4)
 * Attached to: window.AIWNotificationEngine
 */
(function () {
  'use strict';
  var _init = false;

  function initialize() { if (_init) return; _init = true; }

  function sendAssistantMessage() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.assistantSend) AIWallet.assistantSend(); } catch (_e) {}
  }

  function quickAssistant(prompt) {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.asstQuick) AIWallet.asstQuick(prompt); } catch (_e) {}
  }

  function notify(msg, kind) {
    try { if (typeof toast === 'function') toast(msg, kind || 'info'); } catch (_e) {}
  }

  function renderStatus() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.renderStatus) AIWallet.renderStatus(); } catch (_e) {}
  }

  function refresh() { renderStatus(); }
  function destroy() { _init = false; }

  window.AIWNotificationEngine = {
    VERSION: '1.0.0',
    initialize: initialize, sendAssistantMessage: sendAssistantMessage,
    quickAssistant: quickAssistant, notify: notify,
    renderStatus: renderStatus, refresh: refresh, destroy: destroy
  };
})();
