/**
 * Elligentt ErrorHandler — Centralized Error Management (Phase 3)
 * Normalizes, categorizes, logs, and forwards errors.
 * Never exposes raw RPC errors to the UI.
 * Attached to: window.ErrorHandler
 */
(function () {
  'use strict';

  var MAX_LOG = 200;
  var _errors = [];

  /**
   * Handle an error. Normalizes, logs, categorizes, and emits through EventBus.
   * @param {Error|string} err
   * @param {Object} [ctx] - Context: { source, operation, severity }
   * @returns {{ message: string, code: string, category: string, userMessage: string }}
   */
  function handle(err, ctx) {
    var normalized = _normalize(err);

    // Build user-friendly message (never expose raw error)
    var userMessage = _userFriendly(normalized);

    // Log
    var entry = {
      timestamp: Date.now(),
      source: (ctx && ctx.source) || 'unknown',
      operation: (ctx && ctx.operation) || 'unknown',
      category: normalized.category,
      code: normalized.code,
      message: normalized.message,
      userMessage: userMessage,
      severity: (ctx && ctx.severity) || _inferSeverity(normalized)
    };

    _errors.unshift(entry);
    if (_errors.length > MAX_LOG) _errors.length = MAX_LOG;

    // Console
    if (entry.severity === 'critical' || entry.severity === 'high') {
      console.error('[ErrorHandler]', entry.source, entry.operation, normalized.message);
    } else {
      console.warn('[ErrorHandler]', entry.source, entry.operation, normalized.message);
    }

    // EventBus
    try {
      if (typeof EventBus !== 'undefined' && EventBus.emit) {
        EventBus.emit('ERROR_OCCURRED', entry);
      }
    } catch (_e) {}

    // Toast user-facing message if not a silent/expected error
    if (entry.severity !== 'silent' && entry.userMessage) {
      try {
        if (typeof toast === 'function') toast(entry.userMessage, 'error');
      } catch (_e2) {}
    }

    return normalized;
  }

  function _normalize(e) {
    // Use Utils.normalizeError if available
    try {
      if (typeof Utils !== 'undefined' && Utils.normalizeError) return Utils.normalizeError(e);
    } catch (_e) {}
    if (!e) return { message: 'Unknown error', code: 'UNKNOWN', category: 'unknown' };
    if (typeof e === 'string') return { message: e, code: 'UNKNOWN', category: 'unknown' };
    return {
      message: e.shortMessage || e.reason || e.message || String(e),
      code: e.code || 'UNKNOWN',
      category: _categorize(e)
    };
  }

  function _categorize(e) {
    var msg = String(e.message || e.reason || e.shortMessage || '');
    if (/insufficient funds|balance too low|not enough/i.test(msg)) return 'balance';
    if (/user rejected|user denied|cancelled|rejected/i.test(msg)) return 'user_rejected';
    if (/timeout|timed out/i.test(msg)) return 'timeout';
    if (/network|connection|fetch|ENOTFOUND/i.test(msg)) return 'network';
    if (/nonce|already known|replacement/i.test(msg)) return 'nonce';
    if (/revert|execution reverted/i.test(msg)) return 'revert';
    if (/gas|underpriced|intrinsic/i.test(msg)) return 'gas';
    if (/signature|signing|permit/i.test(msg)) return 'signature';
    return 'unknown';
  }

  function _userFriendly(n) {
    var map = {
      balance: 'Insufficient balance for this transaction',
      user_rejected: 'Transaction was cancelled',
      timeout: 'Network request timed out — please try again',
      network: 'Network connection issue — check your internet',
      nonce: 'Transaction nonce error — please try again',
      revert: 'Transaction reverted by the contract',
      gas: 'Gas estimation failed — try increasing gas limit',
      signature: 'Signature request failed',
      unknown: 'Something went wrong. Please try again.'
    };
    return map[n.category] || n.message;
  }

  function _inferSeverity(n) {
    if (n.category === 'user_rejected') return 'silent';
    if (n.category === 'revert') return 'high';
    if (n.category === 'network' || n.category === 'timeout') return 'medium';
    return 'medium';
  }

  function getHistory(limit) {
    return _errors.slice(0, limit || 50);
  }

  function getCount() { return _errors.length; }
  function clear() { _errors = []; }

  window.ErrorHandler = {
    VERSION: '1.0.0',
    handle: handle,
    getHistory: getHistory,
    getCount: getCount,
    clear: clear
  };
})();
