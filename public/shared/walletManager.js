/**
 * Elligente Wallet Manager — Hybrid Identity Resolver
 * ════════════════════════════════════════════════════
 * Resolves between External Wallet (MetaMask/WalletConnect)
 * and Internal Intelligent Wallet (embedded, login-based).
 *
 * Architecture:
 *   Account Layer → Wallet Resolver → External | Internal
 *
 * Security:
 *   - Private key encrypted with AES-256-GCM via Web Crypto API
 *   - Encryption key derived with PBKDF2 (100k iterations)
 *   - Raw key never stored in localStorage
 *   - Only encrypted ciphertext + IV persisted
 */

const WalletManager = (() => {
  'use strict';

  const VAULT_KEY = 'elligente_ew_vault';
  const ARC_RPC = 'https://rpc.testnet.arc.network';
  const ARC_CHAIN_ID = 5042002;
  const PBKDF2_ITERATIONS = 100000;

  let _internalWallet = null;
  let _internalProvider = null;
  let _accountType = null;

  async function _deriveKey(email, userId) {
    const enc = new TextEncoder();
    const material = await crypto.subtle.importKey(
      'raw', enc.encode(email + '|' + userId + '|elligente'),
      'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: enc.encode('elligente-iw-v1'), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
  }

  async function _encrypt(plaintext, cryptoKey) {
    const enc = new TextEncoder();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, enc.encode(plaintext));
    return JSON.stringify({ iv: Array.from(iv), ct: Array.from(new Uint8Array(cipher)), v: 1 });
  }

  async function _decrypt(json, cryptoKey) {
    const parsed = JSON.parse(json);
    const iv = new Uint8Array(parsed.iv);
    const ct = new Uint8Array(parsed.ct);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ct);
    return new TextDecoder().decode(plain);
  }

  async function createOrRestoreWallet(email, userId) {
    if (typeof ethers === 'undefined') throw new Error('ethers.js not loaded');
    const derivedKey = await _deriveKey(email, userId);
    const stored = localStorage.getItem(VAULT_KEY);
    if (stored) {
      try {
        const pk = await _decrypt(stored, derivedKey);
        if (pk && pk.startsWith('0x') && pk.length === 66) {
          _internalProvider = new ethers.JsonRpcProvider(ARC_RPC);
          _internalWallet = new ethers.Wallet(pk, _internalProvider);
          _accountType = 'internal';
          return _internalWallet;
        }
      } catch (_) {}
    }
    const wallet = ethers.Wallet.createRandom();
    const encrypted = await _encrypt(wallet.privateKey, derivedKey);
    localStorage.setItem(VAULT_KEY, encrypted);
    _internalProvider = new ethers.JsonRpcProvider(ARC_RPC);
    _internalWallet = wallet.connect(_internalProvider);
    _accountType = 'internal';
    return _internalWallet;
  }

  function activateInternalWallet(wallet) {
    if (!wallet) return;
    if (typeof walletAddress !== 'undefined') {
      window.walletAddress = wallet.address;
    }
    if (typeof signer !== 'undefined') {
      window.signer = wallet;
    }
    if (typeof provider !== 'undefined') {
      window.provider = _internalProvider;
    }
    if (typeof activeChainId !== 'undefined') {
      window.activeChainId = ARC_CHAIN_ID;
    }
    if (typeof activeWalletType !== 'undefined') {
      window.activeWalletType = 'intelligent';
    }
    _accountType = 'internal';
    _updateUI(wallet.address);
  }

  function _updateUI(address) {
    const short = address ? address.slice(0, 6) + '...' + address.slice(-4) : '';
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('chip-lbl', short);
    set('sb-addr', short);
    set('sender-addr', address);
    set('dd-full-addr', address);
    const chip = document.getElementById('chip-indicator');
    if (chip) chip.style.background = '#a78bfa';
    const wchip = document.getElementById('wchip');
    if (wchip) wchip.style.borderColor = 'rgba(167,139,250,.5)';
    const scoreEl = document.getElementById('sender-score');
    if (scoreEl) scoreEl.style.display = '';
    if (typeof updateNetworkBadge === 'function') {
      try { updateNetworkBadge(); } catch (_) {}
    }
    if (typeof refreshBalance === 'function') {
      refreshBalance().catch(() => {});
    }
  }

  function deactivateInternalWallet() {
    _internalWallet = null;
    _internalProvider = null;
    _accountType = null;
    if (typeof activeWalletType !== 'undefined' && window.activeWalletType === 'intelligent') {
      window.walletAddress = null;
      window.signer = null;
      window.provider = null;
      window.activeWalletType = null;
      window.activeChainId = ARC_CHAIN_ID;
      const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
      set('chip-lbl', 'Connect Wallet');
      set('sb-addr', 'Not connected');
      set('sb-bal', '\u2014');
      set('dd-bal', '\u2014');
      set('sender-addr', '');
      set('sender-bal', '');
      set('dd-full-addr', '');
      const chip = document.getElementById('chip-indicator');
      if (chip) chip.style.background = '#6b7280';
      const wchip = document.getElementById('wchip');
      if (wchip) wchip.style.borderColor = '';
    }
  }

  function getAccountType() {
    if (typeof activeWalletType !== 'undefined' && window.activeWalletType === 'intelligent') return 'internal';
    if (typeof walletAddress !== 'undefined' && window.walletAddress) return 'external';
    return null;
  }

  function isInternalWallet() {
    return getAccountType() === 'internal';
  }

  function isExternalWallet() {
    return getAccountType() === 'external';
  }

  function getActiveWallet() {
    const type = getAccountType();
    if (!type) return null;
    return {
      address: window.walletAddress,
      signer: window.signer,
      provider: type === 'internal' ? _internalProvider : window.provider,
      chainId: window.activeChainId ?? ARC_CHAIN_ID,
      type: type,
      label: type === 'internal' ? 'Intelligent Wallet' : 'External Wallet',
    };
  }

  function resolveWallet() {
    if (typeof walletAddress !== 'undefined' && window.walletAddress && window.activeWalletType !== 'intelligent') {
      return { type: 'external', address: window.walletAddress, source: window.activeWalletType ?? 'injected' };
    }
    if (_internalWallet) {
      return { type: 'internal', address: _internalWallet.address, source: 'intelligent' };
    }
    return null;
  }

  function clearVault() {
    try { localStorage.removeItem(VAULT_KEY); } catch (_) {}
    deactivateInternalWallet();
  }

  return {
    createOrRestoreWallet,
    activateInternalWallet,
    deactivateInternalWallet,
    getAccountType,
    isInternalWallet,
    isExternalWallet,
    getActiveWallet,
    resolveWallet,
    clearVault,
    get internalWallet() { return _internalWallet; },
    get internalProvider() { return _internalProvider; },
    ARC_CHAIN_ID,
  };
})();

if (typeof window !== 'undefined') {
  window.WalletManager = WalletManager;
}
