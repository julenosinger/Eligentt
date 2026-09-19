/**
 * PaymentsPage — Extracted Payments Feature Module (Phase 14.3)
 * Migrates: signTx, batch payment handlers, recipient management.
 * Attached to: window.PaymentsPage
 */
(function () {
  'use strict';
  var _init = false, _subs = [];

  function initialize() {
    if (_init) return; _init = true;
    try {
      if (typeof EventBus !== 'undefined') {
        _subs.push(EventBus.on('PAGE_CHANGED', function (p) { if (p && (p.page === 'batch' || p.page === 'send')) render(); }));
      }
      if (typeof TabManager !== 'undefined') { TabManager.register('batch', { init: render }); TabManager.register('send', { init: render }); }
    } catch (_e) {}
  }

  function render() {
    try { if (typeof renderTable === 'function') renderTable(); } catch (_e) {}
    try { if (typeof updateStats === 'function') updateStats(); } catch (_e2) {}
  }

  function execute() {
    try { if (typeof CoreMigrate !== 'undefined') return CoreMigrate.payments_execute(); } catch (_e) {}
    try { if (typeof PaymentDomain !== 'undefined') return PaymentDomain.executeBatch(); } catch (_e2) {}
    try { if (typeof signTx === 'function') { signTx(); return true; } } catch (_e3) {}
    return false;
  }

  function addRecipient(addr, amount, name) {
    try { if (typeof CoreMigrate !== 'undefined') return CoreMigrate.payments_addRecipient(addr, amount, name); } catch (_e) {}
    return false;
  }

  function validate(recipient) {
    try { if (typeof CoreMigrate !== 'undefined') return CoreMigrate.payments_validate(recipient); } catch (_e) {}
    return { valid: false, reason: 'Validator unavailable' };
  }

  function destroy() { _subs.forEach(function (s) { try { s.off(); } catch (_e) {} }); _subs = []; _init = false; }

  window.PaymentsPage = { VERSION: '14.0.0', initialize: initialize, render: render, execute: execute, addRecipient: addRecipient, validate: validate, destroy: destroy };
})();
