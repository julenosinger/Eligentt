/**
 * Elligentt Button Component — Reusable Button Factory (Phase 2)
 * Reuses existing HTML classes. No redesign.
 * Attached to: window.ButtonComponent
 */
(function () {
  'use strict';

  /**
   * Create a button element.
   * @param {Object} opts
   * @param {string} [opts.label] - Button text
   * @param {string} [opts.icon] - Tabler icon name (e.g. 'send', 'plus')
   * @param {string} [opts.cls] - Additional CSS class ('primary', 'danger', etc.)
   * @param {string} [opts.size] - 'sm' | 'md' | 'lg' (default 'md')
   * @param {boolean} [opts.disabled]
   * @param {Function} [opts.onClick]
   * @param {string} [opts.title]
   * @param {string} [opts.id]
   * @param {string} [opts.type] - Button type (default 'button')
   * @returns {HTMLButtonElement}
   */
  function create(opts) {
    var o = opts || {};
    var btn = document.createElement('button');
    btn.className = 'btn' + (o.cls ? ' ' + o.cls : '');
    btn.type = o.type || 'button';

    if (o.id) btn.id = o.id;
    if (o.title) btn.title = o.title;
    if (o.disabled) btn.disabled = true;

    var html = '';
    if (o.icon) html += '<i class="ti ti-' + o.icon + '"></i>';
    if (o.label) html += (o.icon ? ' ' : '') + o.label;
    btn.innerHTML = html;

    if (o.size === 'sm') { btn.style.fontSize = '8.5px'; btn.style.padding = '2px 7px'; }
    else if (o.size === 'lg') { btn.style.fontSize = '11px'; btn.style.padding = '7px 16px'; }
    else { btn.style.fontSize = '9px'; }

    if (typeof o.onClick === 'function') {
      btn.addEventListener('click', function (e) {
        o.onClick(e, btn);
      });
    }
    return btn;
  }

  /**
   * Create a link-style button (<a> tag styled as button).
   */
  function link(opts) {
    var o = opts || {};
    var a = document.createElement('a');
    a.className = 'btn' + (o.cls ? ' ' + o.cls : '');
    a.style.fontSize = '9px';
    if (o.href) a.href = o.href;
    if (o.target) a.target = o.target;

    var html = '';
    if (o.icon) html += '<i class="ti ti-' + o.icon + '"></i>';
    if (o.label) html += (o.icon ? ' ' : '') + o.label;
    a.innerHTML = html;
    return a;
  }

  /** @public */
  window.ButtonComponent = {
    VERSION: '1.0.0',
    create: create,
    link: link
  };
})();
