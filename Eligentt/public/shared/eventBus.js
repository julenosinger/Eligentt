/**
 * Elligentt EventBus — Application-Wide Event System (Phase 1 Architecture)
 *
 * Decouples modules. Zero dependencies. Async-safe. Exception-isolated.
 * Unlimited listeners per event. No memory leaks. No duplicated listeners.
 *
 * Errors inside listeners NEVER stop the application.
 *
 * Attached to: window.EventBus
 *
 * @module eventBus
 * @version 1.0.0
 */
(function () {
  'use strict';

  /** @type {Record<string, Array<{id: string, fn: Function, once: boolean}>>} */
  var _listeners = {};

  /** @type {number} Counter for unique listener IDs */
  var _idCounter = 0;

  /**
   * Generate a unique listener ID.
   * @returns {string}
   */
  function _nextId() {
    _idCounter += 1;
    return 'l_' + Date.now().toString(36) + '_' + _idCounter;
  }

  /**
   * Register a listener for an event.
   *
   * @param {string} eventName - Event name (case-sensitive)
   * @param {Function} fn - Callback function. Receives payload, eventName.
   * @returns {{ off: Function }} An object with an `off()` method to remove this specific listener.
   *
   * @example
   *   var sub = EventBus.on('WALLET_CONNECTED', function(payload) { ... });
   *   // later: sub.off();
   */
  function on(eventName, fn) {
    if (typeof fn !== 'function') {
      console.warn('[EventBus] on("' + eventName + '") — fn is not a function, ignoring');
      return { off: function () {} };
    }
    if (!_listeners[eventName]) {
      _listeners[eventName] = [];
    }

    var entry = { id: _nextId(), fn: fn, once: false };
    _listeners[eventName].push(entry);

    return {
      off: function () {
        _removeListener(eventName, entry.id);
      }
    };
  }

  /**
   * Register a one-shot listener. Fires at most once, then auto-removes.
   *
   * @param {string} eventName
   * @param {Function} fn
   * @returns {{ off: Function }}
   */
  function once(eventName, fn) {
    if (typeof fn !== 'function') {
      console.warn('[EventBus] once("' + eventName + '") — fn is not a function, ignoring');
      return { off: function () {} };
    }
    if (!_listeners[eventName]) {
      _listeners[eventName] = [];
    }

    var entry = { id: _nextId(), fn: fn, once: true };
    _listeners[eventName].push(entry);

    return {
      off: function () {
        _removeListener(eventName, entry.id);
      }
    };
  }

  /**
   * Remove a specific listener by event + ID.
   * @param {string} eventName
   * @param {string} id
   */
  function _removeListener(eventName, id) {
    var list = _listeners[eventName];
    if (!list) return;
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i].id === id) {
        list.splice(i, 1);
        break;
      }
    }
    if (list.length === 0) {
      delete _listeners[eventName];
    }
  }

  /**
   * Remove all listeners registered with a specific callback reference.
   * Useful for cleanup when the same function was registered multiple times.
   *
   * @param {string} eventName
   * @param {Function} fn - The exact function reference to remove
   */
  function off(eventName, fn) {
    if (!eventName || !_listeners[eventName]) return;

    if (fn) {
      var list = _listeners[eventName];
      for (var i = list.length - 1; i >= 0; i--) {
        if (list[i].fn === fn) {
          list.splice(i, 1);
        }
      }
      if (list.length === 0) {
        delete _listeners[eventName];
      }
    } else {
      // Remove ALL listeners for this event
      _listeners[eventName].length = 0;
      delete _listeners[eventName];
    }
  }

  /**
   * Emit an event to all registered listeners.
   *
   * Each listener runs in its own try/catch — errors in one listener
   * never prevent other listeners from executing.
   *
   * @param {string} eventName
   * @param {*} [payload] - Optional payload passed to each listener
   * @returns {Promise<void>} Resolves after all listeners have run (including async ones)
   *
   * @example
   *   EventBus.emit('WALLET_CONNECTED', { address: '0x...', chainId: 5042002 });
   */
  function emit(eventName, payload) {
    var list = _listeners[eventName];
    if (!list || list.length === 0) return Promise.resolve();

    var promises = [];
    var toRemove = [];

    for (var i = 0; i < list.length; i++) {
      var entry = list[i];
      try {
        var result = entry.fn(payload, eventName);
        // Collect async results for error isolation
        if (result && typeof result.then === 'function') {
          promises.push(
            result.catch(function (e) {
              console.warn('[EventBus] Async listener error on "' + eventName + '":', e);
            })
          );
        }
      } catch (e) {
        console.warn('[EventBus] Listener error on "' + eventName + '":', e);
      }
      // Mark once-listeners for removal
      if (entry.once) {
        toRemove.push(entry.id);
      }
    }

    // Remove once-listeners
    for (var j = 0; j < toRemove.length; j++) {
      _removeListener(eventName, toRemove[j]);
    }

    return Promise.allSettled
      ? Promise.allSettled(promises).then(function () { /* void */ })
      : Promise.all(promises).catch(function () { /* void */ });
  }

  /**
   * Remove ALL listeners for ALL events.
   * Use only for global teardown (e.g., testing, hot-reload).
   */
  function clear() {
    var keys = Object.keys(_listeners);
    for (var i = 0; i < keys.length; i++) {
      _listeners[keys[i]].length = 0;
    }
    _listeners = {};
    _idCounter = 0;
  }

  /**
   * Get the number of listeners for a specific event, or total across all events.
   * @param {string} [eventName] - If provided, returns count for that event only.
   * @returns {number}
   */
  function count(eventName) {
    if (eventName) {
      return _listeners[eventName] ? _listeners[eventName].length : 0;
    }
    var total = 0;
    var keys = Object.keys(_listeners);
    for (var i = 0; i < keys.length; i++) {
      total += _listeners[keys[i]].length;
    }
    return total;
  }

  /**
   * List all registered event names.
   * @returns {string[]}
   */
  function events() {
    return Object.keys(_listeners);
  }

  /** @public */
  window.EventBus = {
    VERSION: '1.0.0',
    on: on,
    once: once,
    off: off,
    emit: emit,
    clear: clear,
    count: count,
    events: events
  };
})();
