/**
 * Elligentt RuntimeMode — Phase 19 PURE_MODULAR DEFAULT
 *
 * Modes: LEGACY_COMPATIBILITY | MIXED | PURE_MODULAR
 *
 * Phase 19 CHANGE: Default mode is now PURE_MODULAR.
 * NO LEGACY FALLBACK allowed.
 *
 * Attached to: window.RuntimeMode
 *
 * @module RuntimeMode
 * @version 19.0.0
 */
(function () {
  'use strict';
  var MODES = ['LEGACY_COMPATIBILITY', 'MIXED', 'PURE_MODULAR'];

  /** Phase 19: DEFAULT TO PURE_MODULAR */
  var _mode = 'PURE_MODULAR';

  var _violations = [];

  function setMode(mode) {
    if (MODES.indexOf(mode) === -1) return false;
    _mode = mode;
    try { if (typeof EventBus !== 'undefined') EventBus.emit('RUNTIME_MODE_CHANGED', { mode: _mode }); } catch (_e) {}
    try {
      if (typeof ProductionGuard !== 'undefined') {
        ProductionGuard.setMode(mode === 'PURE_MODULAR' ? 'production' : 'development');
      }
    } catch (_e2) {}

    // Phase 19: When switching to PURE_MODULAR, activate PureExecutionGuard
    if (mode === 'PURE_MODULAR') {
      try {
        if (typeof PureExecutionGuard !== 'undefined') PureExecutionGuard.activate();
      } catch (_e3) {}
      try {
        if (typeof PureRuntimeValidator !== 'undefined') PureRuntimeValidator.start();
      } catch (_e4) {}
    }

    console.log('[RuntimeMode v19] Mode: ' + _mode + (mode === 'PURE_MODULAR' ? ' — NO LEGACY FALLBACK' : ''));
    return true;
  }

  function getMode() { return _mode; }
  function isPure() { return _mode === 'PURE_MODULAR'; }
  function isMixed() { return _mode === 'MIXED'; }
  function isLegacyCompat() { return _mode === 'LEGACY_COMPATIBILITY'; }

  function recordViolation(name, detail) {
    _violations.push({ name: name, detail: detail, at: Date.now(), mode: _mode });
    if (_violations.length > 200) _violations.length = 200;
    if (_mode === 'PURE_MODULAR') {
      console.error('[RuntimeMode v19] PURE_MODULAR VIOLATION: ' + name + ' — ' + (detail || 'legacy execution detected'));
    }
  }

  function getViolations() { return _violations.slice(); }
  function getSummary() {
    return {
      version: '19.0.0',
      mode: _mode,
      violations: _violations.length,
      isPure: isPure(),
      pureModularEnabled: isPure()
    };
  }
  function clear() { _violations = []; }

  window.RuntimeMode = {
    VERSION: '19.0.0',
    MODES: MODES,
    setMode: setMode,
    getMode: getMode,
    isPure: isPure,
    isMixed: isMixed,
    isLegacyCompat: isLegacyCompat,
    recordViolation: recordViolation,
    getViolations: getViolations,
    getSummary: getSummary,
    clear: clear
  };
})();
