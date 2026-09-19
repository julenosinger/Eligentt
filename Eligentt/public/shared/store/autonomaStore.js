/**
 * Elligentt AutonomaStore — Autonoma Conversation State (Phase 15)
 * Migrates: current goal, history, preferences, world state.
 * Attached to: window.AutonomaStore
 */
(function () {
  'use strict';
  var _state = { currentGoal: null, history: [], preferences: {}, worldState: null };

  function load() {
    try { if (typeof AutonomaCore !== 'undefined') { _state.currentGoal = AutonomaCore.getGoal ? AutonomaCore.getGoal() : null; _state.preferences = AutonomaCore.getPreferences ? AutonomaCore.getPreferences() : {}; _state.worldState = AutonomaCore.getWorldState ? AutonomaCore.getWorldState() : null; } } catch (_e) {}
  }

  function get(key) { return _state[key]; }
  function set(key, val) { _state[key] = val; try { if (typeof EventBus !== 'undefined') EventBus.emit('AUTONOMA_STATE_CHANGED', { key: key }); } catch (_e) {} }
  function getSnapshot() { load(); return Object.assign({}, _state); }
  function reset() { _state = { currentGoal: null, history: [], preferences: {}, worldState: null }; }

  window.AutonomaStore = { VERSION: '15.0.0', get: get, set: set, getSnapshot: getSnapshot, reset: reset };
})();
