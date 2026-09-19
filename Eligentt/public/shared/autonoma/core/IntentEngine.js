/**
 * Autonoma IntentEngine — Goal-to-Intent Routing (Phase 4)
 * Wraps AutonomaCore.process + goalToIntent.
 * Attached to: window.AutIntentEngine
 */
(function () {
  'use strict';
  var _init = false;

  function initialize() { if (_init) return; _init = true; }

  /** Process a user message through the full pipeline */
  function process(msg, callbacks) {
    try {
      if (typeof AutonomaCore !== 'undefined' && AutonomaCore.process) return AutonomaCore.process(msg, callbacks);
    } catch (e) {
      try { if (typeof ErrorHandler !== 'undefined') ErrorHandler.handle(e, { source: 'autonoma.intent', operation: 'process' }); } catch (_e) {}
    }
    return { type: 'fallback', msg: msg };
  }

  /** Map a goal to an intent type */
  function goalToIntent(goal) {
    try {
      if (typeof AutonomaCore !== 'undefined' && AutonomaCore.goalToIntent) return AutonomaCore.goalToIntent(goal);
    } catch (_e) {}
    return 'DEFAULT';
  }

  /** NLU understanding without reasoning */
  function understand(msg) {
    try { if (typeof AutonomaCore !== 'undefined' && AutonomaCore.understand) return AutonomaCore.understand(msg); } catch (_e) {}
    return [];
  }

  /** Extract parameters from message */
  function extractParams(msg, goal) {
    try { if (typeof AutonomaCore !== 'undefined' && AutonomaCore.extractParams) return AutonomaCore.extractParams(msg, goal); } catch (_e) {}
    return {};
  }

  /** Calculate confidence score */
  function calculateConfidence(scores, params, goal) {
    try { if (typeof AutonomaCore !== 'undefined' && AutonomaCore.calculateConfidence) return AutonomaCore.calculateConfidence(scores, params, goal); } catch (_e) {}
    return 0;
  }

  /** Decompose message via NLU */
  function decompose(msg) {
    try { if (typeof AutonomaNLU !== 'undefined') return AutonomaNLU.decompose(msg); } catch (_e) {}
    return null;
  }

  function refresh() {}
  function destroy() { _init = false; }

  window.AutIntentEngine = {
    VERSION: '1.0.0',
    initialize: initialize, process: process, goalToIntent: goalToIntent,
    understand: understand, extractParams: extractParams,
    calculateConfidence: calculateConfidence, decompose: decompose,
    refresh: refresh, destroy: destroy
  };
})();
