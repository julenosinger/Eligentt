/**
 * Elligentt Confirm Dialog Component (Phase 2)
 * Delegates to ModalManager.confirm(). Wraps for compatibility.
 * Attached to: window.ConfirmDialogComponent
 */
(function () {
  'use strict';

  /**
   * Show a confirmation dialog.
   * @param {string} message
   * @param {Object} [opts]
   * @param {string} [opts.title]
   * @param {string} [opts.confirmText]
   * @param {string} [opts.cancelText]
   * @param {string} [opts.danger] - If truthy, confirm button gets danger styling
   * @returns {Promise<boolean>}
   */
  function show(message, opts) {
    try {
      if (typeof ModalManager !== 'undefined' && ModalManager.confirm) {
        return ModalManager.confirm(message, opts);
      }
    } catch (_e) {}
    return Promise.resolve(window.confirm(message));
  }

  /**
   * Show a destructive confirmation (red confirm button).
   * @param {string} message
   * @param {Object} [opts]
   * @returns {Promise<boolean>}
   */
  function danger(message, opts) {
    var o = Object.assign({}, opts || {}, { confirmText: (opts && opts.confirmText) || 'Delete' });
    return show(message, o);
  }

  /** @public */
  window.ConfirmDialogComponent = {
    VERSION: '1.0.0',
    show: show,
    danger: danger
  };
})();
