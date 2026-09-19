/**
 * Elligentt ToastManager — Centralized Toast System (Phase 1 Architecture)
 *
 * Wraps existing toast() function. Does NOT change appearance.
 * Provides structured API for future consumers.
 *
 * Delegates to existing toast() for rendering. No UI modifications.
 *
 * Attached to: window.ToastManager
 *
 * @module toastManager
 * @version 1.0.0
 */
(function () {
  'use strict';

  /* ════════════════════════════════════════════
     CORE — delegates to existing toast()
  ════════════════════════════════════════════ */

  /**
   * Show a toast notification.
   * @param {string} msg - Message text
   * @param {string} [type='info'] - 'success' | 'error' | 'warning' | 'info'
   */
  function show(msg, type) {
    try {
      if (typeof toast === 'function') {
        toast(msg, type || 'info');
      } else if (typeof showToast === 'function') {
        showToast(msg, type || 'info');
      } else {
        console.log('[ToastManager] ' + (type || 'info').toUpperCase() + ': ' + msg);
      }
    } catch (_e) { /* ignore */ }
  }

  /**
   * Show a success toast.
   * @param {string} msg
   */
  function success(msg) { show(msg, 'success'); }

  /**
   * Show an error toast.
   * @param {string} msg
   */
  function error(msg) { show(msg, 'error'); }

  /**
   * Show a warning toast.
   * @param {string} msg
   */
  function warning(msg) { show(msg, 'warning'); }

  /**
   * Show an info toast.
   * @param {string} msg
   */
  function info(msg) { show(msg, 'info'); }

  /** @public */
  window.ToastManager = {
    VERSION: '1.0.0',
    show: show,
    success: success,
    error: error,
    warning: warning,
    info: info
  };
})();
