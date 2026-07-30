/**
 * AIWallet StorageEngine — Centralized Storage Abstraction (Phase 4)
 * No module should directly access localStorage. Route through here.
 * Wraps existing AIWallet storage keys. Backward compatible.
 * Attached to: window.AIWStorageEngine
 */
(function () {
  'use strict';
  var VERSION = '1.0.0';

  /** Known storage keys (shadow AIWallet internal keys) */
  var K = {
    intents: 'elligentt_aiw_intents_v1',
    history: 'elligentt_aiw_history_v1',
    vault:   'elligentt_aiw_vault_v1',
    gas:     'elligentt_aiw_gas_v1',
    limits:  'elligentt_aiw_limits_v1',
    settings:'elligentt_aiw_settings_v1',
    approvals:'elligentt_aiw_approvals_v1',
    workflows:'elligentt_aiw_workflows_v1',
    wfstate: 'elligentt_aiw_wfstate_v1',
    gaslog:  'elligentt_aiw_gaslog_v1',
    profiles:'elligentt_aiw_profile_v1',
    stopPaused: 'elligentt_aiw_stop_paused_v1',
    usedNonces: 'elligentt_aiw_used_nonces_v1',
    nonce:      'elligentt_aiw_nonce_v1',
    estop:      'elligentt_aiw_estop_v1',
    mode:       'elligentt_aiw_mode_v1'
  };

  function _load(key, def) {
    try {
      var raw = localStorage.getItem(key);
      return raw === null ? def : JSON.parse(raw);
    } catch (_e) { return def; }
  }

  function _save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (_e) {}
  }

  /** Get any stored value by logical name */
  function get(name, def) {
    var key = K[name] || name;
    return _load(key, def);
  }

  /** Set any stored value by logical name */
  function set(name, val) {
    var key = K[name] || name;
    return _save(key, val);
  }

  /** Remove by logical name */
  function remove(name) {
    try { localStorage.removeItem(K[name] || name); } catch (_e) {}
  }

  /** Get intents */
  function getIntents() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.getIntents) return AIWallet.getIntents(); } catch (_e) {}
    return get('intents', []);
  }

  /** Get history */
  function getHistory() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.getHistory) return AIWallet.getHistory(); } catch (_e) {}
    return get('history', []);
  }

  /** Get workflows */
  function getWorkflows() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.getWorkflows) return AIWallet.getWorkflows(); } catch (_e) {}
    return get('workflows', []);
  }

  /** Get vault allocations */
  function getVault() {
    return get('vault', { USDC: { locked: 0, automation: 0, treasury: 0 }, EURC: { locked: 0, automation: 0, treasury: 0 }, cirBTC: { locked: 0, automation: 0, treasury: 0 } });
  }

  /** GetAllKeys */
  function getAllKeys() { return Object.keys(K); }

  /** Export all stored data (for backup) */
  function exportAll() {
    var result = {};
    var keys = Object.keys(K);
    for (var i = 0; i < keys.length; i++) { result[keys[i]] = get(keys[i], null); }
    return { version: VERSION, exportedAt: new Date().toISOString(), data: result };
  }

  /** Import all stored data (for restore) */
  function importAll(data) {
    if (!data || !data.data) return false;
    var keys = Object.keys(data.data);
    for (var i = 0; i < keys.length; i++) { set(keys[i], data.data[keys[i]]); }
    return true;
  }

  function clear() {
    var keys = Object.keys(K);
    for (var i = 0; i < keys.length; i++) { remove(keys[i]); }
  }

  window.AIWStorageEngine = {
    VERSION: VERSION,
    get: get, set: set, remove: remove,
    getIntents: getIntents, getHistory: getHistory, getWorkflows: getWorkflows,
    getVault: getVault, getAllKeys: getAllKeys,
    exportAll: exportAll, importAll: importAll, clear: clear
  };
})();
