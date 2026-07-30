/**
 * AutonomaCore V2 — Modular AI Platform Orchestrator (Phase 4)
 *
 * Ties context, intent, memory engines together. No business implementation.
 * The original AutonomaCore/AutonomaNLU/AutonomaAgent remain fully functional.
 * This is an additive orchestrator layer.
 *
 * Attached to: window.AutonomaCoreV2
 *
 * @module autonomaCoreV2
 * @version 1.0.0
 */
(function () {
  'use strict';

  var _initialized = false;

  var _engines = [
    { name: 'context', api: 'AutContextEngine', mod: null },
    { name: 'intent',  api: 'AutIntentEngine',  mod: null },
    { name: 'memory',  api: 'AutMemoryEngine',  mod: null }
  ];

  /** Initialize all Autonoma engines */
  function initialize() {
    if (_initialized) return;
    _initialized = true;

    var ok = 0, failed = 0;
    for (var i = 0; i < _engines.length; i++) {
      var entry = _engines[i];
      try { entry.mod = typeof window[entry.api] !== 'undefined' ? window[entry.api] : null; } catch (_e) { entry.mod = null; }
      if (!entry.mod || typeof entry.mod.initialize !== 'function') { failed++; continue; }
      try { entry.mod.initialize(); ok++; } catch (e) { console.warn('[AutonomaCoreV2] Init failed: ' + entry.name, e.message); failed++; }
    }
    console.log('[AutonomaCoreV2] Initialized ' + ok + '/' + _engines.length + ' engines (' + failed + ' skipped)');
  }

  /** Process a user message through the full pipeline */
  function ask(msg, callbacks) {
    initialize();
    try {
      if (typeof AutIntentEngine !== 'undefined' && AutIntentEngine.process) return AutIntentEngine.process(msg, callbacks);
    } catch (e) {
      try { if (typeof ErrorHandler !== 'undefined') ErrorHandler.handle(e, { source: 'autonoma_v2', operation: 'ask' }); } catch (_e) {}
    }
    try { if (typeof AutonomaCore !== 'undefined' && AutonomaCore.process) return AutonomaCore.process(msg, callbacks); } catch (_e2) {}
    return { type: 'fallback', msg: msg };
  }

  /** Plan without executing */
  function plan(msg) {
    try {
      var intent = typeof AutIntentEngine !== 'undefined' && AutIntentEngine.understand ? AutIntentEngine.understand(msg) : null;
      var goal = typeof AutIntentEngine !== 'undefined' && AutIntentEngine.goalToIntent ? AutIntentEngine.goalToIntent(msg) : null;
      return { intents: intent, goal: goal, context: context() };
    } catch (_e) { return { intents: [], goal: null, context: null }; }
  }

  /** Execute a goal via AI Wallet */
  function execute(goal, params) {
    try {
      var intent = typeof AutIntentEngine !== 'undefined' && AutIntentEngine.goalToIntent ? AutIntentEngine.goalToIntent(goal) : null;
      if (intent && typeof AIWalletAdapter !== 'undefined') {
        return AIWalletAdapter.submitIntent(Object.assign({}, params, { op: goal }));
      }
    } catch (e) {
      try { if (typeof ErrorHandler !== 'undefined') ErrorHandler.handle(e, { source: 'autonoma_v2', operation: 'execute' }); } catch (_e) {}
    }
    return null;
  }

  /** Get current context */
  function context() {
    try {
      if (typeof AutContextEngine !== 'undefined' && AutContextEngine.getWorldState) return AutContextEngine.getWorldState();
    } catch (_e) {}
    return null;
  }

  /** Get conversation memory */
  function memory(limit) {
    try {
      if (typeof AutMemoryEngine !== 'undefined' && AutMemoryEngine.getConversationHistory) return AutMemoryEngine.getConversationHistory(limit);
    } catch (_e) {}
    return [];
  }

  /** Reset all context */
  function reset() {
    try { if (typeof AutContextEngine !== 'undefined' && AutContextEngine.resetContext) AutContextEngine.resetContext(); } catch (_e) {}
    try { if (typeof AutMemoryEngine !== 'undefined' && AutMemoryEngine.clearConversation) AutMemoryEngine.clearConversation(); } catch (_e2) {}
  }

  function refreshAll() {
    for (var i = 0; i < _engines.length; i++) {
      var mod = _engines[i].mod;
      if (!mod || typeof mod.refresh !== 'function') continue;
      try { mod.refresh(); } catch (_e) {}
    }
  }

  function destroy() {
    for (var i = _engines.length - 1; i >= 0; i--) {
      var mod = _engines[i].mod;
      if (!mod || typeof mod.destroy !== 'function') continue;
      try { mod.destroy(); } catch (_e) {}
      _engines[i].mod = null;
    }
    _initialized = false;
  }

  function getReport() {
    return _engines.map(function (e) { return { name: e.name, ready: !!e.mod }; });
  }

  try {
    if (typeof EventBus !== 'undefined' && EventBus.on) {
      EventBus.on('APP_BOOT_COMPLETE', function () { initialize(); });
    }
  } catch (_e) {}

  /** @public */
  window.AutonomaCoreV2 = {
    VERSION: '1.0.0',
    initialize: initialize, ask: ask, plan: plan, execute: execute,
    context: context, memory: memory, reset: reset,
    refreshAll: refreshAll, destroy: destroy, getReport: getReport
  };
})();
