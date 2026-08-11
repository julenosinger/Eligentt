/**
 * WalletDomain — Wallet state & connection orchestration (Phase 3)
 * Wraps existing wallet functions. Never duplicates logic.
 * Attached to: window.WalletDomain
 */
(function () {
  'use strict';
  var _init = false, _subs = [];

  function initialize() {
    if (_init) return; _init = true;
    if (typeof EventBus !== 'undefined') {
      _subs.push(EventBus.on('CHAIN_CHANGED', _onChainChanged));
    }
  }
  function _onChainChanged() { refresh(); }

  function connect(walletType) {
    try {
      if (typeof WalletService !== 'undefined' && WalletService.connect) return WalletService.connect(walletType);
      if (typeof connectWalletConnect === 'function') return connectWalletConnect();
      if (typeof connectWallet === 'function') return connectWallet();
    } catch (e) {
      try { if (typeof ErrorHandler !== 'undefined') ErrorHandler.handle(e, { source: 'wallet', operation: 'connect' }); } catch (_e) {}
      throw e;
    }
  }

  function disconnect() {
    try {
      if (typeof WalletService !== 'undefined' && WalletService.disconnect) return WalletService.disconnect();
      if (typeof disconnectWallet === 'function') return disconnectWallet();
    } catch (e) {}
  }

  function getAddress() {
    try { return typeof walletAddress !== 'undefined' ? walletAddress : null; } catch (_e) { return null; }
  }

  function getChainId() {
    try { return typeof activeChainId !== 'undefined' ? activeChainId : 5042002; } catch (_e) { return 5042002; }
  }

  function isConnected() { return getAddress() !== null; }

  async function refreshBalance() {
    try { if (typeof refreshBalance === 'function') return await refreshBalance(); } catch (_e) {}
    return null;
  }

  async function switchChain(chainId) {
    try {
      if (typeof WalletService !== 'undefined' && WalletService.switchChain) return await WalletService.switchChain(chainId);
      if (typeof switchNetwork === 'function') { await switchNetwork(chainId); return true; }
    } catch (e) { return false; }
  }

  function refresh() {
    try { if (typeof updateWalletBadges === 'function') updateWalletBadges(); } catch (_e) {}
  }

  function destroy() { _subs.forEach(function (s) { try { s.off(); } catch (_e) {} }); _subs = []; _init = false; }

  window.WalletDomain = {
    VERSION: '1.0.0',
    initialize: initialize, connect: connect, disconnect: disconnect,
    getAddress: getAddress, getChainId: getChainId, isConnected: isConnected,
    refreshBalance: refreshBalance, switchChain: switchChain, refresh: refresh, destroy: destroy
  };
})();
