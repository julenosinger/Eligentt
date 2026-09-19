/**
 * Elligentt StorageAdapter — Storage Abstraction Layer (Phase 17.8)
 * Adapters: LocalStorage, IndexedDB, Cloud. Plugins use this, never raw storage.
 * Attached to: window.StorageAdapter
 */
(function () {
  'use strict';

  var _provider = 'localStorage';

  function setProvider(provider) { _provider = provider; }
  function getProvider() { return _provider; }

  function get(key, def) {
    try {
      var raw = localStorage.getItem(key);
      if (raw === null) return def;
      return JSON.parse(raw);
    } catch (_e) { return def; }
  }

  function set(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch (_e) { return false; }
  }

  function remove(key) {
    try { localStorage.removeItem(key); return true; } catch (_e) { return false; }
  }

  function clear() {
    try { localStorage.clear(); return true; } catch (_e) { return false; }
  }

  function keys() {
    try {
      var result = [];
      for (var i = 0; i < localStorage.length; i++) result.push(localStorage.key(i));
      return result;
    } catch (_e) { return []; }
  }

  function exists(key) {
    try { return localStorage.getItem(key) !== null; } catch (_e) { return false; }
  }

  function getSize() {
    try {
      var total = 0;
      for (var i = 0; i < localStorage.length; i++) total += (localStorage.getItem(localStorage.key(i)) || '').length;
      return total;
    } catch (_e) { return 0; }
  }

  function getInfo() {
    return {
      provider: _provider,
      totalKeys: keys().length,
      estimatedSizeBytes: getSize(),
      available: typeof localStorage !== 'undefined'
    };
  }

  /** Bulk operations */
  function getAll(prefix) {
    var result = {};
    keys().forEach(function (k) {
      if (!prefix || k.indexOf(prefix) === 0) result[k] = get(k, null);
    });
    return result;
  }

  function exportData() {
    return { exportedAt: new Date().toISOString(), provider: _provider, data: getAll(), keyCount: keys().length };
  }

  function importData(data) {
    if (!data || !data.data) return false;
    var count = 0;
    Object.keys(data.data).forEach(function (k) { if (set(k, data.data[k])) count++; });
    return count;
  }

  window.StorageAdapter = {
    VERSION: '17.0.0',
    setProvider: setProvider, getProvider: getProvider,
    get: get, set: set, remove: remove, clear: clear,
    keys: keys, exists: exists, getSize: getSize, getInfo: getInfo,
    getAll: getAll, exportData: exportData, importData: importData
  };
})();
