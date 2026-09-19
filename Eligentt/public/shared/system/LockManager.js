/**
 * Elligentt LockManager — Prevent concurrent operations (Phase 6)
 * Named locks with optional timeout. Prevents duplicate execution.
 * Attached to: window.LockManager
 */
(function () {
  'use strict';
  var _locks = {};
  var DEFAULT_TTL = 30000;

  function acquire(name, ttl) {
    var key = String(name);
    var now = Date.now();
    var entry = _locks[key];
    var timeout = ttl || DEFAULT_TTL;
    if (entry && (now - entry.acquiredAt) < timeout) return false;
    _locks[key] = { acquiredAt: now, ttl: timeout, holder: name };
    return true;
  }

  function release(name) { delete _locks[String(name)]; return true; }

  function isLocked(name) {
    var entry = _locks[String(name)];
    if (!entry) return false;
    var now = Date.now();
    if ((now - entry.acquiredAt) >= entry.ttl) { delete _locks[String(name)]; return false; }
    return true;
  }

  function withLock(name, ttl, fn) {
    if (!acquire(name, ttl)) return Promise.resolve(null);
    try {
      var result = fn();
      if (result && typeof result.then === 'function') {
        return result.then(function (val) { release(name); return val; }).catch(function (e) { release(name); throw e; });
      }
      release(name);
      return Promise.resolve(result);
    } catch (e) { release(name); throw e; }
  }

  function getActive() { return Object.keys(_locks); }
  function clear() { _locks = {}; }

  window.LockManager = {
    VERSION: '1.0.0', acquire: acquire, release: release, isLocked: isLocked,
    withLock: withLock, getActive: getActive, clear: clear
  };
})();
