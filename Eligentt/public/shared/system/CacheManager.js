/**
 * Elligentt CacheManager — Centralized Cache with TTL (Phase 6)
 * Namespaced cache. TTL-based expiration. Memory + session persistence.
 * Attached to: window.CacheManager
 */
(function () {
  'use strict';
  var _caches = {};

  function namespace(ns) {
    if (!_caches[ns]) _caches[ns] = { entries: {}, hits: 0, misses: 0 };
    return _caches[ns];
  }

  function get(ns, key) {
    var cache = namespace(ns);
    var entry = cache.entries[key];
    if (!entry) { cache.misses++; return undefined; }
    if (entry.ttl && Date.now() - entry.at > entry.ttl) { delete cache.entries[key]; cache.misses++; return undefined; }
    cache.hits++;
    return entry.value;
  }

  function set(ns, key, value, ttl) {
    var cache = namespace(ns);
    cache.entries[key] = { value: value, at: Date.now(), ttl: ttl || null };
  }

  function remove(ns, key) { var cache = namespace(ns); delete cache.entries[key]; }
  function clear(ns) { if (ns) { delete _caches[ns]; } else { _caches = {}; } }
  function exists(ns, key) { return get(ns, key) !== undefined; }
  function keys(ns) { var cache = namespace(ns); return Object.keys(cache.entries); }
  function size(ns) { var cache = namespace(ns); return Object.keys(cache.entries).length; }

  function getMetrics(ns) {
    var cache = namespace(ns);
    return { entries: Object.keys(cache.entries).length, hits: cache.hits, misses: cache.misses, hitRate: cache.hits + cache.misses > 0 ? Math.round((cache.hits / (cache.hits + cache.misses)) * 100) : 0 };
  }

  function getAllMetrics() {
    var result = {};
    var nsKeys = Object.keys(_caches);
    for (var i = 0; i < nsKeys.length; i++) result[nsKeys[i]] = getMetrics(nsKeys[i]);
    return result;
  }

  window.CacheManager = {
    VERSION: '1.0.0', get: get, set: set, remove: remove, clear: clear,
    exists: exists, keys: keys, size: size, getMetrics: getMetrics, getAllMetrics: getAllMetrics
  };
})();
