/**
 * Autonoma MemoryEngine — Conversation & Financial Memory (Phase 4)
 * Wraps Autonoma memory + AutonomaFinancialMemory.
 * Attached to: window.AutMemoryEngine
 */
(function () {
  'use strict';
  var _init = false;

  function initialize() { if (_init) return; _init = true; }

  function getConversationHistory(limit) {
    try {
      if (typeof AutonomaCore !== 'undefined') {
        // Access internal memory; fallback gracefully
        var mem = typeof localStorage !== 'undefined' ? localStorage.getItem('elligentt_core_memory_v1') : null;
        if (mem) { var parsed = JSON.parse(mem); return (parsed.history || []).slice(0, limit || 20); }
      }
    } catch (_e) {}
    return [];
  }

  function getLastInteraction() {
    try {
      if (typeof AutonomaCore !== 'undefined') {
        var mem = typeof localStorage !== 'undefined' ? localStorage.getItem('elligentt_core_memory_v1') : null;
        if (mem) { var parsed = JSON.parse(mem); return parsed.lastInteraction || 0; }
      }
    } catch (_e) {}
    return 0;
  }

  function getPreferences() {
    try { if (typeof AutonomaCore !== 'undefined' && AutonomaCore.getPreferences) return AutonomaCore.getPreferences(); } catch (_e) {}
    return {};
  }

  function clearConversation() {
    try { if (typeof AutonomaCore !== 'undefined' && AutonomaCore.resetGoal) AutonomaCore.resetGoal(); } catch (_e) {}
  }

  function refresh() {}
  function destroy() { _init = false; }

  window.AutMemoryEngine = {
    VERSION: '1.0.0',
    initialize: initialize, getConversationHistory: getConversationHistory,
    getLastInteraction: getLastInteraction, getPreferences: getPreferences,
    clearConversation: clearConversation, refresh: refresh, destroy: destroy
  };
})();
