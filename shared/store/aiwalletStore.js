/**
 * Elligentt AIWalletStore — AI Smart Wallet State (Phase 15)
 * Migrates: wallet mode, emergency stop, limits, intents, history.
 * Attached to: window.AIWalletStore
 */
(function () {
  'use strict';
  var _state = { mode: 'hybrid', emergencyStop: false, intents: [], history: [], limits: {} };

  function load() {
    try { if (typeof AIWallet !== 'undefined') { _state.mode = AIWallet.getMode ? AIWallet.getMode() : 'hybrid'; _state.emergencyStop = AIWallet.isEmergencyStopped ? AIWallet.isEmergencyStopped() : false; _state.intents = AIWallet.getIntents ? AIWallet.getIntents() : []; _state.history = AIWallet.getHistory ? AIWallet.getHistory() : []; } } catch (_e) {}
  }

  function get(key) { return _state[key]; }
  function set(key, val) { _state[key] = val; try { if (typeof EventBus !== 'undefined') EventBus.emit('AIWALLET_STATE_CHANGED', { key: key }); } catch (_e) {} }
  function getSnapshot() { load(); return Object.assign({}, _state); }
  function refresh() { load(); }

  window.AIWalletStore = { VERSION: '15.0.0', get: get, set: set, getSnapshot: getSnapshot, refresh: refresh };
})();
