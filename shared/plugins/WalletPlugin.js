/**
 * WalletPlugin — Wallet Connection Feature Plugin (Phase 5)
 * Attached to: window.WalletPlugin
 */
(function () {
  'use strict';

  var plugin = {
    id: 'wallet',
    version: '1.0.0',
    dependencies: ['eventBus', 'rpc'],

    initialize: function () {
      try { if (typeof WalletDomain !== 'undefined') WalletDomain.initialize(); } catch (_e) {}
    },

    start: function () {
      try { if (typeof CapabilityRegistry !== 'undefined') {
        CapabilityRegistry.registerCapability('wallet.connect', 'wallet', 'Connect external wallet');
        CapabilityRegistry.registerCapability('wallet.balance', 'wallet', 'Fetch on-chain balance');
        CapabilityRegistry.registerCapability('wallet.switchChain', 'wallet', 'Switch blockchain network');
      }} catch (_e) {}
    },

    stop: function () {
      try { if (typeof WalletDomain !== 'undefined') WalletDomain.destroy(); } catch (_e) {}
    },

    destroy: function () {},

    health: function () {
      return { connected: typeof walletAddress !== 'undefined' && !!walletAddress };
    },

    diagnostics: function () {
      return { walletType: typeof activeWalletType !== 'undefined' ? activeWalletType : null, chainId: typeof activeChainId !== 'undefined' ? activeChainId : 5042002 };
    },

    capabilities: function () {
      return ['wallet.connect', 'wallet.balance', 'wallet.switchChain'];
    }
  };

  window.WalletPlugin = plugin;
})();
