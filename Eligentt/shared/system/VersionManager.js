/**
 * Elligentt VersionManager — Module & Schema Version Tracking (Phase 6)
 * Attached to: window.VersionManager
 */
(function () {
  'use strict';
  var _versions = {};

  function register(moduleId, version, compatRange) {
    _versions[moduleId] = { version: version, compatRange: compatRange || version, registeredAt: Date.now() };
    return true;
  }

  function get(moduleId) { return _versions[moduleId] || null; }
  function getAll() { return Object.assign({}, _versions); }
  function isCompatible(moduleId, requiredVersion) {
    if (!_versions[moduleId]) return false;
    return _versions[moduleId].compatRange === requiredVersion || _versions[moduleId].version === requiredVersion;
  }

  function checkCompatibility(required) {
    var issues = [];
    Object.keys(required).forEach(function (mod) {
      if (!isCompatible(mod, required[mod])) issues.push({ module: mod, required: required[mod], actual: _versions[mod] ? _versions[mod].version : 'not found' });
    });
    return { compatible: issues.length === 0, issues: issues };
  }

  function clear() { _versions = {}; }

  // Auto-register known module versions
  try {
    var known = { AppBootstrap: '1.0.0', EventBus: '1.0.0', ApplicationKernel: '1.0.0', AIWallet: '1.0.0', AutonomaCoreV2: '1.0.0', PluginRegistry: '1.0.0' };
    Object.keys(known).forEach(function (k) { register(k, known[k]); });
  } catch (_e) {}

  window.VersionManager = {
    VERSION: '1.0.0', register: register, get: get, getAll: getAll,
    isCompatible: isCompatible, checkCompatibility: checkCompatibility, clear: clear
  };
})();
