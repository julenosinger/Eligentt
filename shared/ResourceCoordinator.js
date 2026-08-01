/**
 * ResourceCoordinator — Prevents duplicate timers, intervals, observers, background jobs.
 * Smart refresh: only refresh on visibility change, wallet change, network change, or manual.
 * NEVER changes business behavior. Invisible to users.
 * Attached to window.ResourceCoordinator
 */
(function () {
  'use strict';

  try { if (typeof FeatureFlags !== 'undefined' && !FeatureFlags.isEnabled('ENABLE_RESOURCE_COORDINATOR')) { window.ResourceCoordinator = { registerTimer: function(i,f,m){return setTimeout(f,m)}, registerInterval: function(i,f,m){return setInterval(f,m)}, registerObserver: function(){return{disconnect:function(){}}}, clearTimer: function(){}, clearInterval: function(){}, clearObserver: function(){}, shouldRefresh: function(){return true}, registerBackgroundJob: function(){}, onVisibilityChange: function(){}, releaseUnused: function(){}, getStats: function(){return{}} }; return; } } catch(_f) {}

  var _registeredTimers = {};
  var _registeredIntervals = {};
  var _registeredObservers = {};
  var _registeredJobs = {};
  var _pageVisible = true;
  var _lastWallet = null;
  var _lastNetwork = null;
  var _stats = { timersPrevented: 0, intervalsPrevented: 0, observersPrevented: 0, jobsPrevented: 0, refreshesSkipped: 0 };

  document.addEventListener('visibilitychange', function () {
    _pageVisible = !document.hidden;
    if (_pageVisible) _stats.refreshesSkipped = 0;
  });

  function registerTimer(id, fn, ms) {
    var key = id || 'tmr_' + Date.now();
    if (_registeredTimers[key]) { clearTimeout(_registeredTimers[key]); _stats.timersPrevented++; }
    _registeredTimers[key] = setTimeout(fn, ms);
    return key;
  }

  function registerInterval(id, fn, ms) {
    var key = id || 'ivl_' + Date.now();
    if (_registeredIntervals[key]) { clearInterval(_registeredIntervals[key]); _stats.intervalsPrevented++; }
    _registeredIntervals[key] = setInterval(fn, ms);
    return key;
  }

  function registerObserver(id, target, config, callback) {
    var key = id || 'obs_' + Date.now();
    if (_registeredObservers[key]) { _registeredObservers[key].disconnect(); _stats.observersPrevented++; }
    var obs = new MutationObserver(callback);
    obs.observe(target, config || { childList: true, subtree: true });
    _registeredObservers[key] = obs;
    return key;
  }

  function clearTimer(id) { if (_registeredTimers[id]) { clearTimeout(_registeredTimers[id]); delete _registeredTimers[id]; } }
  function clearInterval(id) { if (_registeredIntervals[id]) { clearInterval(window, _registeredIntervals[id]); delete _registeredIntervals[id]; } }
  function clearObserver(id) { if (_registeredObservers[id]) { _registeredObservers[id].disconnect(); delete _registeredObservers[id]; } }

  function shouldRefresh(reason) {
    if (reason === 'manual') return true;
    if (reason === 'visibility' && _pageVisible) return true;
    if (reason === 'wallet_change') return true;
    if (reason === 'network_change') return true;
    _stats.refreshesSkipped++;
    return false;
  }

  function registerBackgroundJob(id, fn) {
    var key = id || 'job_' + Date.now();
    if (_registeredJobs[key]) { _stats.jobsPrevented++; return key; }
    _registeredJobs[key] = true;
    try { fn(); } catch (_e) {}
    setTimeout(function () { delete _registeredJobs[key]; }, 30000);
    return key;
  }

  function onVisibilityChange(callback) {
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && typeof callback === 'function') callback();
    });
  }

  function releaseUnused() {
    var now = Date.now();
    var tmrKeys = Object.keys(_registeredTimers);
    var ivlKeys = Object.keys(_registeredIntervals);
    var obsKeys = Object.keys(_registeredObservers);
    var jobKeys = Object.keys(_registeredJobs);
    if (tmrKeys.length > 50) { for (var i = 0; i < tmrKeys.length - 50; i++) clearTimer(tmrKeys[i]); }
    if (ivlKeys.length > 30) { for (var j = 0; j < ivlKeys.length - 30; j++) clearInterval(ivlKeys[j]); }
    if (obsKeys.length > 20) { for (var k = 0; k < obsKeys.length - 20; k++) clearObserver(obsKeys[k]); }
    if (jobKeys.length > 100) { _registeredJobs = {}; }
  }
  setInterval(releaseUnused, 60000);

  function getStats() {
    return {
      activeTimers: Object.keys(_registeredTimers).length,
      activeIntervals: Object.keys(_registeredIntervals).length,
      activeObservers: Object.keys(_registeredObservers).length,
      activeJobs: Object.keys(_registeredJobs).length,
      ..._stats
    };
  }

  window.ResourceCoordinator = {
    registerTimer: registerTimer,
    registerInterval: registerInterval,
    registerObserver: registerObserver,
    clearTimer: clearTimer,
    clearInterval: clearInterval,
    clearObserver: clearObserver,
    shouldRefresh: shouldRefresh,
    registerBackgroundJob: registerBackgroundJob,
    onVisibilityChange: onVisibilityChange,
    releaseUnused: releaseUnused,
    getStats: getStats
  };
})();
