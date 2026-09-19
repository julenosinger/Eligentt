const WalletManager = (() => {
  'use strict';

  const VAULT_KEY = 'elligente_ew_vault';
  const LOCAL_ID_KEY = 'elligente_local_wallet_id';
  const DEVICE_SECRET_KEY = 'elligente_device_secret';
  const ARC_RPC = 'https://arc-testnet.drpc.org';
  const ARC_CHAIN_ID = 5042002;
  const PBKDF2_ITERATIONS = 100000;
  const IDB_NAME = 'elligente_wallet';
  const IDB_STORE = 'secrets';

  // ── Private state ──────────────────────────────────────────
  let _internalWallet = null;
  let _internalProvider = null;
  let _accountType = null;

  // Which wallet source is currently active: 'none' | 'internal' | 'external'
  let _activeSource = 'none';

  // ── IndexedDB helpers ──────────────────────────────────────
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

  function _getLocalId() {
    let id = null;
    try { id = localStorage.getItem(LOCAL_ID_KEY); } catch (_) {}
    if (!id) {
      const r = crypto.getRandomValues(new Uint8Array(8));
      id = 'local-' + Array.from(r, b => b.toString(16).padStart(2, '0')).join('');
      try { localStorage.setItem(LOCAL_ID_KEY, id); } catch (_) {}
    }
    return id;
  }

  // ── Wallet creation / restore ──────────────────────────────
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

  // ── Self-custody (local key) — user holds the key, encrypted on this device ──
  // Stores a given private key in the encrypted vault (no auth/server) and loads
  // it as the active internal wallet. Used for "create" (random key) and "import".
  async function importLocalWallet(privateKey) {
    if (typeof ethers === 'undefined') throw new Error('ethers.js not loaded');
    const w = new ethers.Wallet(privateKey); // throws if invalid
    const id = _getLocalId();
    const salt = _generateSalt();
    const derivedKey = await _deriveKey(id + '|' + id, salt);
    const encrypted = await _encrypt(w.privateKey, derivedKey);
    localStorage.setItem(VAULT_KEY, JSON.stringify({ ...encrypted, salt, v: 2 }));
    _internalProvider = new ethers.JsonRpcProvider(ARC_RPC);
    _internalWallet = w.connect(_internalProvider);
    _accountType = 'internal';
    return _internalWallet;
  }

  // Restore a previously-created local (self-custody) wallet from the vault.
  // Returns the wallet, or null if no local wallet exists on this device.
  async function restoreLocalWallet() {
    let id = null;
    try { id = localStorage.getItem(LOCAL_ID_KEY); } catch (_) {}
    if (!id) return null;
    try { return await createOrRestoreWallet(id, id); } catch (_) { return null; }
  }

  // ── Universal getters — always use these, never access globals directly ──

  /** Returns the current active wallet address, or null if none. */
  function getAddress() {
    return window.walletAddress || null;
  }

  /** Returns the current active signer, or null if read-only. */
  function getSigner() {
    return window.signer || null;
  }

  /** Returns the current active provider. */
  function getProvider() {
    return window.provider || null;
  }

  /** Returns 'internal' | 'external' | 'preview' | null */
  function getType() {
    if (_activeSource === 'internal') return 'internal';
    if (window.activeWalletType && window.activeWalletType !== 'intelligent') return 'external';
    if (window.activeWalletType === 'preview') return 'preview';
    if (window.activeWalletType === 'intelligent') return 'internal';
    return null;
  }

  /** Returns true if any wallet is connected and ready. */
  function isConnected() {
    return !!(getAddress() && getProvider());
  }

  /** Returns true if a signer is available (can execute transactions). */
  function canSign() {
    return !!(getAddress() && getSigner());
  }

  // ── Activation ─────────────────────────────────────────────

  function activateInternalWallet(wallet) {
    if (!wallet) return;
    if (wallet._isRemoteSigner) {
      wallet.getAddress().then(addr => { window.walletAddress = addr; _syncUI(addr); });
      window.signer = wallet;
      window.provider = wallet.provider;
    } else {
      window.walletAddress = wallet.address;
      window.signer = wallet;
      window.provider = _internalProvider;
    }
    window.activeChainId = ARC_CHAIN_ID;
    window.activeWalletType = 'intelligent';
    _activeSource = 'internal';
    _accountType = 'internal';
    const addr = wallet.address || window.walletAddress;
    if (addr) _syncUI(addr);
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
    _activeSource = 'internal';
    _syncUI(walletAddr);
    return true;
  }

  /** Called by external wallet connection flow to register an external wallet. */
  function registerExternalWallet(address, signer, provider, walletType) {
    window.walletAddress = address;
    window.signer = signer;
    window.provider = provider;
    window.activeWalletType = walletType;
    _activeSource = 'external';
    _syncUI(address);
  }

  /** Called when external wallet disconnects. */
  function unregisterExternalWallet() {
    if (_activeSource !== 'external') return;
    window.walletAddress = null;
    window.signer = null;
    window.provider = null;
    window.activeWalletType = null;
    _activeSource = 'none';
    _syncUI(null);
  }

  // ── Switching ──────────────────────────────────────────────

  /** Switch the active wallet to internal (loads from vault if needed). */
  async function switchToInternal(email, userId) {
    if (!_internalWallet) {
      try { await createOrRestoreWallet(email, userId); } catch(e) {
        console.error('[WalletManager] switchToInternal failed:', e);
        return false;
      }
    }
    if (!_internalWallet) return false;
    activateInternalWallet(_internalWallet);
    return true;
  }

  /** Switch the active wallet to external (if one is connected). */
  function switchToExternal() {
    if (!window.ethereum && !_cachedExternalProvider) return false;
    // Re-activate the external wallet if we have a cached provider
    if (window.walletAddress && _activeSource === 'external') return true;
    // Trigger reconnection via the standard flow
    if (typeof connectWallet === 'function') { connectWallet(); return true; }
    return false;
  }

  /** Returns which source is active: 'none' | 'internal' | 'external' */
  function getActiveSource() {
    return _activeSource;
  }

  /**
   * Switch the INTERNAL (Intelligent) wallet to another EVM chain.
   * The internal wallet is a local key bound to a fixed JsonRpcProvider, so we
   * re-point its provider (and reconnect the local signer) to the target chain's
   * RPC. No injected wallet / no wallet_switchEthereumChain involved.
   * Returns true on success, false if not applicable or RPC is unavailable.
   */
  async function switchInternalChain(chainId) {
    if (_activeSource !== 'internal') return false;
    if (typeof ethers === 'undefined') return false;
    let rpc = null;
    try {
      const ci = (typeof getChainById === 'function' && getChainById(chainId))
        || (typeof CHAINS !== 'undefined' && CHAINS.find && CHAINS.find(c => c && c.chainId === chainId))
        || null;
      if (ci && ci.rpc) rpc = ci.rpc;
    } catch (_) {}
    if (!rpc && chainId === ARC_CHAIN_ID) rpc = ARC_RPC;
    if (!rpc) return false;
    const newProvider = (typeof getCachedProvider === 'function')
      ? getCachedProvider(rpc)
      : new ethers.JsonRpcProvider(rpc);
    if (!newProvider) return false;
    _internalProvider = newProvider;
    if (_internalWallet && !_internalWallet._isRemoteSigner && typeof _internalWallet.connect === 'function') {
      _internalWallet = _internalWallet.connect(newProvider);
      window.signer = _internalWallet;
    }
    window.provider = newProvider;
    window.activeChainId = chainId;
    return true;
  }

  // ── Deactivation ───────────────────────────────────────────

  function deactivateInternalWallet() {
    _internalWallet = null;
    _internalProvider = null;
    _accountType = null;
    if (_activeSource === 'internal') {
      window.walletAddress = null;
      window.signer = null;
      window.provider = null;
      window.activeWalletType = null;
      window.activeChainId = ARC_CHAIN_ID;
      _activeSource = 'none';
      _syncUI(null);
    }
  }

  // ── Balance helpers ────────────────────────────────────────

  /** Get ETH/native balance for the active wallet. */
  async function getEthBalance() {
    const addr = getAddress();
    const prov = getProvider();
    if (!addr || !prov) return null;
    try {
      const bal = await prov.getBalance(addr);
      return parseFloat(ethers.formatUnits(bal, 18));
    } catch(_) { return null; }
  }

  /** Get ERC20 balance for the active wallet. */
  async function getTokenBalance(tokenAddress, decimals) {
    const addr = getAddress();
    const prov = getProvider();
    if (!addr || !prov || !tokenAddress) return null;
    try {
      const abi = ['function balanceOf(address) view returns (uint256)'];
      const c = new ethers.Contract(tokenAddress, abi, prov);
      const bal = await c.balanceOf(addr);
      return parseFloat(ethers.formatUnits(bal, decimals || 6));
    } catch(_) { return null; }
  }

  // ── Legacy helpers ─────────────────────────────────────────

  function getAccountType() {
    if (_activeSource === 'internal') return 'internal';
    if (_activeSource === 'external') return 'external';
    if (typeof AuthManager !== 'undefined' && AuthManager.isAuthenticated()) return 'internal';
    return null;
  }

  function isInternalWallet() { return _activeSource === 'internal'; }
  function isExternalWallet() { return _activeSource === 'external'; }

  function getActiveWallet() {
    const addr = getAddress();
    if (!addr) return null;
    const type = _activeSource === 'internal' ? 'internal' : 'external';
    return {
      address: addr,
      signer: getSigner(),
      provider: getProvider(),
      chainId: window.activeChainId ?? ARC_CHAIN_ID,
      type,
      label: type === 'internal' ? 'Internal Wallet' : 'External Wallet',
    };
  }

  function resolveWallet() {
    const addr = getAddress();
    if (!addr) return null;
    if (_activeSource === 'internal') {
      return { type: 'internal', address: addr, source: 'intelligent' };
    }
    return { type: 'external', address: addr, source: window.activeWalletType || 'external' };
  }

  function clearVault() {
    try { localStorage.removeItem(VAULT_KEY); } catch (_) {}
    deactivateInternalWallet();
  }

  // ── Internal cache for external provider ───────────────────
  let _cachedExternalProvider = null;
  function cacheExternalProvider(p) { _cachedExternalProvider = p; }

  // ── UI Sync ────────────────────────────────────────────────
  function _syncUI(address) {
    const short = address ? address.slice(0, 6) + '...' + address.slice(-4) : '';
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('chip-lbl', address ? short : 'Connect Wallet');
    set('sb-addr', address ? short : 'Not connected');
    set('sender-addr', address || '');
    set('dd-full-addr', address || '');
    set('wm-type-badge', _activeSource === 'internal' ? 'Internal' : _activeSource === 'external' ? 'External' : '');
    const chip = document.getElementById('chip-indicator');
    if (chip) chip.style.background = _activeSource === 'internal' ? '#a78bfa' : _activeSource === 'external' ? '#4f8ef7' : '#6b7280';
    const wchip = document.getElementById('wchip');
    if (wchip) wchip.style.borderColor = _activeSource === 'internal' ? 'rgba(167,139,250,.5)' : _activeSource === 'external' ? 'rgba(79,142,247,.5)' : '';
    const scoreEl = document.getElementById('sender-score');
    if (scoreEl) scoreEl.style.display = address ? '' : 'none';
    if (typeof updateNetworkBadge === 'function') { try { updateNetworkBadge(); } catch (_) {} }
    if (address && typeof refreshBalance === 'function') { refreshBalance().catch(() => {}); }
    if (typeof prfRefreshProfile === 'function') { try { var _pp = document.getElementById('page-profile'); if (_pp && _pp.classList.contains('active')) prfRefreshProfile(); } catch (_) {} }
  }

  // ── Public API ─────────────────────────────────────────────
  return {
    // Creation / restore
    createOrRestoreWallet, importLocalWallet, restoreLocalWallet,

    // Universal getters
    getAddress, getSigner, getProvider, getType,
    isConnected, canSign,

    // Activation / registration
    activateInternalWallet, activateFromAuth,
    registerExternalWallet, unregisterExternalWallet,
    cacheExternalProvider,

    // Switching
    switchToInternal, switchToExternal, getActiveSource, switchInternalChain,

    // Deactivation
    deactivateInternalWallet, clearVault,

    // Balance
    getEthBalance, getTokenBalance,

    // Legacy
    getAccountType, isInternalWallet, isExternalWallet,
    getActiveWallet, resolveWallet,

    // Internals (read-only)
    get internalWallet() { return _internalWallet; },
    get internalProvider() { return _internalProvider; },
    ARC_CHAIN_ID,
  };
})();

if (typeof window !== 'undefined') window.WalletManager = WalletManager;

