/**
 * Elligentt DOM Helpers — Safe DOM Manipulation Utilities (Phase 2 Architecture)
 *
 * All DOM manipulation routed through these helpers.
 * Null-safe. Chainable where possible. Never throws on missing elements.
 *
 * Attached to: window.DOM
 *
 * @module domHelpers
 * @version 1.0.0
 */
(function () {
  'use strict';

  /**
   * Get element by ID. Returns null if not found (never throws).
   * @param {string} id
   * @returns {Element|null}
   */
  function get(id) {
    try { return document.getElementById(id); } catch (_e) { return null; }
  }

  /**
   * Query all matching elements. Always returns array (never null).
   * @param {string} selector
   * @param {Element|Document} [scope=document]
   * @returns {Element[]}
   */
  function getAll(selector, scope) {
    try {
      var result = (scope || document).querySelectorAll(selector);
      return Array.prototype.slice.call(result);
    } catch (_e) { return []; }
  }

  /**
   * Query first matching element. Returns null if not found.
   * @param {string} selector
   * @param {Element|Document} [scope=document]
   * @returns {Element|null}
   */
  function getFirst(selector, scope) {
    try { return (scope || document).querySelector(selector); } catch (_e) { return null; }
  }

  /**
   * Create element with optional attributes and children.
   * @param {string} tag
   * @param {Object} [attrs]
   * @param {string|Node|Node[]} [children]
   * @returns {Element}
   */
  function create(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      var keys = Object.keys(attrs);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (k === 'className') { el.className = attrs[k]; }
        else if (k === 'style' && typeof attrs[k] === 'object') {
          var sk = Object.keys(attrs[k]);
          for (var j = 0; j < sk.length; j++) { el.style[sk[j]] = attrs[k][sk[j]]; }
        }
        else if (k === 'textContent') { el.textContent = attrs[k]; }
        else if (k === 'innerHTML') { el.innerHTML = attrs[k]; }
        else { el.setAttribute(k, attrs[k]); }
      }
    }
    if (children !== undefined) {
      if (typeof children === 'string') { el.innerHTML = children; }
      else if (Array.isArray(children)) { children.forEach(function (c) { el.appendChild(c); }); }
      else { el.appendChild(children); }
    }
    return el;
  }

  /**
   * Remove element from DOM.
   * @param {string|Element} el - Element or ID
   */
  function remove(el) {
    try {
      var node = typeof el === 'string' ? get(el) : el;
      if (node && node.parentNode) node.parentNode.removeChild(node);
    } catch (_e) {}
  }

  /**
   * Replace oldEl with newEl.
   * @param {Element} oldEl
   * @param {Element} newEl
   */
  function replace(oldEl, newEl) {
    try {
      if (oldEl && oldEl.parentNode) oldEl.parentNode.replaceChild(newEl, oldEl);
    } catch (_e) {}
  }

  /**
   * Show element(s).
   * @param {string|Element} el
   * @param {string} [display=''] - CSS display value
   */
  function show(el, display) {
    try {
      var node = typeof el === 'string' ? get(el) : el;
      if (node) node.style.display = display || '';
    } catch (_e) {}
  }

  /**
   * Hide element(s).
   * @param {string|Element} el
   */
  function hide(el) {
    try {
      var node = typeof el === 'string' ? get(el) : el;
      if (node) node.style.display = 'none';
    } catch (_e) {}
  }

  /**
   * Toggle visibility.
   * @param {string|Element} el
   * @param {string} [display='']
   * @returns {boolean} New visibility state
   */
  function toggle(el, display) {
    try {
      var node = typeof el === 'string' ? get(el) : el;
      if (!node) return false;
      var isHidden = node.style.display === 'none';
      node.style.display = isHidden ? (display || '') : 'none';
      return isHidden;
    } catch (_e) { return false; }
  }

  /**
   * Set innerHTML safely.
   * @param {string|Element} el
   * @param {string} html
   */
  function setHTML(el, html) {
    try {
      var node = typeof el === 'string' ? get(el) : el;
      if (node) node.innerHTML = html;
    } catch (_e) {}
  }

  /**
   * Set textContent safely.
   * @param {string|Element} el
   * @param {string} text
   */
  function setText(el, text) {
    try {
      var node = typeof el === 'string' ? get(el) : el;
      if (node) node.textContent = String(text ?? '');
    } catch (_e) {}
  }

  /**
   * Set input/select value safely.
   * @param {string|Element} el
   * @param {string} value
   */
  function setValue(el, value) {
    try {
      var node = typeof el === 'string' ? get(el) : el;
      if (node) node.value = String(value ?? '');
    } catch (_e) {}
  }

  /**
   * Get input/select value.
   * @param {string|Element} el
   * @returns {string}
   */
  function getValue(el) {
    try {
      var node = typeof el === 'string' ? get(el) : el;
      return node ? node.value || '' : '';
    } catch (_e) { return ''; }
  }

  /**
   * Add CSS class.
   * @param {string|Element} el
   * @param {string} className
   */
  function addClass(el, className) {
    try {
      var node = typeof el === 'string' ? get(el) : el;
      if (node) node.classList.add(className);
    } catch (_e) {}
  }

  /**
   * Remove CSS class.
   * @param {string|Element} el
   * @param {string} className
   */
  function removeClass(el, className) {
    try {
      var node = typeof el === 'string' ? get(el) : el;
      if (node) node.classList.remove(className);
    } catch (_e) {}
  }

  /**
   * Toggle CSS class.
   * @param {string|Element} el
   * @param {string} className
   * @returns {boolean}
   */
  function toggleClass(el, className) {
    try {
      var node = typeof el === 'string' ? get(el) : el;
      if (node) return node.classList.toggle(className);
    } catch (_e) {}
    return false;
  }

  /**
   * Check if element has class.
   * @param {string|Element} el
   * @param {string} className
   * @returns {boolean}
   */
  function hasClass(el, className) {
    try {
      var node = typeof el === 'string' ? get(el) : el;
      return node ? node.classList.contains(className) : false;
    } catch (_e) { return false; }
  }

  /**
   * Set attribute.
   * @param {string|Element} el
   * @param {string} name
   * @param {string} value
   */
  function setAttr(el, name, value) {
    try {
      var node = typeof el === 'string' ? get(el) : el;
      if (node) node.setAttribute(name, String(value));
    } catch (_e) {}
  }

  /**
   * Remove attribute.
   * @param {string|Element} el
   * @param {string} name
   */
  function removeAttr(el, name) {
    try {
      var node = typeof el === 'string' ? get(el) : el;
      if (node) node.removeAttribute(name);
    } catch (_e) {}
  }

  /**
   * Append child.
   * @param {string|Element} parent
   * @param {Element|Element[]} child
   */
  function append(parent, child) {
    try {
      var p = typeof parent === 'string' ? get(parent) : parent;
      if (!p) return;
      if (Array.isArray(child)) { child.forEach(function (c) { p.appendChild(c); }); }
      else { p.appendChild(child); }
    } catch (_e) {}
  }

  /**
   * Empty all children.
   * @param {string|Element} el
   */
  function empty(el) {
    try {
      var node = typeof el === 'string' ? get(el) : el;
      if (node) { while (node.firstChild) { node.removeChild(node.firstChild); } }
    } catch (_e) {}
  }

  /**
   * Check if element exists in DOM.
   * @param {string|Element} el
   * @returns {boolean}
   */
  function exists(el) {
    try {
      var node = typeof el === 'string' ? get(el) : el;
      return !!node;
    } catch (_e) { return false; }
  }

  /**
   * Add event listener with cleanup tracking.
   * @param {string|Element} el
   * @param {string} event
   * @param {Function} fn
   * @param {Object} [opts]
   * @returns {Function} Call to remove listener
   */
  function on(el, event, fn, opts) {
    try {
      var node = typeof el === 'string' ? get(el) : el;
      if (!node) return function () {};
      node.addEventListener(event, fn, opts);
      return function () { node.removeEventListener(event, fn, opts); };
    } catch (_e) { return function () {}; }
  }

  /**
   * Trigger a custom event on an element.
   * @param {string|Element} el
   * @param {string} eventName
   * @param {*} [detail]
   */
  function emit(el, eventName, detail) {
    try {
      var node = typeof el === 'string' ? get(el) : el;
      if (node) node.dispatchEvent(new CustomEvent(eventName, { detail: detail, bubbles: true }));
    } catch (_e) {}
  }

  /**
   * Get computed style.
   * @param {string|Element} el
   * @param {string} prop
   * @returns {string}
   */
  function getStyle(el, prop) {
    try {
      var node = typeof el === 'string' ? get(el) : el;
      return node ? window.getComputedStyle(node).getPropertyValue(prop) : '';
    } catch (_e) { return ''; }
  }

  /**
   * Set inline style.
   * @param {string|Element} el
   * @param {string|Object} prop - CSS property name or {prop: value} object
   * @param {string} [value]
   */
  function setStyle(el, prop, value) {
    try {
      var node = typeof el === 'string' ? get(el) : el;
      if (!node) return;
      if (typeof prop === 'object') {
        var keys = Object.keys(prop);
        for (var i = 0; i < keys.length; i++) { node.style[keys[i]] = prop[keys[i]]; }
      } else {
        node.style[prop] = value;
      }
    } catch (_e) {}
  }

  /**
   * Get element's nearest ancestor matching selector.
   * @param {string|Element} el
   * @param {string} selector
   * @returns {Element|null}
   */
  function closest(el, selector) {
    try {
      var node = typeof el === 'string' ? get(el) : el;
      return node ? node.closest(selector) : null;
    } catch (_e) { return null; }
  }

  /** @public */
  window.DOM = {
    VERSION: '1.0.0',
    get: get,
    getAll: getAll,
    getFirst: getFirst,
    create: create,
    remove: remove,
    replace: replace,
    show: show,
    hide: hide,
    toggle: toggle,
    setHTML: setHTML,
    setText: setText,
    setValue: setValue,
    getValue: getValue,
    addClass: addClass,
    removeClass: removeClass,
    toggleClass: toggleClass,
    hasClass: hasClass,
    setAttr: setAttr,
    removeAttr: removeAttr,
    append: append,
    empty: empty,
    exists: exists,
    on: on,
    emit: emit,
    getStyle: getStyle,
    setStyle: setStyle,
    closest: closest
  };
})();
