/**
 * Elligentt ProductionMigrationGuard — Legacy Fallback Blocker (Phase 10)
 * In production: detects and logs legacy execution attempts. Blocks if configured.
 * In development/emergency: legacy fallback still available.
 * Attached to: window.ProductionGuard
 */
(function () {
  'use strict';

  var _mode = 'production'; // 'production' | 'development' | 'emergency'
  var _blocked = [];
  var _warnings = [];

  function setMode(mode) { _mode = mode; }

  /**
   * Guard a function call. If in production and legacy is used, log warning.
   * @param {string} name - Function name
   * @param {boolean} isNewPath - true if new architecture was used
   * @param {boolean} isLegacyPath - true if legacy fallback was used
   */
  function guard(name, isNewPath, isLegacyPath) {
    if (_mode === 'production' && isLegacyPath && !isNewPath) {
      var entry = { func: name, timestamp: Date.now(), mode: _mode };
      _blocked.push(entry);
      if (_blocked.length > 100) _blocked.length = 100;
      console.warn('[ProductionGuard] LEGACY FALLBACK: ' + name + ' — new architecture unavailable');
      try { if (typeof EventBus !== 'undefined') EventBus.emit('LEGACY_FALLBACK_DETECTED', entry); } catch (_e) {}
    }
    if (isLegacyPath) {
      _warnings.push({ func: name, timestamp: Date.now() });
      if (_warnings.length > 200) _warnings.length = 200;
    }
  }

  function getBlocked() { return _blocked.slice(); }
  function getWarnings() { return _warnings.slice(); }
  function getSummary() {
    return {
      mode: _mode,
      totalBlocked: _blocked.length,
      totalWarnings: _warnings.length,
      legacyFree: _blocked.length === 0 && _warnings.length === 0
    };
  }
  function clear() { _blocked = []; _warnings = []; }

  window.ProductionGuard = {
    VERSION: '1.0.0',
    setMode: setMode, guard: guard,
    getBlocked: getBlocked, getWarnings: getWarnings,
    getSummary: getSummary, clear: clear
  };
})();
