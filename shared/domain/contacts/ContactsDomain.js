/**
 * ContactsDomain — Contact CRUD & management (Phase 3)
 * Wraps existing contacts global + renderContacts. Never duplicates logic.
 * Attached to: window.ContactsDomain
 */
(function () {
  'use strict';
  var _init = false;

  function initialize() { if (_init) return; _init = true; }

  function getAll() {
    try { if (typeof contacts !== 'undefined') return contacts.slice(); } catch (_e) {}
    return [];
  }

  function getById(id) {
    try { return (typeof contacts !== 'undefined' ? contacts.find(function (c) { return c.id === id; }) : null); } catch (_e) { return null; }
  }

  function add(name, addr, chainId, note) {
    try {
      if (typeof contacts !== 'undefined') {
        var id = 'C' + Date.now();
        contacts.push({ id: id, name: name, addr: addr, chainId: chainId || 'Arc_Testnet', note: note || '', favorite: false, lastUsed: new Date().toISOString() });
        if (typeof Store !== 'undefined' && Store.save) Store.save('contacts', contacts);
        refresh();
        return id;
      }
    } catch (_e) {}
    return null;
  }

  function remove(id) {
    try {
      if (typeof contacts !== 'undefined') {
        contacts = contacts.filter(function (c) { return c.id !== id; });
        if (typeof Store !== 'undefined' && Store.save) Store.save('contacts', contacts);
        refresh();
        return true;
      }
    } catch (_e) {}
    return false;
  }

  function toggleFavorite(id) {
    try {
      if (typeof contacts !== 'undefined') {
        var c = contacts.find(function (x) { return x.id === id; });
        if (c) { c.favorite = !c.favorite; if (typeof Store !== 'undefined' && Store.save) Store.save('contacts', contacts); refresh(); return true; }
      }
    } catch (_e) {}
    return false;
  }

  function search(query) {
    var all = getAll();
    if (!query) return all;
    var q = query.toLowerCase();
    return all.filter(function (c) {
      return (c.name || '').toLowerCase().indexOf(q) !== -1 || (c.addr || '').toLowerCase().indexOf(q) !== -1;
    });
  }

  function update(id, patch) {
    try {
      if (typeof contacts !== 'undefined') {
        var c = contacts.find(function (x) { return x.id === id; });
        if (c) { Object.assign(c, patch); if (typeof Store !== 'undefined' && Store.save) Store.save('contacts', contacts); refresh(); return true; }
      }
    } catch (_e) {}
    return false;
  }

  function importFromCSV(file) {
    try { if (typeof importContactCSV === 'function') { importContactCSV({ files: [file] }); return true; } } catch (_e) {}
    return false;
  }

  function exportToCSV() {
    try { if (typeof exportContactsCSV === 'function') { exportContactsCSV(); return true; } } catch (_e) {}
    return false;
  }

  function refresh() {
    try { if (typeof renderContacts === 'function') renderContacts(); } catch (_e) {}
    try { if (typeof updateSelectedCount === 'function') updateSelectedCount(); } catch (_e2) {}
  }

  function destroy() { _init = false; }

  window.ContactsDomain = {
    VERSION: '1.0.0',
    initialize: initialize, getAll: getAll, getById: getById, add: add, remove: remove,
    toggleFavorite: toggleFavorite, search: search, update: update,
    importFromCSV: importFromCSV, exportToCSV: exportToCSV, refresh: refresh, destroy: destroy
  };
})();
