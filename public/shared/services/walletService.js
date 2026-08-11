/**
 * Elligentt WalletService — Centralized Wallet Connection Service (Phase 1 Architecture)
 *
 * Wraps existing wallet connection logic. Does NOT replace it — provides
 * a structured API for new code and centralizes wallet events.
 *
 * Delegates to existing connectWallet(), disconnectWallet(), refreshBalance(),
 * switchNetwork() functions. Adds EventBus emission and WalletStore sync.
 *
 * Attached to: window.WalletService
 *
 * @module walletService
 * @version 1.0.0
 */
(function () {
  'use strict';

  /* ════════════════════════════════════════════
     CONNECTION (delegates to existing wallet code)
  ════════════════════════════════════════════ */

  /**
   * Connect wallet. Delegates to existing connectWallet().
   * Emits WALLET_CONNECTING before, WALLET_CONNECTED on success.
   *
   * @param {string} [walletType] - 'metamask' | 'coinbase' | 'rabby' | 'injected' | 'walletconnect'
   * @returns {Promise<{ address: string|null, chainId: number|null }>}
   */
  async function connect(walletType) {
    try {
      if (typeof EventBus !== 'undefined' && EventBus.emit) {
        EventBus.emit('WALLET_CONNECTING', { walletType: walletType || 'auto' });
      }
    } catch (_e) {}

    // Delegate to existing connection logic
    try {
      if (typeof connectWalletConnect === 'function') {
        await connectWalletConnect();
      } else if (typeof connectWallet === 'function') {
        await connectWallet();
      }
    } catch (e) {
      try {
        if (typeof EventBus !== 'undefined' && EventBus.emit) {
          EventBus.emit('WALLET_CONNECT_ERROR', { error: e.message || 'unknown' });
        }
      } catch (_e2) {}
      throw e;
    }

    // Sync WalletStore
    _syncStore();

    // Emit connected event
    try {
      if (typeof EventBus !== 'undefined' && EventBus.emit) {
        EventBus.emit('WALLET_CONNECTED', {
          address: _getAddress(),
          chainId: _getChainId(),
          walletType: _getWalletType()
        });
      }
    } catch (_e2) {}

    return { address: _getAddress(), chainId: _getChainId() };
  }

  /**
   * Disconnect wallet. Delegates to existing disconnectWallet().
   * Emits WALLET_DISCONNECTED.
   */
  async function disconnect() {
    try {
      if (typeof disconnectWallet === 'function') {
        await disconnectWallet();
      }
    } catch (e) { /* ignore */ }

    _updateStore({ address: null, connected: false });

    try {
      if (typeof EventBus !== 'undefined' && EventBus.emit) {
        EventBus.emit('WALLET_DISCONNECTED', {});
      }
    } catch (_e2) {}
  }

  /* ════════════════════════════════════════════
     BALANCE
  ════════════════════════════════════════════ */

  /**
   * Refresh wallet balance. Delegates to existing refreshBalance().
   * Emits BALANCE_REFRESHED.
   *
   * @returns {Promise<{ USDC: number|null, EURC: number|null }>}
   */
  async function refreshBalance() {
    var usdcBal = null;
    var eurcBal = null;
    try {
      if (typeof refreshBalance === 'function') {
        // refreshBalance is not a global — it's defined in index.html's inline script
        if (typeof window.refreshBalance === 'function') {
          usdcBal = await window.refreshBalance();
        }
      }
    } catch (_e) { /* ignore */ }

    try {
      if (typeof EventBus !== 'undefined' && EventBus.emit) {
        EventBus.emit('BALANCE_REFRESHED', { USDC: usdcBal, EURC: eurcBal });
      }
    } catch (_e2) {}

    return { USDC: usdcBal, EURC: eurcBal };
  }

  /* ════════════════════════════════════════════
     CHAIN SWITCHING
  ════════════════════════════════════════════ */

  /**
   * Switch to a different chain. Delegates to existing switchNetwork().
   *
   * @param {number} chainId
   * @returns {Promise<boolean>}
   */
  async function switchChain(chainId) {
    try {
      if (typeof switchNetwork === 'function') {
        // switchNetwork takes the chain ID directly
        await switchNetwork(chainId);
      }
    } catch (e) {
      try {
        if (typeof EventBus !== 'undefined' && EventBus.emit) {
          EventBus.emit('CHAIN_SWITCH_ERROR', { chainId: chainId, error: e.message || 'unknown' });
        }
      } catch (_e2) {}
      return false;
    }

    _syncStore();

    try {
      if (typeof EventBus !== 'undefined' && EventBus.emit) {
        EventBus.emit('CHAIN_CHANGED', { chainId: chainId });
      }
    } catch (_e2) {}

    return true;
  }

  /* ════════════════════════════════════════════
     HELPERS — resolve state from existing globals
  ════════════════════════════════════════════ */

  function _getAddress() {
    try {
      if (typeof window.__App !== 'undefined' && window.__App.walletAddress) return window.__App.walletAddress;
    } catch (_e) {}
    try { return window.walletAddress || null; } catch (_e2) { return null; }
  }

  function _getChainId() {
    try { return window.activeChainId || 5042002; } catch (_e) { return 5042002; }
  }

  function _getWalletType() {
    try { return window.activeWalletType || null; } catch (_e) { return null; }
  }

  function _updateStore(patch) {
    try {
      if (typeof WalletStore !== 'undefined' && WalletStore.update) {
        WalletStore.update(patch);
      }
    } catch (_e) {}
  }

  function _syncStore() {
    _updateStore({
      address: _getAddress(),
      chainId: _getChainId(),
      walletType: _getWalletType(),
      connected: _getAddress() !== null
    });
  }

  /* ════════════════════════════════════════════
     INIT — sync initial state
  ════════════════════════════════════════════ */
  _syncStore();

  /** @public */
  window.WalletService = {
    VERSION: '1.0.0',
    connect: connect,
    disconnect: disconnect,
    refreshBalance: refreshBalance,
    switchChain: switchChain,
    getAddress: _getAddress,
    getChainId: _getChainId,
    getWalletType: _getWalletType,
    isConnected: function () { return _getAddress() !== null; }
  };
})();
