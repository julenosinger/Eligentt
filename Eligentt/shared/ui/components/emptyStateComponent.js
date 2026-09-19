/**
 * Elligentt Empty State Component (Phase 2)
 * Attached to: window.EmptyStateComponent
 */
(function () {
  'use strict';

  /**
   * Show empty state with optional action.
   * @param {Object} opts
   * @param {Element|string} opts.container
   * @param {string} [opts.message] - "No items found"
   * @param {string} [opts.icon] - Tabler icon name
   * @param {string} [opts.actionLabel]
   * @param {Function} [opts.onAction]
   */
  function show(opts) {
    var o = opts || {};
    var container = typeof o.container === 'string'
      ? document.getElementById(o.container) : o.container;
    if (!container) return;

    var message = o.message || 'No items found';
    var icon = o.icon || 'inbox';

    container.innerHTML =
      '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 16px;color:var(--muted2);text-align:center">' +
      '<i class="ti ti-' + icon + '" style="font-size:36px;margin-bottom:10px;opacity:.5"></i>' +
      '<div style="font-size:11px;margin-bottom:2px">' + message + '</div>' +
      (o.actionLabel
        ? '<button class="btn primary" style="margin-top:8px;font-size:9px" onclick="(' + o.onAction.toString() + ')()">' + o.actionLabel + '</button>'
        : '') +
      '</div>';
  }

  /** @public */
  window.EmptyStateComponent = {
    VERSION: '1.0.0',
    show: show
  };
})();
