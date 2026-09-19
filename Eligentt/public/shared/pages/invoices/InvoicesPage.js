/**
 * InvoicesPage — Extracted Invoices Feature Module (Phase 14.1)
 * Migrates: renderInvoices, invoice stats, preview.
 * Attached to: window.InvoicesPage
 */
(function () {
  'use strict';
  var _init = false, _subs = [];

  function initialize() {
    if (_init) return; _init = true;
    try {
      if (typeof EventBus !== 'undefined') {
        _subs.push(EventBus.on('PAGE_CHANGED', function (p) { if (p && p.page === 'invoices') render(); }));
      }
      if (typeof TabManager !== 'undefined') TabManager.register('invoices', { init: render });
    } catch (_e) {}
  }

  function render() {
    try { if (typeof CoreMigrate !== 'undefined') CoreMigrate.docs_renderInvoices(); else if (typeof renderInvoices === 'function') renderInvoices(); } catch (_e) {}
    try { if (typeof CoreMigrate !== 'undefined') CoreMigrate.docs_updateInvStats(); else if (typeof updateInvStats === 'function') updateInvStats(); } catch (_e2) {}
  }

  function refresh() { render(); }

  function destroy() { _subs.forEach(function (s) { try { s.off(); } catch (_e) {} }); _subs = []; _init = false; }

  window.InvoicesPage = { VERSION: '14.0.0', initialize: initialize, render: render, refresh: refresh, destroy: destroy };
})();
