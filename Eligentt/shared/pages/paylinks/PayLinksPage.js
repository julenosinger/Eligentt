/**
 * PayLinksPage — Payment Links Feature Module (Phase 15)
 * Migrates: create link, QR generation, status, history.
 * Attached to: window.PayLinksPage
 */
(function () {
  'use strict';
  var _init = false, _subs = [];

  function initialize() {
    if (_init) return; _init = true;
    try {
      if (typeof EventBus !== 'undefined') {
        _subs.push(EventBus.on('PAGE_CHANGED', function (p) { if (p && p.page === 'links') render(); }));
        _subs.push(EventBus.on('PAYLINK_CREATE', function (p) { if (p) create(p); }));
      }
      if (typeof TabManager !== 'undefined') TabManager.register('links', { init: render });
    } catch (_e) {}
  }

  function render() {
    try { if (typeof CoreMigrate !== 'undefined') CoreMigrate.docs_renderPayLinks(); else if (typeof renderPayLinks === 'function') renderPayLinks(); } catch (_e) {}
  }

  function create(opts) {
    try { if (typeof plCreateLink === 'function') return plCreateLink(opts); } catch (_e) {}
    return null;
  }

  function refresh() { render(); }

  function destroy() { _subs.forEach(function (s) { try { s.off(); } catch (_e) {} }); _subs = []; _init = false; }

  window.PayLinksPage = { VERSION: '15.0.0', initialize: initialize, render: render, create: create, refresh: refresh, destroy: destroy };
})();
