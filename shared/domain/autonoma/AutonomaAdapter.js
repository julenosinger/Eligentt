/**
 * AutonomaAdapter — Stable public API for Autonoma (Phase 3)
 * NEVER exposes internal Autonoma modules to the UI. Only this adapter.
 * Wraps AutonomaCore, AutonomaNLU, AutonomaAgent. Never duplicates logic.
 * Attached to: window.AutonomaAdapter
 */
(function () {
  'use strict';
  var _init = false;

  function initialize() { if (_init) return; _init = true; }

  /** Process a user message through Autonoma. Returns intent or response. */
  function processMessage(msg, callbacks) {
    try {
      if (typeof AutonomaCore !== 'undefined' && AutonomaCore.process) {
        return AutonomaCore.process(msg, callbacks);
      }
    } catch (e) {
      try { if (typeof ErrorHandler !== 'undefined') ErrorHandler.handle(e, { source: 'autonoma', operation: 'process' }); } catch (_e) {}
    }
    return { type: 'fallback', msg: msg };
  }

  /** Decompose message into structured entities. */
  function decomposeMessage(msg) {
    try {
      if (typeof AutonomaNLU !== 'undefined') {
        return AutonomaNLU.decompose(msg);
      }
    } catch (_e) {}
    return null;
  }

  /** Get the current conversation goal. */
  function getCurrentGoal() {
    try {
      if (typeof AutonomaCore !== 'undefined' && AutonomaCore.getGoal) return AutonomaCore.getGoal();
    } catch (_e) {}
    return null;
  }

  /** Reset conversation context. */
  function resetContext() {
    try {
      if (typeof AutonomaCore !== 'undefined' && AutonomaCore.resetGoal) AutonomaCore.resetGoal();
    } catch (_e) {}
  }

  /** Get world state snapshot. */
  function getWorldState() {
    try {
      if (typeof AutonomaCore !== 'undefined' && AutonomaCore.getWorldState) return AutonomaCore.getWorldState();
    } catch (_e) {}
    return null;
  }

  /** Get agency identity card HTML */
  function getIdentityCard() {
    try {
      if (typeof AutonomaAgent !== 'undefined' && AutonomaAgent.getAgentIdentityCard) return AutonomaAgent.getAgentIdentityCard();
    } catch (_e) {}
    return '';
  }

  /** Get authorization card HTML */
  function getAuthorizationCard() {
    try {
      if (typeof AutonomaAgent !== 'undefined' && AutonomaAgent.getAgentAuthorizationCard) return AutonomaAgent.getAgentAuthorizationCard();
    } catch (_e) {}
    return '';
  }

  /** Get user preferences learned by Autonoma */
  function getPreferences() {
    try {
      if (typeof AutonomaCore !== 'undefined' && AutonomaCore.getPreferences) return AutonomaCore.getPreferences();
    } catch (_e) {}
    return {};
  }

  /** Check for proactive alerts via AutonomaAgent */
  function checkAlerts() {
    try {
      if (typeof AutonomaAgent !== 'undefined' && AutonomaAgent.checkAlerts) return AutonomaAgent.checkAlerts();
    } catch (_e) {}
    return [];
  }

  function refresh() {}
  function destroy() { _init = false; }

  window.AutonomaAdapter = {
    VERSION: '1.0.0',
    initialize: initialize, processMessage: processMessage, decomposeMessage: decomposeMessage,
    getCurrentGoal: getCurrentGoal, resetContext: resetContext, getWorldState: getWorldState,
    getIdentityCard: getIdentityCard, getAuthorizationCard: getAuthorizationCard,
    getPreferences: getPreferences, checkAlerts: checkAlerts,
    refresh: refresh, destroy: destroy
  };
})();
