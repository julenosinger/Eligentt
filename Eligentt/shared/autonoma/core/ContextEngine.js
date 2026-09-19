/**
 * Autonoma ContextEngine — World State & Context (Phase 4)
 * Wraps AutonomaCore.getWorldState + FinancialContext.
 * Attached to: window.AutContextEngine
 */
(function () {
  'use strict';
  var _init = false;

  function initialize() { if (_init) return; _init = true; }

  function getWorldState() {
    try { if (typeof AutonomaCore !== 'undefined' && AutonomaCore.getWorldState) return AutonomaCore.getWorldState(); } catch (_e) {}
    return { wallet: null, chain: 'unknown', balances: {} };
  }

  function getCurrentGoal() {
    try { if (typeof AutonomaCore !== 'undefined' && AutonomaCore.getGoal) return AutonomaCore.getGoal(); } catch (_e) {}
    return null;
  }

  function isGoalActive() {
    try { if (typeof AutonomaCore !== 'undefined' && AutonomaCore.goalActive) return AutonomaCore.goalActive(); } catch (_e) {}
    return false;
  }

  function resetContext() {
    try { if (typeof AutonomaCore !== 'undefined' && AutonomaCore.resetGoal) AutonomaCore.resetGoal(); } catch (_e) {}
  }

  function getPreferences() {
    try { if (typeof AutonomaCore !== 'undefined' && AutonomaCore.getPreferences) return AutonomaCore.getPreferences(); } catch (_e) {}
    return {};
  }

  /** Get financial context snapshot */
  function getFinancialContext() {
    try {
      if (typeof FinancialContext !== 'undefined' && FinancialContext.getSnapshot) return FinancialContext.getSnapshot();
    } catch (_e) {}
    return null;
  }

  function refresh() {}
  function destroy() { _init = false; }

  window.AutContextEngine = {
    VERSION: '1.0.0',
    initialize: initialize, getWorldState: getWorldState, getCurrentGoal: getCurrentGoal,
    isGoalActive: isGoalActive, resetContext: resetContext, getPreferences: getPreferences,
    getFinancialContext: getFinancialContext, refresh: refresh, destroy: destroy
  };
})();
