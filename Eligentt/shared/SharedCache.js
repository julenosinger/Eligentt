/**
 * SharedCache — Lightweight in-memory caches for read-only data.
 * Reduces duplicate computations. Never caches mutable execution state.
 * Attached to window.SharedCache
 */
(function () {
  'use strict';

  try { if (typeof FeatureFlags !== 'undefined' && !FeatureFlags.isEnabled('ENABLE_SHARED_CACHE')) { window.SharedCache = { get: function(){return null}, set: function(){}, remove: function(){}, clear: function(){}, has: function(){return false}, getStats: function(){return{entries:0}} }; return; } } catch(_f) {}

  var _caches = {};
  var DEFAULT_TTL = 30000;

  function get(key) {
    var c = _caches[key];
    if (!c) return null;
    if (Date.now() - c.ts > (c.ttl || DEFAULT_TTL)) { delete _caches[key]; return null; }
    return c.value;
  }

  function set(key, value, ttlMs) {
    _caches[key] = { value: value, ts: Date.now(), ttl: ttlMs || DEFAULT_TTL };
  }

  function remove(key) { delete _caches[key]; }
  function clear() { _caches = {}; }
  function has(key) { return get(key) !== null; }

  function getStats() {
    var keys = Object.keys(_caches);
    return { entries: keys.length, keys: keys, totalHits: 0 };
  }

  window.SharedCache = {
    get: get, set: set, remove: remove, clear: clear, has: has, getStats: getStats
  };
})();
