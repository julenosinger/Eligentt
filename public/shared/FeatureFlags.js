/**
 * FeatureFlags — Independent runtime flags for infrastructure modules.
 * Each module can be independently enabled/disabled without affecting the app.
 * Disabled modules immediately restore original runtime behavior.
 * Attached to window.FeatureFlags
 */
(function () {
  'use strict';

  var FLAGS_KEY = 'elligentt_infra_flags';
  var _flags = {};

  var DEFAULTS = {
    ENABLE_RUNTIME_HEALTH: true,
    ENABLE_PERF_METRICS: true,
    ENABLE_SHARED_CACHE: true,
    ENABLE_RUNTIME_AUDIT: true,
    ENABLE_RPC_REQUEST_MANAGER: true,
    ENABLE_RESOURCE_COORDINATOR: true,
    ENABLE_CHAOS_TESTS: false
  };

  function load() {
    try {
      var raw = localStorage.getItem(FLAGS_KEY);
      _flags = raw ? JSON.parse(raw) : {};
    } catch (_e) { _flags = {}; }
  }

  function save() {
    try { localStorage.setItem(FLAGS_KEY, JSON.stringify(_flags)); } catch (_e) {}
  }

  function isEnabled(key) {
    if (_flags[key] === false) return false;
    if (_flags[key] === true) return true;
    return DEFAULTS[key] !== false;
  }

  function setFlag(key, value) {
    _flags[key] = value;
    save();
  }

  function getAll() {
    var out = {};
    var keys = Object.keys(DEFAULTS);
    for (var i = 0; i < keys.length; i++) { out[keys[i]] = isEnabled(keys[i]); }
    return out;
  }

  function reset() { _flags = {}; save(); }

  load();

  window.FeatureFlags = {
    isEnabled: isEnabled,
    setFlag: setFlag,
    getAll: getAll,
    reset: reset,
    DEFAULTS: DEFAULTS
  };
})();
