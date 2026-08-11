/**
 * TreasuryPlugin — Treasury & Vault Feature Plugin (Phase 5)
 * Attached to: window.TreasuryPlugin
 */
(function () {
  'use strict';
  var plugin = {
    id: 'treasury', version: '1.0.0', dependencies: ['wallet', 'rpc', 'eventBus'],
    initialize: function () { try { if (typeof TreasuryDomain !== 'undefined') TreasuryDomain.initialize(); } catch (_e) {} },
    start: function () {
      try { if (typeof CapabilityRegistry !== 'undefined') { CapabilityRegistry.registerCapability('treasury.allocate', 'treasury', 'Allocate vault funds'); CapabilityRegistry.registerCapability('treasury.vaultBalance', 'treasury', 'Get vault balances'); }} catch (_e) {}
    },
    stop: function () { try { if (typeof TreasuryDomain !== 'undefined') TreasuryDomain.destroy(); } catch (_e) {} },
    destroy: function () {},
    health: function () { return { available: typeof TreasuryDomain !== 'undefined' }; },
    diagnostics: function () { return {}; },
    capabilities: function () { return ['treasury.allocate', 'treasury.vaultBalance']; }
  };
  window.TreasuryPlugin = plugin;
})();
