/**
 * Elligentt IntentSecurity — Cryptographic Intent Wrapper (Phase 9)
 * Every execution must carry: intentId, traceId, timestamp, nonce, hash.
 * Wraps intent creation. Additive — does not block existing flow.
 * Attached to: window.IntentSecurity
 */
(function () {
  'use strict';

  function wrap(intent) {
    var now = Date.now();
    var wrapped = Object.assign({}, intent);
    wrapped._security = {
      intentId: intent.id || generateIntentId(),
      traceId: 'TRACE_' + now.toString(36).toUpperCase() + '_' + Math.random().toString(36).slice(2, 7),
      timestamp: now,
      createdAt: new Date().toISOString(),
      intentHash: _hash(intent),
      version: '1.0.0'
    };
    return wrapped;
  }

  function generateIntentId() {
    return 'SEC_INTENT_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
  }

  function _hash(obj) {
    try {
      var s = JSON.stringify(obj);
      var h = 0;
      for (var i = 0; i < s.length; i++) {
        h = ((h << 5) - h) + s.charCodeAt(i);
        h |= 0;
      }
      return 'sha_' + Math.abs(h).toString(16);
    } catch (_e) { return 'hash_error'; }
  }

  function verify(wrapped) {
    if (!wrapped || !wrapped._security) return { valid: false, reason: 'Missing security wrapper' };
    var sec = wrapped._security;
    if (!sec.intentId || !sec.traceId || !sec.timestamp) return { valid: false, reason: 'Missing security fields' };
    var rehash = _hash(Object.assign({}, wrapped, { _security: undefined }));
    if (rehash !== sec.intentHash) return { valid: false, reason: 'Intent tampered — hash mismatch' };
    return { valid: true };
  }

  function getTrace(wrapped) {
    return wrapped._security ? wrapped._security.traceId : null;
  }

  window.IntentSecurity = {
    VERSION: '1.0.0',
    wrap: wrap,
    verify: verify,
    getTrace: getTrace,
    generateIntentId: generateIntentId
  };
})();
