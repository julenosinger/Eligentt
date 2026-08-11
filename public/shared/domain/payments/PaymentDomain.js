/**
 * PaymentDomain — Payment creation, validation, execution (Phase 3)
 * Wraps existing batch/multisend functions. Never duplicates logic.
 * Attached to: window.PaymentDomain
 */
(function () {
  'use strict';
  var _init = false;

  function initialize() { if (_init) return; _init = true; }

  function validateRecipient(r) {
    if (!r || !r.addr) return { valid: false, reason: 'Missing address' };
    try {
      var valid = (typeof isAddr === 'function' && isAddr(r.addr)) || (typeof isEns === 'function' && isEns(r.addr));
      if (!valid) return { valid: false, reason: 'Invalid address format' };
    } catch (_e) { return { valid: false, reason: 'Address validation error' }; }
    var amount = parseFloat(r.amount);
    if (isNaN(amount) || amount <= 0) return { valid: false, reason: 'Amount must be > 0' };
    return { valid: true };
  }

  function executeBatch() {
    try {
      if (typeof signTx === 'function') { signTx(); return true; }
      if (typeof openModal === 'function') { openModal(); return true; }
    } catch (e) {
      try { if (typeof ErrorHandler !== 'undefined') ErrorHandler.handle(e, { source: 'payment', operation: 'executeBatch' }); } catch (_e) {}
    }
    return false;
  }

  function addRecipient(addr, amount, name, chainId) {
    try {
      if (typeof recipients !== 'undefined') {
        recipients.push({ addr: addr, amount: String(amount || '0.00'), name: name || '', chainId: chainId || 'Arc_Testnet', note: '' });
        if (typeof renderTable === 'function') renderTable();
        return true;
      }
    } catch (_e) {}
    return false;
  }

  function clearRecipients() {
    try { if (typeof recipients !== 'undefined') { recipients.length = 0; if (typeof renderTable === 'function') renderTable(); } } catch (_e) {}
  }

  function getRecipients() {
    try { if (typeof recipients !== 'undefined') return recipients.slice(); } catch (_e) {}
    return [];
  }

  function refresh() {
    try { if (typeof renderTable === 'function') renderTable(); } catch (_e) {}
    try { if (typeof updateStats === 'function') updateStats(); } catch (_e2) {}
  }

  function destroy() { _init = false; }

  window.PaymentDomain = {
    VERSION: '1.0.0',
    initialize: initialize, validateRecipient: validateRecipient, executeBatch: executeBatch,
    addRecipient: addRecipient, clearRecipients: clearRecipients, getRecipients: getRecipients,
    refresh: refresh, destroy: destroy
  };
})();
