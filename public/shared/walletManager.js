const WalletManager = (() => {
  'use strict';

  const VAULT_KEY = 'elligente_ew_vault';
  const DEVICE_SECRET_KEY = 'elligente_device_secret';
  const ARC_RPC = 'https://rpc.testnet.arc.network';
  const ARC_CHAIN_ID = 5042002;
  const PBKDF2_ITERATIONS = 100000;
  const IDB_NAME = 'elligente_wallet';
  const IDB_STORE = 'secrets';

  let _internalWallet = null;
  let _internalProvider = null;
  let _accountType = null;

  function _openIDB() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('No IndexedDB')); return; }
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(IDB_STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function _idbGet(key) {
    try {
      const db = await _openIDB();
      return new Promise((resolve) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => resolve(null);
      });
    } catch (_) { return null; }
  }

  async function _idbSet(key, value) {
    try {
      const db = await _openIDB();
      return new Promise((resolve) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(value, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } catch (_) { return false; }
  }

  async function _getOrCreateDeviceSecret() {
    let secret = await _idbGet('device_secret');
    if (secret && typeof secret === 'string' && secret.length >= 32) return secret;

    try {
      const lsSecret = localStorage.getItem(DEVICE_SECRET_KEY);
      if (lsSecret && lsSecret.length >= 32) {
        await _idbSet('device_secret', lsSecret);
        try { localStorage.removeItem(DEVICE_SECRET_KEY); } catch (_) {}
        return lsSecret;
      }
    } catch (_) {}

    const arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    secret = Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
    const stored = await _idbSet('device_secret', secret);
    if (!stored) {
      try { localStorage.setItem(DEVICE_SECRET_KEY, secret); } catch (_) {}
    }
    return secret;
  }

  async function _deriveKey(userIdentifier, salt) {
    const deviceSecret = await _getOrCreateDeviceSecret();
    const enc = new TextEncoder();
    const material = await crypto.subtle.importKey(
      'raw', enc.encode(deviceSecret + '|' + userIdentifier),
      'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: enc.encode(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
  }

  async function _encrypt(plaintext, cryptoKey) {
    const enc = new TextEncoder();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, enc.encode(plaintext));
    return { iv: Array.from(iv), ct: Array.from(new Uint8Array(cipher)) };
  }

  async function _decrypt(data, cryptoKey) {
    const iv = new Uint8Array(data.iv);
    const ct = new Uint8Array(data.ct);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ct);
    return new TextDecoder().decode(plain);
  }

  function _generateSalt() {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
  }

  async function createOrRestoreWallet(email, userId) {
    if (typeof ethers === 'undefined') throw new Error('ethers.js not loaded');

    const stored = localStorage.getItem(VAULT_KEY);
    if (stored) {
      try {
        const vault = JSON.parse(stored);
        if (vault.v === 2 && vault.salt && vault.iv && vault.ct) {
          const derivedKey = await _deriveKey(email + '|' + userId, vault.salt);
          const pk = await _decrypt(vault, derivedKey);
          if (pk && pk.startsWith('0x') && pk.length === 66) {
            _internalProvider = new ethers.JsonRpcProvider(ARC_RPC);
            _internalWallet = new ethers.Wallet(pk, _internalProvider);
            _accountType = 'internal';
            return _internalWallet;
          }
        }
        if (vault.v === 1 || (!vault.v && vault.ct)) {
          const enc = new TextEncoder();
          const material = await crypto.subtle.importKey(
            'raw', enc.encode(email + '|' + userId + '|elligente'),
            'PBKDF2', false, ['deriveKey']
          );
          const legacyKey = await crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt: enc.encode('elligente-iw-v1'), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
            material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
          );
          const iv = new Uint8Array(vault.iv);
          const ct = new Uint8Array(vault.ct);
          const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, legacyKey, ct);
          const pk = new TextDecoder().decode(plain);
          if (pk && pk.startsWith('0x') && pk.length === 66) {
            _internalProvider = new ethers.JsonRpcProvider(ARC_RPC);
            _internalWallet = new ethers.Wallet(pk, _internalProvider);
            _accountType = 'internal';
            const newSalt = _generateSalt();
            const newKey = await _deriveKey(email + '|' + userId, newSalt);
            const encrypted = await _encrypt(pk, newKey);
            localStorage.setItem(VAULT_KEY, JSON.stringify({ ...encrypted, salt: newSalt, v: 2 }));
            return _internalWallet;
          }
        }
      } catch (_) {}
    }

    const wallet = ethers.Wallet.createRandom();
    const salt = _generateSalt();
    const derivedKey = await _deriveKey(email + '|' + userId, salt);
    const encrypted = await _encrypt(wallet.privateKey, derivedKey);
    localStorage.setItem(VAULT_KEY, JSON.stringify({ ...encrypted, salt, v: 2 }));
    _internalProvider = new ethers.JsonRpcProvider(ARC_RPC);
    _internalWallet = wallet.connect(_internalProvider);
    _accountType = 'internal';
    return _internalWallet;
  }

  function activateInternalWallet(wallet) {
    if (!wallet) return;
    if (wallet._isRemoteSigner) {
      wallet.getAddress().then(addr => { window.walletAddress = addr; _updateUI(addr); });
      window.signer = wallet;
      window.provider = wallet.provider;
    } else {
      window.walletAddress = wallet.address;
      window.signer = wallet;
      window.provider = _internalProvider;
    }
    window.activeChainId = ARC_CHAIN_ID;
    window.activeWalletType = 'intelligent';
    _accountType = 'internal';
    const addr = wallet.address || window.walletAddress;
    if (addr) _updateUI(addr);
  }

  function activateFromAuth() {
    if (typeof AuthManager === 'undefined' || !AuthManager.isAuthenticated()) return false;
    const remoteSigner = AuthManager.getRemoteSigner();
    const remoteProvider = AuthManager.getRemoteProvider();
    const walletAddr = AuthManager.getWalletAddress();
    if (!remoteSigner || !walletAddr) return false;
    _internalProvider = remoteProvider;
    _accountType = 'internal';
    window.walletAddress = walletAddr;
    window.signer = remoteSigner;
    window.provider = remoteProvider;
    window.activeChainId = ARC_CHAIN_ID;
    window.activeWalletType = 'intelligent';
    _updateUI(walletAddr);
    return true;
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
    if (typeof updateNetworkBadge === 'function') { try { updateNetworkBadge(); } catch (_) {} }
    if (typeof refreshBalance === 'function') { refreshBalance().catch(() => {}); }
  }

  function deactivateInternalWallet() {
    _internalWallet = null;
    _internalProvider = null;
    _accountType = null;
    if (window.activeWalletType === 'intelligent') {
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
    if (typeof AuthManager !== 'undefined' && AuthManager.isAuthenticated()) return 'internal';
    if (window.activeWalletType === 'intelligent') return 'internal';
    if (window.walletAddress) return 'external';
    return null;
  }

  function isInternalWallet() { return getAccountType() === 'internal'; }
  function isExternalWallet() { return getAccountType() === 'external'; }

  function getActiveWallet() {
    if (typeof AuthManager !== 'undefined' && AuthManager.isAuthenticated() && window.activeWalletType === 'intelligent') {
      return {
        address: AuthManager.getWalletAddress() || window.walletAddress,
        signer: AuthManager.getRemoteSigner() || window.signer,
        provider: AuthManager.getRemoteProvider() || _internalProvider,
        chainId: ARC_CHAIN_ID, type: 'internal', label: 'Intelligent Wallet',
      };
    }
    const type = getAccountType();
    if (!type) return null;
    return {
      address: window.walletAddress, signer: window.signer,
      provider: type === 'internal' ? _internalProvider : window.provider,
      chainId: window.activeChainId ?? ARC_CHAIN_ID, type,
      label: type === 'internal' ? 'Intelligent Wallet' : 'External Wallet',
    };
  }

  function resolveWallet() {
    if (window.walletAddress && window.activeWalletType && window.activeWalletType !== 'intelligent') {
      return { type: 'external', address: window.walletAddress, source: window.activeWalletType };
    }
    if (typeof AuthManager !== 'undefined' && AuthManager.isAuthenticated()) {
      return { type: 'internal', address: AuthManager.getWalletAddress(), source: 'intelligent' };
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
    createOrRestoreWallet, activateInternalWallet, activateFromAuth,
    deactivateInternalWallet, getAccountType, isInternalWallet, isExternalWallet,
    getActiveWallet, resolveWallet, clearVault,
    get internalWallet() { return _internalWallet; },
    get internalProvider() { return _internalProvider; },
    ARC_CHAIN_ID,
  };
})();

if (typeof window !== 'undefined') window.WalletManager = WalletManager;
