/**
 * Elligentt PaymentStore — Payment State Management (Phase 14.5)
 * Migrates: recipients, batchContract, batchCount, successCount globals.
 * Attached to: window.PaymentStore
 */
(function () {
  'use strict';
  var _state = { recipients: [], batchContract: '', batchCount: 0, successCount: 0, total: 0 };

  function get(key) { return _state[key]; }
  function set(key, val) { _state[key] = val; try { if (typeof EventBus !== 'undefined') EventBus.emit('PAYMENT_STATE_CHANGED', { key: key }); } catch (_e) {} }
  function getSnapshot() { return Object.assign({}, _state); }
  function addRecipient(r) { _state.recipients.push(r); try { if (typeof EventBus !== 'undefined') EventBus.emit('RECIPIENT_ADDED', { recipient: r }); } catch (_e) {} }
  function clearRecipients() { _state.recipients = []; }
  function reset() { _state = { recipients: [], batchContract: '', batchCount: 0, successCount: 0, total: 0 }; }

  window.PaymentStore = { VERSION: '14.0.0', get: get, set: set, getSnapshot: getSnapshot, addRecipient: addRecipient, clearRecipients: clearRecipients, reset: reset };
})();
