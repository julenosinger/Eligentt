/**
 * Elligentt PluginLifecycle — Plugin Lifecycle Manager (Phase 5)
 * Manages plugin states: registered → initialized → started → stopped → destroyed.
 * Attached to: window.PluginLifecycle
 */
(function () {
  'use strict';
  var _states = {}; // pluginId → state
  var STATES = ['unregistered', 'registered', 'initializing', 'initialized', 'starting', 'started', 'stopping', 'stopped', 'error', 'destroyed'];

  function getState(pluginId) { return _states[pluginId] || 'unregistered'; }
  function getAll() { return Object.assign({}, _states); }

  function setState(pluginId, state, detail) {
    if (STATES.indexOf(state) === -1) return;
    _states[pluginId] = state;
    try {
      if (typeof EventBus !== 'undefined') EventBus.emit('PLUGIN_STATE_CHANGED', { id: pluginId, state: state, detail: detail });
    } catch (_e) {}
  }

  function initialize(plugin) {
    setState(plugin.id, 'initializing');
    try {
      if (typeof plugin.initialize === 'function') { plugin.initialize(); }
      setState(plugin.id, 'initialized');
      return true;
    } catch (e) {
      setState(plugin.id, 'error', e.message);
      return false;
    }
  }

  function start(plugin) {
    setState(plugin.id, 'starting');
    try {
      if (typeof plugin.start === 'function') { plugin.start(); }
      setState(plugin.id, 'started');
      return true;
    } catch (e) {
      setState(plugin.id, 'error', e.message);
      return false;
    }
  }

  function stop(plugin) {
    setState(plugin.id, 'stopping');
    try {
      if (typeof plugin.stop === 'function') { plugin.stop(); }
      setState(plugin.id, 'stopped');
      return true;
    } catch (e) {
      setState(plugin.id, 'error', e.message);
      return false;
    }
  }

  function destroy(plugin) {
    try {
      if (typeof plugin.destroy === 'function') { plugin.destroy(); }
    } catch (_e) {}
    setState(plugin.id, 'destroyed');
  }

  function clear() { _states = {}; }

  window.PluginLifecycle = {
    VERSION: '1.0.0',
    STATES: STATES, getState: getState, getAll: getAll,
    setState: setState, initialize: initialize, start: start,
    stop: stop, destroy: destroy, clear: clear
  };
})();
