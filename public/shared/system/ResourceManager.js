/**
 * Elligentt ResourceManager — Track memory, timers, intervals, listeners (Phase 6)
 * Prevents resource leaks. Registers all long-lived resources.
 * Attached to: window.ResourceManager
 */
(function () {
  'use strict';
  var _resources = { timers: [], intervals: [], observers: [], listeners: 0 };

  var _origSetInterval = window.setInterval;
  var _origSetTimeout = window.setTimeout;
  var _origAddEventListener = EventTarget.prototype.addEventListener;
  var _origObserve = typeof MutationObserver !== 'undefined' ? MutationObserver.prototype.observe : null;

  function trackInterval(fn, ms) {
    var id = _origSetInterval.call(window, function () { _resources.intervals = _resources.intervals.filter(function (r) { return r.id !== id; }); if (typeof fn === 'function') fn(); }, ms);
    _resources.intervals.push({ id: id, ms: ms, createdAt: Date.now() });
    return id;
  }

  function trackTimeout(fn, ms) {
    var id = _origSetTimeout.call(window, function () { _resources.timers = _resources.timers.filter(function (r) { return r.id !== id; }); if (typeof fn === 'function') fn(); }, ms);
    _resources.timers.push({ id: id, ms: ms, createdAt: Date.now() });
    return id;
  }

  function getSnapshot() {
    return {
      activeIntervals: _resources.intervals.length,
      activeTimers: _resources.timers.length,
      activeObservers: _resources.observers.length,
      estimatedListeners: _resources.listeners
    };
  }

  function clearAll() {
    _resources.intervals.forEach(function (r) { clearInterval(r.id); });
    _resources.timers.forEach(function (r) { clearTimeout(r.id); });
    _resources.intervals = [];
    _resources.timers = [];
    _resources.observers = [];
  }

  function incrementListeners() { _resources.listeners++; }
  function decrementListeners() { _resources.listeners = Math.max(0, _resources.listeners - 1); }

  window.ResourceManager = {
    VERSION: '1.0.0', trackInterval: trackInterval, trackTimeout: trackTimeout,
    getSnapshot: getSnapshot, clearAll: clearAll,
    incrementListeners: incrementListeners, decrementListeners: decrementListeners
  };
})();
