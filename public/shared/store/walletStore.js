/**
 * Elligentt WalletStore — Centralized Wallet State Management (Phase 1 Architecture)
 *
 * Encapsulates all wallet-related state. Emits through EventBus.
 * Does NOT replace window.__App — provides a structured alternative for new code.
 *
 * State: address, chainId, networkName, walletType, provider, signer, balances.
 *
 * Attached to: window.WalletStore
 *
 * @module walletStore
 * @version 1.0.0
 */
(function () {
  'use strict';

  /** @type {{ address: string|null, chainId: number|null, walletType: string|null, balances: Record<string,number>, connected: boolean, connecting: boolean }} */
  var _state = {
    address: null,
    chainId: null,
    networkName: 'Arc Testnet',
    walletType: null,    // 'metamask' | 'coinbase' | 'rabby' | 'injected' | 'walletconnect' | 'intelligent'
    balances: {},
    connected: false,
    connecting: false
  };

  /* ════════════════════════════════════════════
     GETTERS — source from __App when available
  ════════════════════════════════════════════ */

  /** @returns {string|null} */
  function getAddress() {
    try {
      if (typeof window.__App !== 'undefined' && window.__App.walletAddress) return window.__App.walletAddress;
    } catch (_e) {}
    try {
      if (typeof window.walletAddress !== 'undefined') return window.walletAddress;
    } catch (_e) {}
    return _state.address;
  }

  /** @returns {number|null} */
  function getChainId() {
    try {
      if (typeof window.activeChainId !== 'undefined') return window.activeChainId;
    } catch (_e) {}
    try {
      if (typeof window.__App !== 'undefined' && window.__App.activeChainId) return window.__App.activeChainId;
    } catch (_e) {}
    return _state.chainId;
  }

  /** @returns {string|null} */
  function getWalletType() {
    try {
      if (typeof window.activeWalletType !== 'undefined') return window.activeWalletType;
    } catch (_e) {}
    return _state.walletType;
  }

  /** @returns {{ address: string|null, chainId: number|null, walletType: string|null, connected: boolean }} */
  function getSnapshot() {
    return {
      address: getAddress(),
      chainId: getChainId(),
      networkName: _getNetworkName(),
      walletType: getWalletType(),
      connected: getAddress() !== null,
      balances: Object.assign({}, _state.balances)
    };
  }

  /** @returns {boolean} */
  function isConnected() {
    return getAddress() !== null;
  }

  /**
   * Derive a human-readable chain name from chainId.
   * @returns {string}
   */
  function _getNetworkName() {
    var id = getChainId();
    var map = {
      5042002: 'Arc Testnet',
      11155111: 'Ethereum Sepolia',
      84532: 'Base Sepolia',
      421614: 'Arbitrum Sepolia',
      11155420: 'Optimism Sepolia',
      80002: 'Polygon Amoy'
    };
    return map[id] || ('Chain ' + id);
  }

  /* ════════════════════════════════════════════
     SETTERS
  ════════════════════════════════════════════ */

  /**
   * Update internal state. Called by WalletService on connect/disconnect/chain-change.
   * Does NOT modify window.* globals — those are managed by existing wallet code.
   *
   * @param {Object} patch
   * @param {string} [patch.address]
   * @param {number} [patch.chainId]
   * @param {string} [patch.walletType]
   * @param {boolean} [patch.connected]
   * @emits WALLET_STATE_CHANGED
   */
  function update(patch) {
    var changed = false;
    if (patch.address !== undefined && _state.address !== patch.address) {
      _state.address = patch.address;
      changed = true;
    }
    if (patch.chainId !== undefined && _state.chainId !== patch.chainId) {
      _state.chainId = patch.chainId;
      _state.networkName = _getNetworkName();
      changed = true;
    }
    if (patch.walletType !== undefined) {
      _state.walletType = patch.walletType;
      changed = true;
    }
    if (patch.connected !== undefined) {
      _state.connected = patch.connected;
      changed = true;
    }
    if (patch.connecting !== undefined) {
      _state.connecting = patch.connecting;
      changed = true;
    }
    if (changed) {
      try {
        if (typeof EventBus !== 'undefined' && EventBus.emit) {
          EventBus.emit('WALLET_STATE_CHANGED', getSnapshot());
        }
      } catch (_e) { /* isolation */ }
    }
  }

  /**
   * Update balance for a specific token.
   * @param {string} token - Token symbol (e.g. 'USDC', 'EURC')
   * @param {number} balance
   * @emits BALANCE_UPDATED
   */
  function setBalance(token, balance) {
    _state.balances[token] = balance;
    try {
      if (typeof EventBus !== 'undefined' && EventBus.emit) {
        EventBus.emit('BALANCE_UPDATED', { token: token, balance: balance });
      }
    } catch (_e) { /* isolation */ }
  }

  /**
   * Reset store to initial state.
   */
  function reset() {
    _state.address = null;
    _state.chainId = null;
    _state.networkName = 'Arc Testnet';
    _state.walletType = null;
    _state.balances = {};
    _state.connected = false;
    _state.connecting = false;
  }

  /** @public */
  window.WalletStore = {
    VERSION: '1.0.0',
    getAddress: getAddress,
    getChainId: getChainId,
    getWalletType: getWalletType,
    isConnected: isConnected,
    getSnapshot: getSnapshot,
    update: update,
    setBalance: setBalance,
    reset: reset
  };
})();
