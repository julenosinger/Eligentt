/**
 * WalletPage — Extracted Wallet Feature Module (Phase 14.3)
 * Migrates: connect, disconnect, refreshBalance, switchNetwork.
 * Attached to: window.WalletPage
 */
(function () {
  'use strict';
  var _init = false, _subs = [];

  function initialize() {
    if (_init) return; _init = true;
    try {
      if (typeof EventBus !== 'undefined') {
        _subs.push(EventBus.on('WALLET_CONNECTED', function () { render(); }));
        _subs.push(EventBus.on('WALLET_DISCONNECTED', function () { render(); }));
        _subs.push(EventBus.on('CHAIN_CHANGED', function () { render(); }));
        _subs.push(EventBus.on('BALANCE_REFRESHED', function () { render(); }));
      }
    } catch (_e) {}
  }

  function render() {
    try { if (typeof updateWalletBadges === 'function') updateWalletBadges(); } catch (_e) {}
    try { if (typeof updateNetworkBadge === 'function' && typeof activeChainId !== 'undefined') updateNetworkBadge(activeChainId); } catch (_e2) {}
  }

  function connect(walletType) {
    try { if (typeof CoreMigrate !== 'undefined') return CoreMigrate.wallet_connect(walletType); } catch (_e) {}
    try { if (typeof WalletDomain !== 'undefined') return WalletDomain.connect(walletType); } catch (_e2) {}
    try { if (typeof connectWalletConnect === 'function') return connectWalletConnect(); } catch (_e3) {}
    return null;
  }

  function disconnect() {
    try { if (typeof CoreMigrate !== 'undefined') CoreMigrate.wallet_disconnect(); } catch (_e) {}
    try { if (typeof WalletDomain !== 'undefined') WalletDomain.disconnect(); } catch (_e2) {}
    try { if (typeof disconnectWallet === 'function') disconnectWallet(); } catch (_e3) {}
  }

  function refreshBalance() {
    try { if (typeof CoreMigrate !== 'undefined') CoreMigrate.wallet_refreshBalance(); } catch (_e) {}
    try { if (typeof WalletDomain !== 'undefined') WalletDomain.refreshBalance(); } catch (_e2) {}
    try { if (typeof refreshBalance === 'function') refreshBalance(); } catch (_e3) {}
  }

  function switchChain(chainId) {
    try { if (typeof CoreMigrate !== 'undefined') return CoreMigrate.wallet_switchChain(chainId); } catch (_e) {}
    return false;
  }

  function destroy() { _subs.forEach(function (s) { try { s.off(); } catch (_e) {} }); _subs = []; _init = false; }

  window.WalletPage = { VERSION: '14.0.0', initialize: initialize, render: render, connect: connect, disconnect: disconnect, refreshBalance: refreshBalance, switchChain: switchChain, destroy: destroy };
})();
