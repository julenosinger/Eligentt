/**
 * Elligentt SettingsStore — Centralized Settings State Management (Phase 1 Architecture)
 *
 * Encapsulates application settings. Persists to localStorage.
 * Does NOT replace existing settings logic — provides a structured alternative.
 *
 * Attached to: window.SettingsStore
 *
 * @module settingsStore
 * @version 1.0.0
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'elligentt_settings_store_v1';

  /** @type {{ slippage: string, gasLimit: string, defaultNetwork: string, theme: string, language: string, notifications: boolean, autoExecute: boolean, maxRisk: string, autoBridge: boolean }} */
  var _state = {
    slippage: '0.5',
    gasLimit: 'auto',
    defaultNetwork: 'Arc_Testnet',
    theme: 'dark',
    language: 'en',
    notifications: true,
    autoExecute: false,
    maxRisk: 'MEDIUM',
    autoBridge: true
  };

  /* ════════════════════════════════════════════
     PERSISTENCE
  ════════════════════════════════════════════ */

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        var keys = Object.keys(_state);
        for (var i = 0; i < keys.length; i++) {
          if (parsed[keys[i]] !== undefined) {
            _state[keys[i]] = parsed[keys[i]];
          }
        }
      }
    } catch (_e) { /* ignore corrupted data */ }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(_state));
    } catch (_e) { /* quota exceeded — silently ignore */ }
  }

  /* ════════════════════════════════════════════
     GETTERS
  ════════════════════════════════════════════ */

  /** @returns {string} */
  function getSlippage() { return _state.slippage; }

  /** @returns {string} */
  function getGasLimit() { return _state.gasLimit; }

  /** @returns {string} */
  function getDefaultNetwork() { return _state.defaultNetwork; }

  /** @returns {string} */
  function getTheme() { return _state.theme; }

  /** @returns {string} */
  function getLanguage() { return _state.language; }

  /** @returns {boolean} */
  function getNotificationsEnabled() { return _state.notifications; }

  /** @returns {boolean} */
  function getAutoExecute() { return _state.autoExecute; }

  /** @returns {string} */
  function getMaxRisk() { return _state.maxRisk; }

  /** @returns {boolean} */
  function getAutoBridge() { return _state.autoBridge; }

  /** @returns {Object} */
  function getSnapshot() { return Object.assign({}, _state); }

  /* ════════════════════════════════════════════
     SETTERS
  ════════════════════════════════════════════ */

  /**
   * Update one or more settings.
   * @param {Object} patch - Key-value pairs to update
   * @emits SETTINGS_CHANGED
   */
  function update(patch) {
    var changed = false;
    var keys = Object.keys(patch);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (_state[k] !== patch[k]) {
        _state[k] = patch[k];
        changed = true;
      }
    }
    if (changed) {
      save();
      try {
        if (typeof EventBus !== 'undefined' && EventBus.emit) {
          EventBus.emit('SETTINGS_CHANGED', { settings: Object.assign({}, _state), changed: Object.keys(patch) });
        }
      } catch (_e) { /* isolation */ }
    }
  }

  /**
   * Reset all settings to defaults.
   * @emits SETTINGS_CHANGED
   */
  function reset() {
    _state.slippage = '0.5';
    _state.gasLimit = 'auto';
    _state.defaultNetwork = 'Arc_Testnet';
    _state.theme = 'dark';
    _state.language = 'en';
    _state.notifications = true;
    _state.autoExecute = false;
    _state.maxRisk = 'MEDIUM';
    _state.autoBridge = true;
    save();
    try {
      if (typeof EventBus !== 'undefined' && EventBus.emit) {
        EventBus.emit('SETTINGS_CHANGED', { settings: Object.assign({}, _state), changed: Object.keys(_state) });
      }
    } catch (_e) { /* isolation */ }
  }

  // Load on init
  load();

  /** @public */
  window.SettingsStore = {
    VERSION: '1.0.0',
    getSlippage: getSlippage,
    getGasLimit: getGasLimit,
    getDefaultNetwork: getDefaultNetwork,
    getTheme: getTheme,
    getLanguage: getLanguage,
    getNotificationsEnabled: getNotificationsEnabled,
    getAutoExecute: getAutoExecute,
    getMaxRisk: getMaxRisk,
    getAutoBridge: getAutoBridge,
    getSnapshot: getSnapshot,
    update: update,
    reset: reset
  };
})();
