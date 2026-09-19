/**
 * RecipientRegistry — Global Contact Directory
 * SURGICAL. Read-only helper over EXISTING contacts storage.
 * ZERO duplication. ZERO migration. ZERO breaking changes.
 * Attached to window.RecipientRegistry
 */
(function () {
  'use strict';

  var _cache = [];
  var _byAddr = {};
  var _byName = {};
  var _loaded = false;

  function _contacts() {
    try {
      if (typeof window.contacts !== 'undefined' && Array.isArray(window.contacts)) return window.contacts;
      if (typeof contacts !== 'undefined' && Array.isArray(contacts)) return contacts;
      var raw = localStorage.getItem('arcpay_contacts');
      return raw ? JSON.parse(raw) : [];
    } catch (_e) { return []; }
  }

  function refresh() {
    _cache = _contacts();
    _byAddr = {};
    _byName = {};
    for (var i = 0; i < _cache.length; i++) {
      var c = _cache[i];
      if (c.addr) _byAddr[c.addr.toLowerCase()] = c;
      if (c.name) _byName[c.name.toLowerCase()] = c;
    }
    _loaded = true;
  }

  refresh();

  function list() {
    if (!_loaded) refresh();
    return _cache.slice();
  }

  function get(id) {
    for (var i = 0; i < _cache.length; i++) { if (_cache[i].id === id) return _cache[i]; }
    return null;
  }

  function findByAddress(addr) {
    if (!addr) return null;
    if (!_loaded) refresh();
    return _byAddr[addr.toLowerCase()] || null;
  }

  function findByName(name) {
    if (!name) return null;
    if (!_loaded) refresh();
    return _byName[name.toLowerCase()] || null;
  }

  function search(text) {
    if (!text) return [];
    if (!_loaded) refresh();
    var q = text.toLowerCase();
    var results = [];
    for (var i = 0; i < _cache.length; i++) {
      var c = _cache[i];
      if (c.name.toLowerCase().indexOf(q) !== -1 || (c.addr && c.addr.toLowerCase().indexOf(q) !== -1) || (c.note && c.note.toLowerCase().indexOf(q) !== -1)) {
        results.push(c);
      }
    }
    return results;
  }

  function getFavorites() {
    if (!_loaded) refresh();
    var favs = [];
    for (var i = 0; i < _cache.length; i++) { if (_cache[i].favorite) favs.push(_cache[i]); }
    return favs;
  }

  function displayName(addr) {
    if (!addr) return '';
    if (!_loaded) refresh();
    var c = _byAddr[addr.toLowerCase()];
    return c ? c.name : addr;
  }

  function resolveDestination(addr, defaultName) {
    if (!addr) return { name: defaultName || '', addr: '' };
    if (!_loaded) refresh();
    var c = _byAddr[addr.toLowerCase()];
    return c ? { name: c.name, addr: c.addr, chainId: c.chainId } : { name: defaultName || addr, addr: addr, chainId: '' };
  }

  function autocomplete(query, maxResults) {
    if (!query) return getFavorites().slice(0, maxResults || 10);
    var results = search(query);
    return results.slice(0, maxResults || 10);
  }

  window.RecipientRegistry = {
    list: list,
    get: get,
    findByAddress: findByAddress,
    findByName: findByName,
    search: search,
    getFavorites: getFavorites,
    displayName: displayName,
    resolveDestination: resolveDestination,
    autocomplete: autocomplete,
    refresh: refresh
  };
})();
