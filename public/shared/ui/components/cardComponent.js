/**
 * Elligentt Card Component — Reusable Card Factory (Phase 2)
 * Reuses existing .card .ch .ct .cb HTML classes. No redesign.
 * Attached to: window.CardComponent
 */
(function () {
  'use strict';

  /**
   * Create a card element with header and body.
   * @param {Object} opts
   * @param {string} [opts.title] - Card title
   * @param {string} [opts.icon] - Tabler icon name
   * @param {string} [opts.badge] - Badge text in header
   * @param {string} [opts.badgeCls] - Badge CSS class
   * @param {string|Element} [opts.body] - Body content (HTML string or Element)
   * @param {string|Element} [opts.actions] - Header action buttons
   * @param {string} [opts.cls] - Additional CSS class
   * @param {Object} [opts.style] - Inline styles
   * @returns {HTMLDivElement}
   */
  function create(opts) {
    var o = opts || {};
    var card = document.createElement('div');
    card.className = 'card' + (o.cls ? ' ' + o.cls : '');
    if (o.style) {
      var sk = Object.keys(o.style);
      for (var i = 0; i < sk.length; i++) card.style[sk[i]] = o.style[sk[i]];
    }

    // Header
    if (o.title) {
      var header = document.createElement('div');
      header.className = 'ch';

      var titleWrap = document.createElement('span');
      titleWrap.className = 'ct';

      if (o.icon) {
        var icon = document.createElement('i');
        icon.className = 'ti ti-' + o.icon;
        icon.style.cssText = 'margin-right:5px';
        titleWrap.appendChild(icon);
      }
      titleWrap.appendChild(document.createTextNode(o.title));
      header.appendChild(titleWrap);

      if (o.badge) {
        var badge = document.createElement('span');
        badge.className = 'chip ' + (o.badgeCls || '');
        badge.style.marginLeft = 'auto';
        badge.textContent = o.badge;
        header.appendChild(badge);
      }

      if (o.actions) {
        if (typeof o.actions === 'string') {
          var actWrap = document.createElement('span');
          actWrap.style.marginLeft = 'auto';
          actWrap.innerHTML = o.actions;
          header.appendChild(actWrap);
        } else {
          header.appendChild(o.actions);
        }
      }

      card.appendChild(header);
    }

    // Body
    if (o.body) {
      var body = document.createElement('div');
      body.className = 'cb';
      if (typeof o.body === 'string') {
        body.innerHTML = o.body;
      } else {
        body.appendChild(o.body);
      }
      card.appendChild(body);
    }

    return card;
  }

  /**
   * Create a stat card (small numeric card).
   * @param {string} title
   * @param {string} value
   * @param {string} [icon]
   * @param {string} [color]
   * @returns {HTMLDivElement}
   */
  function stat(title, value, icon, color) {
    return create({
      title: title,
      icon: icon || 'chart-bar',
      body: '<div style="font-size:22px;font-weight:700;color:' + (color || 'var(--text)') + '">' + value + '</div>'
    });
  }

  /** @public */
  window.CardComponent = {
    VERSION: '1.0.0',
    create: create,
    stat: stat
  };
})();
