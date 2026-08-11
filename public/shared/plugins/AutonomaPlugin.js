/**
 * AutonomaPlugin — AI Agent Feature Plugin (Phase 5)
 * Attached to: window.AutonomaPlugin
 */
(function () {
  'use strict';

  var plugin = {
    id: 'autonoma',
    version: '1.0.0',
    dependencies: ['wallet', 'eventBus', 'aiwallet'],

    initialize: function () {
      try { if (typeof AutonomaAdapter !== 'undefined') AutonomaAdapter.initialize(); } catch (_e) {}
      try { if (typeof AutonomaCoreV2 !== 'undefined') AutonomaCoreV2.initialize(); } catch (_e2) {}
    },

    start: function () {
      try { if (typeof CapabilityRegistry !== 'undefined') {
        CapabilityRegistry.registerCapability('autonoma.ask', 'autonoma', 'Process natural language request');
        CapabilityRegistry.registerCapability('autonoma.plan', 'autonoma', 'Plan without executing');
        CapabilityRegistry.registerCapability('autonoma.execute', 'autonoma', 'Execute goal via AI Wallet');
      }} catch (_e) {}
    },

    stop: function () {
      try { if (typeof AutonomaCoreV2 !== 'undefined') AutonomaCoreV2.destroy(); } catch (_e) {}
    },

    destroy: function () {},

    health: function () {
      return { available: typeof AutonomaCore !== 'undefined', active: typeof AutonomaCore !== 'undefined' && AutonomaCore.goalActive ? AutonomaCore.goalActive() : false };
    },

    diagnostics: function () {
      return { nluAvailable: typeof AutonomaNLU !== 'undefined', agentAvailable: typeof AutonomaAgent !== 'undefined' };
    },

    capabilities: function () {
      return ['autonoma.ask', 'autonoma.plan', 'autonoma.execute'];
    }
  };

  window.AutonomaPlugin = plugin;
})();
