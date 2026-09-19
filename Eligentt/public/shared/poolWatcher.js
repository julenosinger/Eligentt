/**
 * Elligentt Pool Watcher (FIX EURC POOL)
 * ═══════════════════════════════════════
 * Monitors all active pools. Detects unexpected disappearances, state changes,
 * and temporary RPC failures. Pools never removed silently.
 * Attached to window.PoolWatcher
 */
(function(){
  'use strict';

  var WATCHER_KEY = 'elligentt_pool_watcher_v1';
  var WATCH_INTERVAL = 15000; // 15s
  var watcherTimer = null;
  var watcherActive = false;
  var watcherLog = [];
  var MAX_LOG = 100;

  var registeredPools = [];

  function loadLog() {
    try {
      var raw = localStorage.getItem(WATCHER_KEY);
      if (raw) watcherLog = JSON.parse(raw);
    } catch(e) { watcherLog = []; }
    _pruneLog();
  }

  function saveLog() {
    try { localStorage.setItem(WATCHER_KEY, JSON.stringify(watcherLog)); } catch(e) {}
  }

  function _pruneLog() {
    if (watcherLog.length > MAX_LOG) {
      watcherLog = watcherLog.slice(watcherLog.length - MAX_LOG);
    }
  }

  function _log(event, poolId, detail) {
    var entry = {
      timestamp: Date.now(),
      event: event,
      poolId: poolId,
      detail: detail || ''
    };
    watcherLog.push(entry);
    _pruneLog();
    saveLog();
  }

  function registerPool(poolId, poolConfig) {
    var existing = registeredPools.find(function(p) { return p.id === poolId; });
    if (existing) {
      existing.config = poolConfig;
      existing.lastSeen = Date.now();
      existing.missCount = 0;
      return;
    }
    registeredPools.push({
      id: poolId,
      config: poolConfig,
      registeredAt: Date.now(),
      lastSeen: Date.now(),
      missCount: 0,
      status: 'registered'
    });
    _log('REGISTERED', poolId, 'Pool registered for monitoring');
  }

  function markSeen(poolId) {
    var p = registeredPools.find(function(r) { return r.id === poolId; });
    if (p) {
      var wasMissing = p.missCount > 0;
      p.lastSeen = Date.now();
      p.missCount = 0;
      p.status = 'active';
      if (wasMissing) {
        _log('RECOVERED', poolId, 'Pool reappeared after ' + (wasMissing ? 'being missing' : ''));
      }
    }
  }

  function markUnseen(poolId, reason) {
    var p = registeredPools.find(function(r) { return r.id === poolId; });
    if (!p) return;
    p.missCount++;
    if (p.missCount === 1) {
      _log('MISSING', poolId, reason || 'Pool not found in render cycle');
      p.status = 'missing';
    }
    if (p.missCount >= 3) {
      _log('DISAPPEARED', poolId, 'Missing for ' + p.missCount + ' cycles');
      p.status = 'disappeared';
    }
  }

  function checkPool(poolId, isVisible, reason) {
    if (isVisible) {
      markSeen(poolId);
    } else {
      markUnseen(poolId, reason);
    }
  }

  function startWatcher(intervalMs) {
    if (watcherActive) return;
    watcherActive = true;
    var ms = intervalMs || WATCH_INTERVAL;
    watcherTimer = setInterval(function() {
      try {
        var now = Date.now();
        for (var i = 0; i < registeredPools.length; i++) {
          var p = registeredPools[i];
          var age = now - p.lastSeen;
          if (p.status === 'active' && age > WATCH_INTERVAL * 2) {
            _log('STALE', p.id, 'No update in ' + Math.round(age / 1000) + 's');
            p.status = 'stale';
          }
        }
      } catch(e) {}
    }, ms);
  }

  function stopWatcher() {
    watcherActive = false;
    if (watcherTimer) {
      clearInterval(watcherTimer);
      watcherTimer = null;
    }
  }

  function isPoolHealthy(poolId) {
    var p = registeredPools.find(function(r) { return r.id === poolId; });
    if (!p) return false;
    return p.status === 'active' || p.status === 'registered';
  }

  function getPoolWatchStatus(poolId) {
    var p = registeredPools.find(function(r) { return r.id === poolId; });
    if (!p) return null;
    return {
      poolId: poolId,
      status: p.status,
      missCount: p.missCount,
      lastSeen: p.lastSeen,
      age: Date.now() - p.lastSeen,
      registeredAt: p.registeredAt
    };
  }

  function getAllWatchStatus() {
    return registeredPools.map(function(p) { return getPoolWatchStatus(p.id); });
  }

  function getMissingPools() {
    return registeredPools.filter(function(p) { return p.status === 'missing' || p.status === 'disappeared' || p.status === 'stale'; });
  }

  function getRecentEvents(count) {
    return watcherLog.slice(-(count || 20));
  }

  function clearEvents() {
    watcherLog = [];
    saveLog();
  }

  loadLog();

  // Auto-start watcher
  startWatcher();

  window.PoolWatcher = {
    registerPool: registerPool,
    markSeen: markSeen,
    markUnseen: markUnseen,
    checkPool: checkPool,
    startWatcher: startWatcher,
    stopWatcher: stopWatcher,
    isPoolHealthy: isPoolHealthy,
    getPoolWatchStatus: getPoolWatchStatus,
    getAllWatchStatus: getAllWatchStatus,
    getMissingPools: getMissingPools,
    getRecentEvents: getRecentEvents,
    clearEvents: clearEvents,
    get registeredPools() { return registeredPools; },
    get watcherActive() { return watcherActive; },
    WATCH_INTERVAL: WATCH_INTERVAL
  };
})();
