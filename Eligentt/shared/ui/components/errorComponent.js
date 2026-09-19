/**
 * Elligentt Error Component (Phase 2)
 * Attached to: window.ErrorComponent
 */
(function () {
  'use strict';

  /**
   * Show error state with optional retry.
   * @param {Object} opts
   * @param {Element|string} opts.container
   * @param {string} [opts.message] - "Something went wrong"
   * @param {string} [opts.detail] - Technical details
   * @param {Function} [opts.onRetry]
   */
  function show(opts) {
    var o = opts || {};
    var container = typeof o.container === 'string'
      ? document.getElementById(o.container) : o.container;
    if (!container) return;

    container.innerHTML =
      '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:28px 16px;text-align:center">' +
      '<div style="width:40px;height:40px;border-radius:50%;background:rgba(239,68,68,.1);display:flex;align-items:center;justify-content:center;margin-bottom:10px">' +
      '<i class="ti ti-exclamation-circle" style="font-size:20px;color:var(--red)"></i></div>' +
      '<div style="font-size:11px;color:var(--text);margin-bottom:2px">' + (o.message || 'Something went wrong') + '</div>' +
      (o.detail ? '<div style="font-size:8.5px;color:var(--muted2);margin-bottom:8px;font-family:monospace">' + o.detail + '</div>' : '') +
      (typeof o.onRetry === 'function'
        ? '<button class="btn" style="font-size:9px;margin-top:6px" onclick="(' + o.onRetry.toString() + ')()"><i class="ti ti-refresh"></i> Retry</button>'
        : '') +
      '</div>';
  }

  /** @public */
  window.ErrorComponent = {
    VERSION: '1.0.0',
    show: show
  };
})();
