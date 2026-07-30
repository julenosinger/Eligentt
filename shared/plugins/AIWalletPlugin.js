/**
 * AIWalletPlugin — AI Smart Wallet Feature Plugin (Phase 5)
 * Attached to: window.AIWalletPlugin
 */
(function () {
  'use strict';

  var plugin = {
    id: 'aiwallet',
    version: '1.0.0',
    dependencies: ['wallet', 'rpc', 'eventBus'],

    initialize: function () {
      try { if (typeof AIWalletAdapter !== 'undefined') AIWalletAdapter.initialize(); } catch (_e) {}
      try { if (typeof AIWalletCore !== 'undefined') AIWalletCore.initialize(); } catch (_e2) {}
    },

    start: function () {
      try { if (typeof CapabilityRegistry !== 'undefined') {
        CapabilityRegistry.registerCapability('aiwallet.validate', 'aiwallet', '13-stage intent validation');
        CapabilityRegistry.registerCapability('aiwallet.execute', 'aiwallet', 'Execute validated intent via Agent Wallet');
        CapabilityRegistry.registerCapability('aiwallet.simulate', 'aiwallet', 'Dry-run simulation');
        CapabilityRegistry.registerCapability('aiwallet.approve', 'aiwallet', 'Approve/reject intents');
      }} catch (_e) {}
    },

    stop: function () {
      try { if (typeof AIWalletCore !== 'undefined') AIWalletCore.destroy(); } catch (_e) {}
    },

    destroy: function () {},

    health: function () {
      return {
        mode: typeof AIWallet !== 'undefined' && AIWallet.getMode ? AIWallet.getMode() : 'hybrid',
        emergencyStop: typeof AIWallet !== 'undefined' && AIWallet.isEmergencyStopped ? AIWallet.isEmergencyStopped() : false
      };
    },

    diagnostics: function () {
      try {
        if (typeof AIWExecutionEngine !== 'undefined') return AIWExecutionEngine.getMetrics();
      } catch (_e) {}
      return {};
    },

    capabilities: function () {
      return ['aiwallet.validate', 'aiwallet.execute', 'aiwallet.simulate', 'aiwallet.approve'];
    }
  };

  window.AIWalletPlugin = plugin;
})();
