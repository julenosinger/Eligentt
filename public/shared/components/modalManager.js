/**
 * Elligentt ModalManager — Centralized Modal System (Phase 1 Architecture)
 *
 * Manages modal lifecycle (open/close/confirm/alert/loading).
 * Compatible with existing HTML modal structure. No UI redesign.
 * Delegates to existing openModal()/closeModal() for backward compatibility.
 *
 * Supports single-modal-at-a-time pattern with stacking through UIStore.
 *
 * Attached to: window.ModalManager
 *
 * @module modalManager
 * @version 1.0.0
 */
(function () {
  'use strict';

  var MODAL_SELECTOR = '#modal';
  var MODAL_OPEN_CLASS = 'open';

  /** @type {{ id: string, type: string, title: string, body: string, resolve: Function|null, reject: Function|null }[]} */
  var _stack = [];

  /* ════════════════════════════════════════════
     CORE METHODS
  ════════════════════════════════════════════ */

  /**
   * Open the existing HTML modal. Delegates to openModal() when available.
   * Compatible with the batch-payment modal flow.
   *
   * @emits MODAL_OPENED
   */
  function open() {
    try {
      if (typeof openModal === 'function') {
        openModal();
      } else {
        var el = document.querySelector(MODAL_SELECTOR);
        if (el) el.classList.add(MODAL_OPEN_CLASS);
      }
    } catch (_e) { /* ignore */ }

    try {
      if (typeof UIStore !== 'undefined' && UIStore.pushModal) {
        UIStore.pushModal('batch-send');
      }
    } catch (_e2) {}
  }

  /**
   * Close the existing HTML modal. Delegates to closeModal() when available.
   *
   * @emits MODAL_CLOSED
   */
  function close() {
    try {
      if (typeof closeModal === 'function') {
        closeModal();
      } else {
        var el = document.querySelector(MODAL_SELECTOR);
        if (el) el.classList.remove(MODAL_OPEN_CLASS);
      }
    } catch (_e) { /* ignore */ }

    try {
      if (typeof UIStore !== 'undefined' && UIStore.popModal) {
        UIStore.popModal();
      }
    } catch (_e2) {}
  }

  /**
   * Check if modal is currently open.
   * @returns {boolean}
   */
  function isOpen() {
    try {
      var el = document.querySelector(MODAL_SELECTOR);
      return el ? el.classList.contains(MODAL_OPEN_CLASS) : false;
    } catch (_e) { return false; }
  }

  /* ════════════════════════════════════════════
     CONFIRM DIALOG
  ════════════════════════════════════════════ */

  /**
   * Show a confirmation dialog using DOM API (does not depend on modal HTML).
   * Falls back to native confirm() if DOM unavailable.
   *
   * @param {string} message - Confirmation message
   * @param {Object} [opts]
   * @param {string} [opts.title] - Dialog title
   * @param {string} [opts.confirmText] - Confirm button text (default: "Confirm")
   * @param {string} [opts.cancelText] - Cancel button text (default: "Cancel")
   * @param {string} [opts.confirmClass] - CSS class for confirm button
   * @returns {Promise<boolean>} Resolves true on confirm, false on cancel
   */
  function confirm(message, opts) {
    var o = opts || {};
    var title = o.title || 'Confirm';
    var confirmText = o.confirmText || 'Confirm';
    var cancelText = o.cancelText || 'Cancel';

    return new Promise(function (resolve) {
      // Try native confirm as fallback
      if (typeof document === 'undefined') {
        resolve(window.confirm(message));
        return;
      }

      // Build overlay
      var overlay = document.createElement('div');
      overlay.className = 'wm-overlay open';
      overlay.style.zIndex = '2100';

      var box = document.createElement('div');
      box.className = 'wm-box';
      box.style.maxWidth = '400px';

      box.innerHTML =
        '<div class="wm-head">' +
          '<div><div class="wm-title">' + _esc(title) + '</div></div>' +
          '<button class="wm-close" id="_cmf_close">&times;</button>' +
        '</div>' +
        '<div class="wm-body" style="font-size:11px;color:#c2c9d9;padding:16px">' + _esc(message) + '</div>' +
        '<div style="padding:12px 16px;border-top:1px solid #252b3b;display:flex;gap:8px;justify-content:flex-end">' +
          '<button class="btn" id="_cmf_cancel" style="font-size:9px">' + _esc(cancelText) + '</button>' +
          '<button class="btn primary" id="_cmf_confirm" style="font-size:9px">' + _esc(confirmText) + '</button>' +
        '</div>';

      overlay.appendChild(box);
      document.body.appendChild(overlay);

      function cleanup() {
        try { document.body.removeChild(overlay); } catch (_e) {}
      }

      var confirmed = false;
      overlay.querySelector('#_cmf_confirm').onclick = function () { confirmed = true; cleanup(); resolve(true); };
      overlay.querySelector('#_cmf_cancel').onclick = function () { cleanup(); resolve(false); };
      overlay.querySelector('#_cmf_close').onclick = function () { cleanup(); resolve(false); };
      overlay.onclick = function (e) { if (e.target === overlay) { cleanup(); resolve(false); } };
    });
  }

  /**
   * Show an alert dialog.
   * @param {string} message
   * @param {Object} [opts]
   * @param {string} [opts.title]
   * @returns {Promise<void>}
   */
  function alert(message, opts) {
    var o = opts || {};
    var title = o.title || 'Alert';

    return new Promise(function (resolve) {
      if (typeof document === 'undefined') {
        window.alert(message);
        resolve();
        return;
      }

      var overlay = document.createElement('div');
      overlay.className = 'wm-overlay open';
      overlay.style.zIndex = '2100';

      var box = document.createElement('div');
      box.className = 'wm-box';
      box.style.maxWidth = '400px';

      box.innerHTML =
        '<div class="wm-head">' +
          '<div><div class="wm-title">' + _esc(title) + '</div></div>' +
          '<button class="wm-close" id="_alt_close">&times;</button>' +
        '</div>' +
        '<div class="wm-body" style="font-size:11px;color:#c2c9d9;padding:16px">' + _esc(message) + '</div>' +
        '<div style="padding:12px 16px;border-top:1px solid #252b3b;display:flex;gap:8px;justify-content:flex-end">' +
          '<button class="btn primary" id="_alt_ok" style="font-size:9px">OK</button>' +
        '</div>';

      overlay.appendChild(box);
      document.body.appendChild(overlay);

      function cleanup() {
        try { document.body.removeChild(overlay); } catch (_e) {}
      }

      overlay.querySelector('#_alt_ok').onclick = function () { cleanup(); resolve(); };
      overlay.querySelector('#_alt_close').onclick = function () { cleanup(); resolve(); };
      overlay.onclick = function (e) { if (e.target === overlay) { cleanup(); resolve(); } };
    });
  }

  /**
   * Show a loading dialog.
   * @param {string} [message='Loading…']
   * @returns {{ dismiss: Function }}
   */
  function loading(message) {
    var msg = message || 'Loading…';

    var overlay = document.createElement('div');
    overlay.className = 'wm-overlay open';
    overlay.style.zIndex = '2100';

    var box = document.createElement('div');
    box.className = 'wm-box';
    box.style.maxWidth = '320px';

    box.innerHTML =
      '<div class="wm-body" style="text-align:center;padding:28px">' +
        '<i class="ti ti-loader-2" style="font-size:24px;color:var(--purple);animation:spin 1s linear infinite;display:block;margin-bottom:10px"></i>' +
        '<div style="font-size:11px;color:var(--muted2)">' + _esc(msg) + '</div>' +
      '</div>';

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    return {
      dismiss: function () {
        try { document.body.removeChild(overlay); } catch (_e) {}
      }
    };
  }

  /* ════════════════════════════════════════════
     HELPERS
  ════════════════════════════════════════════ */

  function _esc(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** @public */
  window.ModalManager = {
    VERSION: '1.0.0',
    open: open,
    close: close,
    isOpen: isOpen,
    confirm: confirm,
    alert: alert,
    loading: loading
  };
})();
