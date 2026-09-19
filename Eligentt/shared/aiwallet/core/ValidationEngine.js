/**
 * AIWallet ValidationEngine — Intent Validation Wrapper (Phase 4)
 * Wraps AIWallet.validateIntent. 13-stage pipeline unchanged.
 * Attached to: window.AIWValidationEngine
 */
(function () {
  'use strict';
  var _init = false;

  function initialize() { if (_init) return; _init = true; }

  /** Run full 13-stage validation pipeline */
  async function validate(intent) {
    try {
      if (typeof AIWallet !== 'undefined' && AIWallet.validateIntent) {
        return await AIWallet.validateIntent(intent);
      }
    } catch (e) {
      try { if (typeof ErrorHandler !== 'undefined') ErrorHandler.handle(e, { source: 'aiwallet.validation', operation: 'validate' }); } catch (_e) {}
    }
    return { valid: false, checks: [] };
  }

  /** Quick pre-check: is emergency stop active? */
  function isEmergencyStopped() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.isEmergencyStopped) return AIWallet.isEmergencyStopped(); } catch (_e) {}
    return false;
  }

  /** Quick pre-check: is wallet mode "personal"? */
  function isPersonalMode() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.getMode) return AIWallet.getMode() === 'personal'; } catch (_e) {}
    return false;
  }

  /** Check if validation would pass (dry-run) */
  async function dryRun(intent) {
    return await validate(intent);
  }

  function refresh() {}
  function destroy() { _init = false; }

  window.AIWValidationEngine = {
    VERSION: '1.0.0',
    initialize: initialize, validate: validate,
    isEmergencyStopped: isEmergencyStopped, isPersonalMode: isPersonalMode,
    dryRun: dryRun, refresh: refresh, destroy: destroy
  };
})();
