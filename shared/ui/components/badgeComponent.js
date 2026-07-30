/**
 * Elligentt Badge Component — Reusable Badge Factory (Phase 2)
 * Reuses existing .chip, .chip-g, .chip-b, etc. CSS classes.
 * Attached to: window.BadgeComponent
 */
(function () {
  'use strict';

  /** @type {Object} Preset styles */
  var PRESETS = {
    success:  { cls: 'chip chip-g', text: 'Active' },
    pending:  { cls: 'chip', text: 'Pending' },
    error:    { cls: 'chip', text: 'Error', style: 'color:var(--red)' },
    warning:  { cls: 'chip', text: 'Warning', style: 'color:var(--yellow)' },
    info:     { cls: 'chip chip-b', text: 'Info' },
    live:     { cls: 'chip chip-g', text: 'Live' },
    beta:     { cls: 'chip chip-b', text: 'BETA' },
    new:      { cls: 'chip chip-p', text: 'NEW' },
    readonly: { cls: 'chip', text: 'read-only', style: 'color:var(--muted2)' }
  };

  /**
   * Create a badge/chip element.
   * @param {Object|string} opts - Options or preset name
   * @param {string} [opts.text] - Badge text
   * @param {string} [opts.cls] - CSS class
   * @param {string} [opts.color] - Text color
   * @param {string} [opts.preset] - Preset name ('success', 'error', etc.)
   * @returns {HTMLSpanElement}
   */
  function create(opts) {
    if (typeof opts === 'string') {
      var preset = PRESETS[opts] || PRESETS.info;
      opts = { text: preset.text, cls: preset.cls, style: preset.style };
    }
    var o = opts || {};
    var span = document.createElement('span');
    span.className = o.cls || 'chip';
    if (o.text) span.textContent = o.text;
    if (o.style) span.style.cssText = o.style;
    if (o.color) span.style.color = o.color;
    return span;
  }

  /** @public */
  window.BadgeComponent = {
    VERSION: '1.0.0',
    create: create,
    PRESETS: PRESETS
  };
})();
