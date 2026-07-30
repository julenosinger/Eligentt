/**
 * Elligentt RuntimeMode — LEGACY_COMPATIBILITY | MIXED | PURE_MODULAR (Phase 16)
 * PURE_MODULAR: no legacy fallback executed. Errors surface immediately.
 * Attached to: window.RuntimeMode
 */
(function () {
  'use strict';
  var MODES = ['LEGACY_COMPATIBILITY', 'MIXED', 'PURE_MODULAR'];
  var _mode = 'MIXED';
  var _violations = [];

  function setMode(mode) {
    if (MODES.indexOf(mode) === -1) return false;
    _mode = mode;
    try { if (typeof EventBus !== 'undefined') EventBus.emit('RUNTIME_MODE_CHANGED', { mode: _mode }); } catch (_e) {}
    try { if (typeof ProductionGuard !== 'undefined') ProductionGuard.setMode(mode === 'PURE_MODULAR' ? 'production' : 'development'); } catch (_e2) {}
    console.log('[RuntimeMode] Mode: ' + _mode);
    return true;
  }

  function getMode() { return _mode; }
  function isPure() { return _mode === 'PURE_MODULAR'; }
  function isMixed() { return _mode === 'MIXED'; }
  function isLegacyCompat() { return _mode === 'LEGACY_COMPATIBILITY'; }

  function recordViolation(name, detail) {
    _violations.push({ name: name, detail: detail, at: Date.now(), mode: _mode });
    if (_violations.length > 100) _violations.length = 100;
    if (_mode === 'PURE_MODULAR') {
      console.error('[RuntimeMode] PURE_MODULAR VIOLATION: ' + name + ' — legacy fallback detected');
    }
  }

  function getViolations() { return _violations.slice(); }
  function getSummary() {
    return { mode: _mode, violations: _violations.length, isPure: isPure() };
  }
  function clear() { _violations = []; }

  window.RuntimeMode = {
    VERSION: '16.0.0', MODES: MODES,
    setMode: setMode, getMode: getMode, isPure: isPure,
    isMixed: isMixed, isLegacyCompat: isLegacyCompat,
    recordViolation: recordViolation, getViolations: getViolations,
    getSummary: getSummary, clear: clear
  };
})();
