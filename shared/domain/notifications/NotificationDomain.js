/**
 * NotificationDomain — Notification routing & management (Phase 3)
 * Wraps existing toast() + NotificationService. Never duplicates logic.
 * Attached to: window.NotificationDomain
 */
(function () {
  'use strict';
  var _init = false, _subs = [];

  function initialize() {
    if (_init) return; _init = true;
    if (typeof EventBus !== 'undefined') {
      _subs.push(EventBus.on('NOTIFICATION', _onNotification));
    }
  }

  function _onNotification(payload) {
    try {
      if (typeof toast === 'function') toast(payload.message, payload.type);
    } catch (_e) {}
  }

  function success(msg) {
    try { if (typeof NotificationService !== 'undefined') NotificationService.success(msg); else if (typeof toast === 'function') toast(msg, 'success'); } catch (_e) {}
  }

  function error(msg) {
    try { if (typeof NotificationService !== 'undefined') NotificationService.error(msg); else if (typeof toast === 'function') toast(msg, 'error'); } catch (_e) {}
  }

  function warning(msg) {
    try { if (typeof NotificationService !== 'undefined') NotificationService.warning(msg); else if (typeof toast === 'function') toast(msg, 'warning'); } catch (_e) {}
  }

  function info(msg) {
    try { if (typeof NotificationService !== 'undefined') NotificationService.info(msg); else if (typeof toast === 'function') toast(msg, 'info'); } catch (_e) {}
  }

  /**
   * Notify user about a domain event (e.g. "Swap completed", "Bridge initiated").
   * Translates internal event types to user-friendly messages.
   */
  function notifyEvent(eventType, detail) {
    var messages = {
      swap_completed: 'Swap completed successfully',
      swap_failed: 'Swap failed',
      bridge_completed: 'Bridge completed successfully',
      bridge_failed: 'Bridge failed — please try again',
      bridge_initiated: 'Bridge initiated — monitoring for confirmation',
      payment_sent: 'Payment sent',
      schedule_created: 'Schedule created',
      schedule_executed: 'Schedule executed',
      wallet_connected: 'Wallet connected',
      wallet_disconnected: 'Wallet disconnected',
      chain_changed: 'Network changed',
      vault_updated: 'Vault updated',
      report_generated: 'Report generated',
      automation_triggered: 'Automation triggered'
    };
    var msg = messages[eventType] || eventType;
    if (detail) msg += (': ' + detail);
    info(msg);
  }

  function refresh() {}
  function destroy() { _subs.forEach(function (s) { try { s.off(); } catch (_e) {} }); _subs = []; _init = false; }

  window.NotificationDomain = {
    VERSION: '1.0.0',
    initialize: initialize, success: success, error: error, warning: warning, info: info,
    notifyEvent: notifyEvent, refresh: refresh, destroy: destroy
  };
})();
