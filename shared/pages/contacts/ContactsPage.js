/**
 * ContactsPage — Extracted Contacts Feature Module (Phase 14.1)
 * Migrates: renderContacts, contact search, CRUD rendering.
 * Attached to: window.ContactsPage
 */
(function () {
  'use strict';
  var _init = false, _subs = [];

  function initialize() {
    if (_init) return; _init = true;
    try {
      if (typeof EventBus !== 'undefined') {
        _subs.push(EventBus.on('PAGE_CHANGED', function (p) { if (p && p.page === 'recipients') render(); }));
        _subs.push(EventBus.on('CONTACTS_UPDATED', function () { render(); }));
      }
      if (typeof TabManager !== 'undefined') TabManager.register('recipients', { init: render });
    } catch (_e) {}
  }

  function render() {
    try { if (typeof ContactsDomain !== 'undefined') ContactsDomain.refresh(); else if (typeof renderContacts === 'function') renderContacts(); } catch (_e) {}
    try { if (typeof updateSelectedCount === 'function') updateSelectedCount(); } catch (_e2) {}
  }

  function refresh() {
    try { if (typeof ContactsDomain !== 'undefined') ContactsDomain.refresh(); } catch (_e) {}
    render();
  }

  function search(query) {
    try { if (typeof ContactsDomain !== 'undefined') return ContactsDomain.search(query); } catch (_e) {}
    return [];
  }

  function add(name, addr, chainId) {
    try { if (typeof ContactsDomain !== 'undefined') return ContactsDomain.add(name, addr, chainId); } catch (_e) {}
    return null;
  }

  function remove(id) {
    try { if (typeof ContactsDomain !== 'undefined') return ContactsDomain.remove(id); } catch (_e) {}
    return false;
  }

  function destroy() { _subs.forEach(function (s) { try { s.off(); } catch (_e) {} }); _subs = []; _init = false; }

  window.ContactsPage = { VERSION: '14.0.0', initialize: initialize, render: render, refresh: refresh, search: search, add: add, remove: remove, destroy: destroy };
})();
