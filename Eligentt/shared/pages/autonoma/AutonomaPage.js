/**
 * AutonomaPage — Extracted Autonoma Chat Page Module (Phase 15)
 * Migrates: chat UI, upload, voice, suggestions.
 * Delegates reasoning to AutonomaAdapter. Never touches NLU directly.
 * Attached to: window.AutonomaPage
 */
(function () {
  'use strict';
  var _init = false, _subs = [];

  function initialize() {
    if (_init) return; _init = true;
    try {
      if (typeof EventBus !== 'undefined') {
        _subs.push(EventBus.on('PAGE_CHANGED', function (p) { if (p && p.page === 'autonoma') render(); }));
        _subs.push(EventBus.on('AUTONOMA_MESSAGE', function (p) { if (p && p.msg) processMessage(p.msg, p.callbacks); }));
        _subs.push(EventBus.on('AUTONOMA_UPLOAD', function (p) { if (p && p.file) handleUpload(p.file); }));
      }
      if (typeof TabManager !== 'undefined') TabManager.register('autonoma', { init: render });
    } catch (_e) {}
  }

  function render() {
    try { if (typeof autonomaInit === 'function') autonomaInit(); } catch (_e) {}
  }

  function processMessage(msg, callbacks) {
    try { if (typeof CoreMigrate !== 'undefined') return CoreMigrate.autonoma_ask(msg, callbacks); } catch (_e) {}
    try { if (typeof AutonomaCore !== 'undefined' && AutonomaCore.process) return AutonomaCore.process(msg, callbacks); } catch (_e2) {}
    return { type: 'fallback', msg: msg };
  }

  function handleUpload(file) {
    try { if (typeof autonomaHandleFile === 'function') autonomaHandleFile({ files: [file] }); } catch (_e) {}
  }

  function reset() {
    try { if (typeof CoreMigrate !== 'undefined') CoreMigrate.autonoma_reset(); } catch (_e) {}
    try { if (typeof AutonomaCore !== 'undefined' && AutonomaCore.resetGoal) AutonomaCore.resetGoal(); } catch (_e2) {}
  }

  function getContext() {
    try { if (typeof CoreMigrate !== 'undefined') return CoreMigrate.autonoma_context(); } catch (_e) {}
    return null;
  }

  function destroy() { _subs.forEach(function (s) { try { s.off(); } catch (_e) {} }); _subs = []; _init = false; }

  window.AutonomaPage = {
    VERSION: '15.0.0', initialize: initialize, render: render,
    processMessage: processMessage, handleUpload: handleUpload,
    reset: reset, getContext: getContext, destroy: destroy
  };
})();
