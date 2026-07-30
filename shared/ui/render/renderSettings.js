/**
 * SettingsRenderer — Settings UI wrapper (Phase 2)
 * Attached to: window.SettingsRenderer
 */
(function () {
  'use strict';
  var _init = false, _subs = [];

  function initialize() {
    if (_init) return; _init = true;
    if (typeof EventBus !== 'undefined') {
      _subs.push(EventBus.on('PAGE_CHANGED', function (p) { if (p && p.page === 'settings') render(); }));
    }
  }
  function render() {
    try {
      if (typeof SettingsStore !== 'undefined') {
        var s = SettingsStore.getSnapshot();
        // Sync common settings UI elements if they exist
        var autoBridge = document.getElementById('tgl-auto-bridge');
        if (autoBridge && s.autoBridge !== undefined) {
          if (s.autoBridge) { autoBridge.classList.add('on'); } else { autoBridge.classList.remove('on'); }
        }
      }
    } catch (_e) {}
  }
  function refresh() { render(); }
  function destroy() { _subs.forEach(function (s) { try { s.off(); } catch (_e) {} }); _subs = []; _init = false; }

  window.SettingsRenderer = { VERSION: '1.0.0', initialize: initialize, render: render, refresh: refresh, destroy: destroy };
})();
