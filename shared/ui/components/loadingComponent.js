/**
 * Elligentt Loading Component — Spinner & Skeleton (Phase 2)
 * Attached to: window.LoadingComponent
 */
(function () {
  'use strict';

  /**
   * Show a loading spinner inside a container.
   * @param {Object} opts
   * @param {Element|string} opts.container
   * @param {string} [opts.message] - "Loading..."
   * @param {string} [opts.size] - 'sm' | 'md' | 'lg'
   * @returns {Function} Cancel function to remove spinner
   */
  function show(opts) {
    var o = opts || {};
    var container = typeof o.container === 'string'
      ? document.getElementById(o.container) : o.container;
    if (!container) return function () {};

    var size = o.size === 'sm' ? '18px' : o.size === 'lg' ? '32px' : '24px';
    var msg = o.message || 'Loading...';

    var wrapper = document.createElement('div');
    wrapper.id = '_loading_' + Date.now();
    wrapper.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;color:var(--muted2)';

    wrapper.innerHTML =
      '<i class="ti ti-loader-2" style="font-size:' + size + ';color:var(--purple);animation:spin 1s linear infinite;margin-bottom:8px"></i>' +
      '<div style="font-size:10px">' + msg + '</div>';

    container.innerHTML = '';
    container.appendChild(wrapper);

    return function () {
      try { container.removeChild(wrapper); } catch (_e) {}
    };
  }

  /**
   * Create a simple inline spinner element.
   * @param {string} [size='16px']
   * @returns {HTMLSpanElement}
   */
  function spinner(size) {
    var s = size || '16px';
    var span = document.createElement('span');
    span.innerHTML = '<i class="ti ti-loader-2" style="font-size:' + s + ';animation:spin 1s linear infinite"></i>';
    return span;
  }

  /** @public */
  window.LoadingComponent = {
    VERSION: '1.0.0',
    show: show,
    spinner: spinner
  };
})();
