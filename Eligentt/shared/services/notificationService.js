/**
 * Elligentt NotificationService — Centralized Notification System (Phase 1 Architecture)
 *
 * Routes all notifications through a single service. Does NOT change appearance.
 * Delegates to existing toast() function for backward compatibility.
 * Also emits through EventBus for future consumers.
 *
 * Attached to: window.NotificationService
 *
 * @module notificationService
 * @version 1.0.0
 */
(function () {
  'use strict';

  /** @type {{ type: string, message: string, timestamp: number }[]} */
  var _history = [];
  var MAX_HISTORY = 200;

  /** @type {number} */
  var _count = 0;

  /* ════════════════════════════════════════════
     CORE NOTIFICATION METHODS
  ════════════════════════════════════════════ */

  /**
   * Show a success notification.
   * @param {string} msg
   * @emits NOTIFICATION
   */
  function success(msg) {
    _show(msg, 'success');
  }

  /**
   * Show an error notification.
   * @param {string} msg
   * @emits NOTIFICATION
   */
  function error(msg) {
    _show(msg, 'error');
  }

  /**
   * Show a warning notification.
   * @param {string} msg
   * @emits NOTIFICATION
   */
  function warning(msg) {
    _show(msg, 'warning');
  }

  /**
   * Show an info notification.
   * @param {string} msg
   * @emits NOTIFICATION
   */
  function info(msg) {
    _show(msg, 'info');
  }

  /**
   * Show a loading notification (non-blocking).
   * @param {string} msg - Optional loading message
   * @returns {{ dismiss: Function }} Object with dismiss() method
   */
  function loading(msg) {
    var id = 'ntf_loading_' + Date.now();
    _show(msg || 'Loading…', 'info');
    return {
      dismiss: function () {
        // No actual dismiss logic needed — toasts auto-dismiss
        // This exists for API compatibility
      }
    };
  }

  /* ════════════════════════════════════════════
     INTERNAL
  ════════════════════════════════════════════ */

  function _show(msg, type) {
    // Delegate to existing toast() for backward compatibility
    try {
      if (typeof toast === 'function') {
        toast(msg, type);
      } else if (typeof showToast === 'function') {
        showToast(msg, type);
      } else {
        console.log('[NotificationService] ' + type.toUpperCase() + ': ' + msg);
      }
    } catch (_e) { /* ignore */ }

    // Track history
    _history.unshift({ type: type, message: msg, timestamp: Date.now() });
    if (_history.length > MAX_HISTORY) _history.length = MAX_HISTORY;

    _count += 1;

    // Emit event for future decoupled consumers
    try {
      if (typeof EventBus !== 'undefined' && EventBus.emit) {
        EventBus.emit('NOTIFICATION', { type: type, message: msg, timestamp: Date.now() });
      }
    } catch (_e) { /* isolation */ }
  }

  /* ════════════════════════════════════════════
     HISTORY
  ════════════════════════════════════════════ */

  /**
   * Get recent notification history.
   * @param {number} [limit=50]
   * @returns {{ type: string, message: string, timestamp: number }[]}
   */
  function getHistory(limit) {
    var n = limit || 50;
    return _history.slice(0, n);
  }

  /**
   * Get total notification count (session).
   * @returns {number}
   */
  function getCount() {
    return _count;
  }

  /**
   * Clear notification history.
   */
  function clearHistory() {
    _history = [];
    _count = 0;
  }

  /** @public */
  window.NotificationService = {
    VERSION: '1.0.0',
    success: success,
    error: error,
    warning: warning,
    info: info,
    loading: loading,
    getHistory: getHistory,
    getCount: getCount,
    clearHistory: clearHistory
  };

  // ── Backward compatibility: bridge existing toast to NotificationService ──
  // Does NOT replace toast() — it remains fully functional.
  // Only adds bridging so future EventBus listeners receive notifications.
})();
