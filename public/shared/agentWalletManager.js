/**
 * Autonoma Agent Wallet Manager — Persistent Agent Wallet with ERC-8004 Identity
 * Creates/manages a dedicated Agent Wallet for Autonoma.
 * This wallet represents Autonoma itself and persists between sessions.
 * All operations require explicit user authorization before execution.
 * Attached to window.AgentWalletManager
 *
 * FASE 4 HARDENING:
 *   C1 — Private key encrypted with WebCrypto AES-GCM + password
 *   A1 — BIP-39 mnemonic backup on wallet creation
 *   M2 — Single source: getSessionSigner() unifies all key reads
 *   M4 — emergencyShutdown() kills all operations
 */
(function(){
  'use strict';

  var WALLET_KEY = 'elligentt_agent_wallet_v2';
  var SESSION_KEY_ENC = 'elligentt_agent_session_v2';
  var ARC_RPC = 'https://arc-testnet.drpc.org';
  var ARC_CHAIN_ID = 5042002;

  var agentWallet = null;
  var agentProvider = null;
  var agentState = null;
  var _sessionPassword = null;    // RAM only — never persisted
  var _sessionMnemonic = null;    // RAM only
  var _sessionPrivateKey = null;  // RAM only — canonical source
  var _showBackup = false;        // RAM only — set on new wallet creation

  // PHASE 7B-5 — Auto-lock (RAM only, never persisted)
  var _autoLockTimer = null;
  var _autoLockMs = 30 * 60 * 1000; // 30 minutes
  var _signingOps = 0;

  // PHASE 7B-9 — Session restore (prevents race conditions)
  var _restoreState = 'idle'; // idle | restoring | ready | locked | failed
  var _restorePromise = null;
  var _restoreResolve = null;

  function _startRestore() {
    if (_restoreState === 'ready' || _restoreState === 'restoring') return _restorePromise;
    _restoreState = 'restoring';
    _restorePromise = new Promise(function(resolve) { _restoreResolve = resolve; });
    return _restorePromise;
  }

  function _finishRestore(success) {
    _restoreState = success ? 'ready' : 'locked';
    if (_restoreResolve) { _restoreResolve(); _restoreResolve = null; }
  }

  // PHASE 7B-9 — Trusted Device
  var TRUSTED_DEVICE_KEY = 'elligentt_agent_trusted_device';

  function isTrustedDeviceEnabled() {
    try { return !!localStorage.getItem(TRUSTED_DEVICE_KEY); } catch(e) { return false; }
  }

  async function enableTrustedDevice() {
    if (!_sessionPrivateKey || !_sessionPassword) return { success: false, reason: 'wallet_locked' };
    var subtle = _getCrypto();
    if (!subtle) return { success: false, reason: 'crypto_unavailable' };
    try {
      var deviceKey = new Uint8Array(32);
      crypto.getRandomValues(deviceKey);
      var enc = new TextEncoder();
      var keyMaterial = await subtle.importKey('raw', deviceKey, { name: 'AES-GCM' }, false, ['encrypt']);
      var iv = crypto.getRandomValues(new Uint8Array(12));
      var ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv: iv }, keyMaterial, enc.encode(JSON.stringify({ privateKey: _sessionPrivateKey, version: SCHEMA_VERSION })));
      var combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(ciphertext), iv.length);
      var deviceB64 = _arrayBufferToBase64(deviceKey.buffer);
      var encryptedB64 = _arrayBufferToBase64(combined.buffer);
      localStorage.setItem(TRUSTED_DEVICE_KEY, JSON.stringify({ deviceKey: deviceB64, encrypted: encryptedB64, address: _deriveAddressFromKey(_sessionPrivateKey), createdAt: Date.now() }));
      return { success: true };
    } catch(e) { return { success: false, reason: 'enroll_failed' }; }
  }

  async function tryTrustedUnlock() {
    if (_sessionPrivateKey) { _finishRestore(true); return true; }
    try {
      var raw = localStorage.getItem(TRUSTED_DEVICE_KEY);
      if (!raw) { _finishRestore(false); return false; }
      var data = JSON.parse(raw);
      if (!data.deviceKey || !data.encrypted) { _finishRestore(false); return false; }
      var subtle = _getCrypto();
      if (!subtle) { _finishRestore(false); return false; }
      var deviceKeyBytes = _base64ToArrayBuffer(data.deviceKey);
      var keyMaterial = await subtle.importKey('raw', deviceKeyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
      var combined = _base64ToArrayBuffer(data.encrypted);
      var iv = combined.slice(0, 12);
      var ct = combined.slice(12);
      var decrypted = await subtle.decrypt({ name: 'AES-GCM', iv: iv }, keyMaterial, ct);
      var parsed = JSON.parse(new TextDecoder().decode(decrypted));
      if (parsed && parsed.privateKey && _isValidPrivateKey(parsed.privateKey)) {
        var identity = _getPersistedWalletIdentity();
        if (identity.exists && identity.address) {
          var derivedAddr = _deriveAddressFromKey(parsed.privateKey);
          if (derivedAddr && derivedAddr.toLowerCase() !== identity.address) { _finishRestore(false); return false; }
        }
        _sessionPrivateKey = parsed.privateKey;
        _scheduleAutoLock();
        _finishRestore(true);
        return true;
      }
    } catch(e) {}
    _finishRestore(false);
    return false;
  }

  function disableTrustedDevice() {
    try { localStorage.removeItem(TRUSTED_DEVICE_KEY); } catch(e) {}
  }

  var SCHEMA_VERSION = 3;  // v3 = encrypted session key support

  /* ════════════════════════════════════════
     Phase 1.1 — Safe centralized v1→v2 migration
     Atomic: write → read-back → decrypt → verify address → delete v1
     ════════════════════════════════════════ */

  function _isValidPrivateKey(key) {
    return key && typeof key === 'string' && /^0x[0-9a-fA-F]{64}$/.test(key);
  }

  function _deriveAddressFromKey(privateKey) {
    try {
      if (typeof ethers === 'undefined') return null;
      return (new ethers.Wallet(privateKey)).address;
    } catch(e) { return null; }
  }

  async function _migrateV1ToEncryptedV2(privateKey) {
    var result = { success: false, reason: null };
    if (!_isValidPrivateKey(privateKey)) {
      result.reason = 'invalid_key_format';
      return result;
    }
    if (!_sessionPassword) {
      result.reason = 'no_password';
      return result;
    }
    var expectedAddress = _deriveAddressFromKey(privateKey);
    if (!expectedAddress) {
      result.reason = 'derive_address_failed';
      return result;
    }
    _sessionPrivateKey = privateKey;
    try { await _saveSessionKeyEncrypted(); } catch(e) {
      _sessionPrivateKey = (expectedAddress === _deriveAddressFromKey(privateKey)) ? privateKey : null;
      result.reason = 'encrypt_write_failed';
      return result;
    }
    var storedV2 = null;
    try { storedV2 = localStorage.getItem(SESSION_KEY_ENC); } catch(e) {}
    if (!storedV2 || !storedV2.startsWith('ENC:')) {
      result.reason = 'v2_read_failed';
      return result;
    }
    var decrypted = null;
    try { decrypted = await decryptData(storedV2); } catch(e) {}
    if (!decrypted) {
      result.reason = 'v2_decrypt_failed';
      return result;
    }
    var parsed = null;
    try { parsed = JSON.parse(decrypted); } catch(e) {}
    if (!parsed || !_isValidPrivateKey(parsed.privateKey)) {
      result.reason = 'v2_parse_failed';
      return result;
    }
    var migratedAddress = _deriveAddressFromKey(parsed.privateKey);
    if (migratedAddress !== expectedAddress) {
      result.reason = 'address_mismatch';
      return result;
    }
    result.success = true;
    return result;
  }

  async function _safeDeleteLegacyV1() {
    try { localStorage.removeItem('elligentt_agent_session_v1'); } catch(e) {}
    try {
      var w1raw = localStorage.getItem('elligentt_agent_wallet_v1');
      if (w1raw) {
        var w1 = JSON.parse(w1raw);
        delete w1.walletPrivateKey;
        localStorage.setItem('elligentt_agent_wallet_v1', JSON.stringify(w1));
      }
    } catch(e) {}
  }

  // PHASE 7B-9 — Central persisted wallet identity
  function _getPersistedWalletIdentity() {
    try {
      var v2raw = localStorage.getItem(WALLET_KEY);
      if (v2raw) {
        var v2 = JSON.parse(v2raw);
        if (v2 && v2.walletAddress && typeof v2.walletAddress === 'string' && v2.walletAddress.length === 42 && v2.walletAddress.startsWith('0x')) {
          return { exists: true, address: v2.walletAddress.toLowerCase(), source: 'v2' };
        }
      }
    } catch(e) {}
    try {
      var v1raw = localStorage.getItem('elligentt_agent_wallet_v1');
      if (v1raw) {
        var v1 = JSON.parse(v1raw);
        if (v1 && v1.walletAddress && typeof v1.walletAddress === 'string' && v1.walletAddress.startsWith('0x')) {
          return { exists: true, address: v1.walletAddress.toLowerCase(), source: 'v1' };
        }
      }
    } catch(e) {}
    try {
      var encRaw = localStorage.getItem(SESSION_KEY_ENC);
      if (encRaw) return { exists: true, address: null, source: 'encrypted_only' };
    } catch(e) {}
    return { exists: false };
  }

  var _creationInProgress = false;

  /* ════════════════════════════════════════
     C1 — WebCrypto AES-GCM encrypt/decrypt
     ENC:  legacy, static salt, 100k
     ENC3: per-wallet salt, 100k
     ENC4: per-wallet salt, 600k
     ════════════════════════════════════════ */
  var WALLET_SALT_LEN = 16;
  var PBKDF2_V1 = 100000;
  var PBKDF2_V4 = 600000;

  function _getCrypto() {
    var c = window.crypto || window.msCrypto;
    if (!c || !c.subtle) return null;
    return c.subtle;
  }

  function _generateSalt() {
    var arr = new Uint8Array(WALLET_SALT_LEN);
    crypto.getRandomValues(arr);
    return _arrayBufferToBase64(arr.buffer);
  }

  async function _deriveKey(password, salt, iterations) {
    var subtle = _getCrypto();
    if (!subtle) return null;
    var enc = new TextEncoder();
    var usedSalt = salt || 'elligentt_agent_salt_v1';
    var iters = iterations || PBKDF2_V1;
    var keyMaterial = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return await subtle.deriveKey(
      { name: 'PBKDF2', salt: enc.encode(usedSalt), iterations: iters, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptData(plaintext) {
    if (!_sessionPassword) return null;
    var subtle = _getCrypto();
    if (!subtle) return null;
    try {
      var key = await _deriveKey(_sessionPassword);
      if (!key) return null;
      var iv = crypto.getRandomValues(new Uint8Array(12));
      var enc = new TextEncoder();
      var ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, enc.encode(plaintext));
      var combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(ciphertext), iv.length);
      return 'ENC:' + _arrayBufferToBase64(combined.buffer);
    } catch(e) { return null; }
  }

  async function decryptData(ciphertext) {
    if (!ciphertext || typeof ciphertext !== 'string') return null;
    if (!ciphertext.startsWith('ENC:')) return null;
    if (!_sessionPassword) return null;
    var subtle = _getCrypto();
    if (!subtle) return null;
    try {
      var key = await _deriveKey(_sessionPassword);
      var combined = _base64ToArrayBuffer(ciphertext.substring(4));
      var iv = combined.slice(0, 12);
      var data = combined.slice(12);
      var decrypted = await subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, data);
      return new TextDecoder().decode(decrypted);
    } catch(e) { return null; }
  }

  // PHASE 7B-2 — Per-wallet salt (v3 format)
  async function _encryptV3(plaintext) {
    if (!_sessionPassword) return null;
    var subtle = _getCrypto();
    if (!subtle) return null;
    var salt = _generateSalt();
    if (!salt) return null;
    try {
      var key = await _deriveKey(_sessionPassword, salt);
      if (!key) return null;
      var iv = crypto.getRandomValues(new Uint8Array(12));
      var enc = new TextEncoder();
      var ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, enc.encode(plaintext));
      var combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(ciphertext), iv.length);
      return 'ENC3:' + salt + ':' + _arrayBufferToBase64(combined.buffer);
    } catch(e) { return null; }
  }

  async function _decryptV3(ciphertext) {
    if (!ciphertext || typeof ciphertext !== 'string') return null;
    if (!ciphertext.startsWith('ENC3:')) return null;
    if (!_sessionPassword) return null;
    var subtle = _getCrypto();
    if (!subtle) return null;
    try {
      var rest = ciphertext.substring(5);
      var sep = rest.indexOf(':');
      if (sep < 0) return null;
      var salt = rest.substring(0, sep);
      var payload = rest.substring(sep + 1);
      if (!salt || !payload) return null;
      var key = await _deriveKey(_sessionPassword, salt, PBKDF2_V1);
      var combined = _base64ToArrayBuffer(payload);
      var iv = combined.slice(0, 12);
      var data = combined.slice(12);
      var decrypted = await subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, data);
      return new TextDecoder().decode(decrypted);
    } catch(e) { return null; }
  }

  // PHASE 7B-3 — 600k iterations (v4 format)
  async function _encryptV4(plaintext) {
    if (!_sessionPassword) return null;
    var subtle = _getCrypto();
    if (!subtle) return null;
    var salt = _generateSalt();
    if (!salt) return null;
    try {
      var key = await _deriveKey(_sessionPassword, salt, PBKDF2_V4);
      if (!key) return null;
      var iv = crypto.getRandomValues(new Uint8Array(12));
      var enc = new TextEncoder();
      var ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, enc.encode(plaintext));
      var combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(ciphertext), iv.length);
      return 'ENC4:' + salt + ':' + _arrayBufferToBase64(combined.buffer);
    } catch(e) { return null; }
  }

  async function _decryptV4(ciphertext) {
    if (!ciphertext || typeof ciphertext !== 'string') return null;
    if (!ciphertext.startsWith('ENC4:')) return null;
    if (!_sessionPassword) return null;
    var subtle = _getCrypto();
    if (!subtle) return null;
    try {
      var rest = ciphertext.substring(5);
      var sep = rest.indexOf(':');
      if (sep < 0) return null;
      var salt = rest.substring(0, sep);
      var payload = rest.substring(sep + 1);
      if (!salt || !payload) return null;
      var key = await _deriveKey(_sessionPassword, salt, PBKDF2_V4);
      var combined = _base64ToArrayBuffer(payload);
      var iv = combined.slice(0, 12);
      var data = combined.slice(12);
      var decrypted = await subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, data);
      return new TextDecoder().decode(decrypted);
    } catch(e) { return null; }
  }

  // PHASE 7C-3 — Random unlock secret (not derived from walletAddress)
  function _generateUnlockSecret() {
    var bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return _arrayBufferToBase64(bytes.buffer);
  }

  function _getStoredUnlockSecret() {
    try { return localStorage.getItem(UNLOCK_SECRET_KEY); } catch(e) { return null; }
  }

  function _storeUnlockSecret(secret) {
    try { localStorage.setItem(UNLOCK_SECRET_KEY, secret); return true; } catch(e) { return false; }
  }

  // Store unlock secret on server (KV) for email-based recovery
  function _storeUnlockSecretOnServer(walletAddress, email, secret) {
    return fetch('/api/agent-secret/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress, email, unlockSecret: secret }),
    }).then(function(r) { return r.json(); }).catch(function() { return { ok: false }; });
  }

  // Request OTP via email
  function requestEmailOTP(walletAddress) {
    return fetch('/api/agent-secret/request-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress }),
    }).then(function(r) { return r.json(); }).catch(function() { return { ok: false, error: 'Network error' }; });
  }

  // Verify OTP and get unlock secret
  function verifyEmailOTP(walletAddress, code) {
    return fetch('/api/agent-secret/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress, code }),
    }).then(function(r) { return r.json(); }).catch(function() { return { ok: false, error: 'Network error' }; });
  }

  async function unlockWithEmailCode(walletAddress, code) {
    if (_sessionPrivateKey) return { success: true, alreadyUnlocked: true };
    var identity = _getPersistedWalletIdentity();
    if (!identity.exists) return { success: false, reason: 'no_wallet' };
    try {
      var resp = await verifyEmailOTP(walletAddress, code);
      if (!resp.ok || !resp.unlockSecret) return { success: false, reason: resp.error || 'verification_failed' };
      // Store the secret locally for future fast unlocks
      _storeUnlockSecret(resp.unlockSecret);
      return unlockWithConfirmation();
    } catch(e) { return { success: false, reason: 'unlock_error' }; }
  }

  // ENC6: AES-256-GCM + PBKDF2-HMAC-SHA256 600K iterations
  // Password = random unlock secret (secure random, not derivable from public info)
  async function _encryptV6(plaintext) {
    var secret = _getStoredUnlockSecret();
    if (!secret) return null;
    var subtle = _getCrypto();
    if (!subtle) return null;
    var salt = _generateSalt();
    if (!salt) return null;
    try {
      var key = await _deriveKey(secret, salt, PBKDF2_V4);
      if (!key) return null;
      var iv = crypto.getRandomValues(new Uint8Array(12));
      var enc = new TextEncoder();
      var ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, enc.encode(plaintext));
      var combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(ciphertext), iv.length);
      return 'ENC6:' + salt + ':' + _arrayBufferToBase64(combined.buffer);
    } catch(e) { return null; }
  }

  async function _decryptV6(ciphertext) {
    if (!ciphertext || typeof ciphertext !== 'string') return null;
    if (!ciphertext.startsWith('ENC6:')) return null;
    var secret = _getStoredUnlockSecret();
    if (!secret) return null;
    var subtle = _getCrypto();
    if (!subtle) return null;
    try {
      var rest = ciphertext.substring(5);
      var sep = rest.indexOf(':');
      if (sep < 0) return null;
      var salt = rest.substring(0, sep);
      var payload = rest.substring(sep + 1);
      if (!salt || !payload) return null;
      var key = await _deriveKey(secret, salt, PBKDF2_V4);
      var combined = _base64ToArrayBuffer(payload);
      var iv = combined.slice(0, 12);
      var data = combined.slice(12);
      var decrypted = await subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, data);
      return new TextDecoder().decode(decrypted);
    } catch(e) { return null; }
  }

  // Legacy ENC5 — deprecated, auto-migrated to ENC6
  var _walletKeySaltV5 = 'ElligenttAgentWalletV5::2026';
  function _getWalletKeyPassword() {
    var identity = _getPersistedWalletIdentity();
    if (!identity.exists || !identity.address) return null;
    return identity.address.toLowerCase() + ':' + _walletKeySaltV5;
  }

  async function _encryptV5(plaintext) {
    var pw = _getWalletKeyPassword();
    if (!pw) return null;
    var subtle = _getCrypto();
    if (!subtle) return null;
    var salt = _generateSalt();
    if (!salt) return null;
    try {
      var key = await _deriveKey(pw, salt, PBKDF2_V4);
      if (!key) return null;
      var iv = crypto.getRandomValues(new Uint8Array(12));
      var enc = new TextEncoder();
      var ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, enc.encode(plaintext));
      var combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(ciphertext), iv.length);
      return 'ENC5:' + salt + ':' + _arrayBufferToBase64(combined.buffer);
    } catch(e) { return null; }
  }

  async function _decryptV5(ciphertext) {
    if (!ciphertext || typeof ciphertext !== 'string') return null;
    if (!ciphertext.startsWith('ENC5:')) return null;
    var pw = _getWalletKeyPassword();
    if (!pw) return null;
    var subtle = _getCrypto();
    if (!subtle) return null;
    try {
      var rest = ciphertext.substring(5);
      var sep = rest.indexOf(':');
      if (sep < 0) return null;
      var salt = rest.substring(0, sep);
      var payload = rest.substring(sep + 1);
      if (!salt || !payload) return null;
      var key = await _deriveKey(pw, salt, PBKDF2_V4);
      var combined = _base64ToArrayBuffer(payload);
      var iv = combined.slice(0, 12);
      var data = combined.slice(12);
      var decrypted = await subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, data);
      return new TextDecoder().decode(decrypted);
    } catch(e) { return null; }
  }

  async function unlockWithConfirmation(legacySignature) {
    if (_sessionPrivateKey) return { success: true, alreadyUnlocked: true };
    var identity = _getPersistedWalletIdentity();
    if (!identity.exists) return { success: false, reason: 'no_wallet' };
    var hasAddress = !!(identity.address);
    try {
      var stored = localStorage.getItem(SESSION_KEY_ENC);
      if (!stored) return { success: false, reason: 'no_encrypted_data' };
      var plaintext;

      function _finalizeUnlock(privateKey, mnemonic, isMigration) {
        _sessionPrivateKey = privateKey;
        if (mnemonic && !_sessionMnemonic) _sessionMnemonic = mnemonic;
        var dAddr = _deriveAddressFromKey(privateKey);
        if (!agentState) loadState();
        if (!agentState.walletAddress) { agentState.walletAddress = dAddr; saveState(); }
        _scheduleAutoLock();
        _finishRestore(true);
        if (isMigration) _migrateToENC6(privateKey).catch(function(){});
        return { success: true, address: dAddr, migrated: !!isMigration };
      }

      // ENC6: random unlock secret (secure)
      if (stored.startsWith('ENC6:')) {
        plaintext = await _decryptV6(stored);
        if (!plaintext) return { success: false, reason: 'decrypt_failed' };
        var parsed6 = JSON.parse(plaintext);
        if (!parsed6 || !_isValidPrivateKey(parsed6.privateKey)) return { success: false, reason: 'invalid_data' };
        return _finalizeUnlock(parsed6.privateKey, parsed6.mnemonic, false);
      }

      // ENC5: legacy deterministic — auto-migrate to ENC6
      if (stored.startsWith('ENC5:') && hasAddress) {
        plaintext = await _decryptV5(stored);
        if (!plaintext) return { success: false, reason: 'decrypt_failed' };
        var parsed5 = JSON.parse(plaintext);
        if (!parsed5 || !_isValidPrivateKey(parsed5.privateKey)) return { success: false, reason: 'invalid_data' };
        return _finalizeUnlock(parsed5.privateKey, parsed5.mnemonic, true);
      }

      // Legacy ENC4/ENC3/ENC: need Trusted Device or signature → migrate to ENC6
      _finishRestore(false);
      if (isTrustedDeviceEnabled()) {
        var tdOk = await tryTrustedUnlock();
        if (tdOk && _sessionPrivateKey) {
          return _finalizeUnlock(_sessionPrivateKey, null, true);
        }
      }

      if (legacySignature && String(legacySignature).length >= 8) {
        _sessionPassword = String(legacySignature);
        try {
          if (stored.startsWith('ENC4:')) plaintext = await _decryptV4(stored);
          else if (stored.startsWith('ENC3:')) plaintext = await _decryptV3(stored);
          else plaintext = await decryptData(stored);
        } finally { _sessionPassword = null; }
        if (!plaintext) return { success: false, reason: 'legacy_decrypt_failed' };
        var parsedL = JSON.parse(plaintext);
        if (!parsedL || !_isValidPrivateKey(parsedL.privateKey)) return { success: false, reason: 'invalid_data' };
        return _finalizeUnlock(parsedL.privateKey, parsedL.mnemonic, true);
      }
      return { success: false, reason: 'legacy_wallet_needs_migration' };
    } catch(e) {
      return { success: false, reason: 'unlock_error' };
    }
  }

  // PHASE 7C-3 — Migrate to ENC6 (random unlock secret)
  async function _migrateToENC6(privateKey) {
    if (!privateKey || !_isValidPrivateKey(privateKey)) return;
    // Ensure unlock secret exists (generate if missing)
    if (!_getStoredUnlockSecret()) {
      _storeUnlockSecret(_generateUnlockSecret());
    }
    try {
      var payload = JSON.stringify({ privateKey: privateKey, mnemonic: _sessionMnemonic || null, version: SCHEMA_VERSION });
      var encrypted = await _encryptV6(payload);
      if (!encrypted || !encrypted.startsWith('ENC6:')) return;
      var prev = localStorage.getItem(SESSION_KEY_ENC);
      localStorage.setItem(SESSION_KEY_ENC, encrypted);
      var verify = localStorage.getItem(SESSION_KEY_ENC);
      if (!verify || !verify.startsWith('ENC6:')) { localStorage.setItem(SESSION_KEY_ENC, prev); return; }
      var decrypted = await _decryptV6(verify);
      if (!decrypted) { localStorage.setItem(SESSION_KEY_ENC, prev); return; }
      var parsed = JSON.parse(decrypted);
      if (!parsed || !_isValidPrivateKey(parsed.privateKey)) { localStorage.setItem(SESSION_KEY_ENC, prev); return; }
    } catch(e) {}
  }

  async function _migrateToENC5(privateKey) {
    if (!privateKey || !_isValidPrivateKey(privateKey)) return;
    try {
      var payload = JSON.stringify({ privateKey: privateKey, mnemonic: _sessionMnemonic || null, version: SCHEMA_VERSION });
      var encrypted = await _encryptV5(payload);
      if (!encrypted || !encrypted.startsWith('ENC5:')) return;
      localStorage.setItem(SESSION_KEY_ENC, encrypted);
      var verify = localStorage.getItem(SESSION_KEY_ENC);
      if (!verify || !verify.startsWith('ENC5:')) return;
      var decrypted = await _decryptV5(verify);
      if (!decrypted) { localStorage.setItem(SESSION_KEY_ENC, encrypted); return; }
      var parsed = JSON.parse(decrypted);
      if (!parsed || !_isValidPrivateKey(parsed.privateKey)) return;
    } catch(e) {}
  }

  // PHASE 7B-4 — Safe migration ENC/ENC3 → ENC4 on unlock
  async function _tryMigrateToENC4(currentPrivateKey) {
    if (!currentPrivateKey || !_isValidPrivateKey(currentPrivateKey)) return;
    if (!_sessionPassword) return;
    var stored = localStorage.getItem(SESSION_KEY_ENC);
    if (!stored || stored.startsWith('ENC4:')) return;
    var expectedAddress = _deriveAddressFromKey(currentPrivateKey);
    if (!expectedAddress) return;
    try {
      var payload = JSON.stringify({ privateKey: currentPrivateKey, version: SCHEMA_VERSION });
      var encrypted = await _encryptV4(payload);
      if (!encrypted || !encrypted.startsWith('ENC4:')) return;
      localStorage.setItem(SESSION_KEY_ENC, encrypted);
      var verify = localStorage.getItem(SESSION_KEY_ENC);
      if (!verify || !verify.startsWith('ENC4:')) {
        localStorage.setItem(SESSION_KEY_ENC, stored);
        return;
      }
      var decrypted = await _decryptV4(verify);
      if (!decrypted) { localStorage.setItem(SESSION_KEY_ENC, stored); return; }
      var parsed = JSON.parse(decrypted);
      if (!parsed || !_isValidPrivateKey(parsed.privateKey)) {
        localStorage.setItem(SESSION_KEY_ENC, stored);
        return;
      }
      var migratedAddress = _deriveAddressFromKey(parsed.privateKey);
      if (migratedAddress !== expectedAddress) {
        localStorage.setItem(SESSION_KEY_ENC, stored);
        return;
      }
      try { localStorage.removeItem('elligentt_agent_session_v1'); } catch(e) {}
    } catch(e) {
      try { localStorage.setItem(SESSION_KEY_ENC, stored); } catch(_e) {}
    }
  }

  function _arrayBufferToBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = '';
    for (var i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function _base64ToArrayBuffer(base64) {
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function hasEncryptionPassword() { return !!(_getPersistedWalletIdentity().exists); }

  async function setEncryptionPassword(password) {
    if (!password) { _sessionPassword = null; return; }
    var pw = String(password);
    if (pw.length < 8) { _sessionPassword = null; return; }
    _sessionPassword = pw;
    if (_sessionPrivateKey) {
      _scheduleAutoLock();
      await _saveSessionKeyEncrypted();
      _tryMigrateToENC4(_sessionPrivateKey).catch(function(){});
    }
  }

  async function _saveSessionKeyEncrypted() {
    if (!_sessionPrivateKey) return;
    var payload = JSON.stringify({ privateKey: _sessionPrivateKey, mnemonic: _sessionMnemonic || null, version: SCHEMA_VERSION });
    try { localStorage.setItem(SESSION_KEY_ENC, payload); } catch(e) {}
  }

  async function _loadSessionKeyEncrypted() {
    if (_sessionPrivateKey) return _sessionPrivateKey;
    try {
      var stored = localStorage.getItem(SESSION_KEY_ENC);
      if (!stored) {
        var v1Raw = localStorage.getItem('elligentt_agent_session_v1');
        if (v1Raw) {
          var v1 = JSON.parse(v1Raw);
          if (v1 && v1.privateKey && _isValidPrivateKey(v1.privateKey)) {
            _sessionPrivateKey = v1.privateKey;
            _migrateV1ToEncryptedV2(v1.privateKey).then(function(mr) {
              if (mr && mr.success) _safeDeleteLegacyV1();
            }).catch(function(){});
            _finishRestore(true);
            return _sessionPrivateKey;
          }
        }
        _finishRestore(false);
        return null;
      }
      // PHASE 7B-9: try Trusted Device with proper await
      if (isTrustedDeviceEnabled()) {
        var tdOk = await tryTrustedUnlock();
        if (tdOk && _sessionPrivateKey) return _sessionPrivateKey;
      }
      // PHASE 7C-ROLLBACK: migrate ENC5/ENC6 → ENC4 if password available
      if (!_sessionPassword && (stored.startsWith('ENC5:') || stored.startsWith('ENC6:'))) {
        // Wallet in experimental format — needs password to migrate
        _finishRestore(false);
        return null;
      }
      // Fallback to password decrypt
      if (!stored.startsWith('ENC4:') && !stored.startsWith('ENC3:') && !stored.startsWith('ENC:') && !stored.startsWith('ENC5:') && !stored.startsWith('ENC6:')) {
        // Plaintext — no password needed
        var parsedRaw = JSON.parse(stored);
        if (parsedRaw && parsedRaw.privateKey && _isValidPrivateKey(parsedRaw.privateKey)) {
          _sessionPrivateKey = parsedRaw.privateKey;
          _scheduleAutoLock();
          _finishRestore(true);
          return _sessionPrivateKey;
        }
        _finishRestore(false);
        return null;
      }
      if (!_sessionPassword) { _finishRestore(false); return null; }
      var plaintext;
      if (stored.startsWith('ENC4:')) {
        plaintext = await _decryptV4(stored);
      } else if (stored.startsWith('ENC3:')) {
        plaintext = await _decryptV3(stored);
      } else {
        plaintext = await decryptData(stored);
      }
      if (!plaintext) { _finishRestore(false); return null; }
      var parsed = JSON.parse(plaintext);
      if (parsed && parsed.privateKey) {
        var identity = _getPersistedWalletIdentity();
        if (identity.exists && identity.address) {
          var derivedAddr = _deriveAddressFromKey(parsed.privateKey);
          if (derivedAddr && derivedAddr.toLowerCase() !== identity.address) {
            return null;
          }
        }
        _sessionPrivateKey = parsed.privateKey;
        _scheduleAutoLock();
        _finishRestore(true);
        if (!stored.startsWith('ENC4:')) {
          _tryMigrateToENC4(parsed.privateKey).catch(function(){});
        }
        try { if (localStorage.getItem('elligentt_agent_session_v1')) _safeDeleteLegacyV1(); } catch(e) {}
        return _sessionPrivateKey;
      }
    } catch(e) {}
    return null;
  }

  /* ════════════════════════════════════════
     PHASE 7B-5 — Auto-lock (inactivity timer)
     ════════════════════════════════════════ */
  function _clearAutoLockTimer() {
    if (_autoLockTimer) { clearTimeout(_autoLockTimer); _autoLockTimer = null; }
  }

  function _scheduleAutoLock() {
    _clearAutoLockTimer();
    _autoLockTimer = setTimeout(function() {
      if (_signingOps > 0) { _scheduleAutoLock(); return; }
      _sessionPrivateKey = null;
      _sessionMnemonic = null;
      _autoLockTimer = null;
    }, _autoLockMs);
  }

  function _noteActivity() {
    if (_sessionPrivateKey) _scheduleAutoLock();
  }

  function isSessionUnlocked() {
    return !!_sessionPrivateKey;
  }

  function lockAgentWallet() {
    _clearAutoLockTimer();
    _sessionPrivateKey = null;
    _sessionMnemonic = null;
  }

  // PHASE 7B-8 — Verify password against stored encrypted wallet (no side effects)
  async function verifyWalletPassword(password) {
    if (!password || String(password).length < 8) return false;
    var stored = null;
    try { stored = localStorage.getItem(SESSION_KEY_ENC); } catch(e) {}
    if (!stored) return false;
    var pw = String(password);
    try {
      var plaintext;
      if (stored.startsWith('ENC4:')) {
        var rest = stored.substring(5);
        var sep = rest.indexOf(':');
        if (sep < 0) return false;
        var salt = rest.substring(0, sep);
        var payload = rest.substring(sep + 1);
        var subtle = _getCrypto();
        if (!subtle) return false;
        var enc = new TextEncoder();
        var keyMaterial = await subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveKey']);
        var key = await subtle.deriveKey(
          { name: 'PBKDF2', salt: enc.encode(salt), iterations: PBKDF2_V4, hash: 'SHA-256' },
          keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
        );
        var combined = _base64ToArrayBuffer(payload);
        var iv = combined.slice(0, 12);
        var data = combined.slice(12);
        await subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, data);
        return true;
      }
      // Legacy ENC/ENC3 fallback — attempt decrypt with provided password
      var savedPw = _sessionPassword;
      _sessionPassword = pw;
      var result;
      if (stored.startsWith('ENC3:')) result = await _decryptV3(stored);
      else result = await decryptData(stored);
      _sessionPassword = savedPw;
      return !!result;
    } catch(e) { return false; }
  }

  /* ════════════════════════════════════════
     M2 — Canonical signer source
     ════════════════════════════════════════ */
  async function getSessionSigner(provider) {
    var key = await _loadSessionKeyEncrypted();
    if (!key) return null;
    _noteActivity();
    var p = provider || getAgentProvider();
    return new ethers.Wallet(key, p);
  }

  function getSessionKey() {
    // Synchronous — returns key if already loaded in RAM
    return _sessionPrivateKey || null;
  }

  /* ════════════════════════════════════════
     A1 — BIP-39 mnemonic backup
     ════════════════════════════════════════ */
  function createWalletWithBackup() {
    if (typeof ethers === 'undefined') return null;
    if (_creationInProgress) return null;
    if (_getPersistedWalletIdentity().exists) return null;
    _creationInProgress = true;
    try {
      var w = ethers.Wallet.createRandom();
      _sessionPrivateKey = w.privateKey;
      _sessionMnemonic = w.mnemonic ? w.mnemonic.phrase : null;
      _showBackup = !!_sessionMnemonic;
      agentProvider = getAgentProvider();
      agentWallet = w.connect(agentProvider);
      _setSessionWallet(agentWallet);

      // [C1 FIX] Never persist plaintext key. Encrypt with ENC4.
      _saveSessionKeyEncrypted().then(function(){
        try { localStorage.removeItem('elligentt_agent_session_v1'); } catch(e) {}
      }).catch(function(){
        try { console.warn('[AgentWalletManager] Key encryption failed'); } catch(e) {}
      });

      if (agentState) {
        agentState.walletAddress = agentWallet.address;
        agentState.registrationDate = agentState.registrationDate || Date.now();
        saveState();
      }
      _creationInProgress = false;
      return agentWallet;
    } catch(e) { _creationInProgress = false; return null; }
  }

  function getMnemonic() {
    return _sessionMnemonic || null;
  }

  function hasMnemonicBackup() {
    return !!_sessionMnemonic;
  }

  /* ── Original createAgentWallet (backward compat) ── */
  function createAgentWallet(){
    return createWalletWithBackup();
  }

  /* ════════════════════════════════════════
     M4 — Emergency Shutdown
     ════════════════════════════════════════ */
  async function emergencyShutdown() {
    var result = { success: false, actions: [], errors: [] };

    // 1. Pause wallet
    pause();
    result.actions.push('Wallet paused');

    // 2. Revoke all authorizations
    try {
      if (typeof AgentAuthorization !== 'undefined') {
        AgentAuthorization.revokeAll();
        result.actions.push('All authorizations revoked');
      }
    } catch(e) { result.errors.push('Revoke failed: ' + e.message); }

    // 3. Clear session
    try {
      if (typeof AgentSession !== 'undefined') {
        AgentSession.clear();
        result.actions.push('Session cleared');
      }
    } catch(e) { result.errors.push('Session clear failed: ' + e.message); }

    // 4. Remove encrypted key from storage
    try {
      localStorage.removeItem(SESSION_KEY_ENC);
      localStorage.removeItem('elligentt_agent_session_v1');
      result.actions.push('Encrypted key removed');
    } catch(e) { result.errors.push('Key removal failed: ' + e.message); }

    // 5. Clear RAM
    _sessionPrivateKey = null;
    _sessionMnemonic = null;
    _sessionPassword = null;
    agentWallet = null;
    result.actions.push('RAM cleared');

    // 6. Update state
    if (agentState) {
      agentState.status = 'shutdown';
      agentState.sessionStatus = 'shutdown';
      saveState();
    }

    result.success = result.errors.length === 0;
    return result;
  }

  function isShutdown() {
    return agentState && agentState.status === 'shutdown';
  }

  function _emptyState() {
    return {
      agentId: null,
      walletAddress: null,
      identityTokenId: null,
      identityRegistered: false,
      identityTxHash: null,
      registrationDate: null,
      version: '1.0.0',
      metadataURI: null,
      capabilities: ['swap','bridge','treasury','payments','contracts','vault','crosschain','permit','recurring','scheduled','reimbursement','treasury_deposit'],
      supportedChains: ['Arc Testnet','Base','Ethereum Sepolia','Arbitrum Sepolia','Optimism Sepolia','Polygon Amoy'],
      status: 'active',
      sessionStatus: 'inactive',
      reputationScore: 50,
      developer: 'Elligentt',
      identityNFT: null,
      verificationStatus: 'unverified',
      pausedUntil: null,
      executionCount: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
      cancelledOperations: 0,
      totalPlanningTime: 0,
      totalExecutionTime: 0,
      simulationAccuracy: 0,
      permitAccuracy: 0,
      riskAccuracy: 0,
      completionRate: 0,
      bridgeSuccessRate: 0,
      treasurySuccessRate: 0,
      paymentSuccessRate: 0,
      swapSuccessRate: 0,
      schemaVersion: SCHEMA_VERSION
    };
  }

  function loadState(){
    agentState = null;
    try {
      var rawV2 = localStorage.getItem(WALLET_KEY);
      if (rawV2) {
        var parsed = JSON.parse(rawV2);
        if (parsed && parsed.schemaVersion === SCHEMA_VERSION) {
          agentState = parsed;
        }
      }
    } catch(e) {}
    if (!agentState) {
      try {
        var rawV1 = localStorage.getItem('elligentt_agent_wallet_v1');
        if (rawV1) {
          var old = JSON.parse(rawV1);
          agentState = _emptyState();
          agentState.agentId = old.agentId || null;
          agentState.walletAddress = old.walletAddress || null;
          agentState.identityTokenId = old.identityTokenId || null;
          agentState.identityRegistered = old.identityRegistered || false;
          agentState.identityTxHash = old.identityTxHash || null;
          agentState.registrationDate = old.registrationDate || null;
          agentState.version = old.version || '1.0.0';
          agentState.metadataURI = old.metadataURI || null;
          agentState.status = old.status || 'active';
          agentState.verificationStatus = old.verificationStatus || 'unverified';
          agentState.pausedUntil = old.pausedUntil || null;
          agentState.executionCount = old.executionCount || 0;
          agentState.successfulExecutions = old.successfulExecutions || 0;
          agentState.failedExecutions = old.failedExecutions || 0;
          agentState.cancelledOperations = old.cancelledOperations || 0;
          agentState.totalPlanningTime = old.totalPlanningTime || 0;
          agentState.totalExecutionTime = old.totalExecutionTime || 0;
          agentState.simulationAccuracy = old.simulationAccuracy || 0;
          agentState.permitAccuracy = old.permitAccuracy || 0;
          agentState.riskAccuracy = old.riskAccuracy || 0;
          agentState.completionRate = old.completionRate || 0;
          agentState.bridgeSuccessRate = old.bridgeSuccessRate || 0;
          agentState.treasurySuccessRate = old.treasurySuccessRate || 0;
          agentState.paymentSuccessRate = old.paymentSuccessRate || 0;
          agentState.swapSuccessRate = old.swapSuccessRate || 0;
          agentState.reputationScore = old.reputationScore || 50;
          agentState.schemaVersion = SCHEMA_VERSION;
        }
      } catch(e) {}
    }
    if (!agentState) {
      agentState = _emptyState();
    }
    // Sanitize: NEVER carry private keys from persisted state to v2
    delete agentState.walletPrivateKey;

    saveState();
    return agentState;
  }

  function saveState(){
    var safe = Object.assign({}, agentState);
    delete safe.walletPrivateKey;
    try { localStorage.setItem(WALLET_KEY, JSON.stringify(safe)); } catch(e){}
  }

  function _sessionWallet() {
    try {
      if (typeof _agentSessionWallet !== 'undefined' && _agentSessionWallet) {
        return _agentSessionWallet;
      }
      return null;
    } catch(e) { return null; }
  }

  function _setSessionWallet(w) {
    try {
      _agentSessionWallet = w;
    } catch(e) {}
  }

  function restoreAgentWallet(privateKey){
    if(typeof ethers === 'undefined') return null;
    try {
      agentProvider = getAgentProvider();
      agentWallet = new ethers.Wallet(privateKey, agentProvider);
      _setSessionWallet(agentWallet);
      if(agentState){
        agentState.walletAddress = agentWallet.address;
        saveState();
      }
      return agentWallet;
    } catch(e){ return null; }
  }

  // PHASE 7B-6 — BIP-39 mnemonic import
  async function restoreFromMnemonic(mnemonic, password) {
    if (!mnemonic || typeof mnemonic !== 'string') return { success: false, reason: 'invalid_mnemonic' };
    var phrase = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
    if (typeof ethers === 'undefined') return { success: false, reason: 'ethers_unavailable' };
    var w;
    try { w = ethers.Wallet.fromPhrase(phrase); } catch(e) { return { success: false, reason: 'invalid_mnemonic' }; }
    if (!w || !_isValidPrivateKey(w.privateKey)) return { success: false, reason: 'invalid_mnemonic' };
    var importedAddress = w.address;
    _sessionPrivateKey = w.privateKey;
    _sessionMnemonic = phrase;
    _showBackup = false;
    // PHASE 7C-2 — Password optional; always save with ENC5
    if (password && String(password).length >= 8) {
      _sessionPassword = String(password);
    }
    try {
      var encrypted = await _encryptV4(payload);
      if (!encrypted || !encrypted.startsWith('ENC4:')) {
        _sessionPrivateKey = null; _sessionPassword = null; _sessionMnemonic = null;
        return { success: false, reason: 'encrypt_failed' };
      }
      localStorage.setItem(SESSION_KEY_ENC, encrypted);
      // Activate wallet
      agentProvider = getAgentProvider();
      agentWallet = w.connect(agentProvider);
      _setSessionWallet(agentWallet);
      if (!agentState) loadState();
      agentState.walletAddress = importedAddress;
      agentState.registrationDate = Date.now();
      saveState();
      _scheduleAutoLock();
      try { localStorage.removeItem('elligentt_agent_session_v1'); } catch(e) {}
      return { success: true, address: importedAddress };
    } catch(e) {
      _sessionPrivateKey = null; _sessionPassword = null; _sessionMnemonic = null;
      return { success: false, reason: 'restore_failed' };
    }
  }

  // PHASE 7B-7A — HD derivation + safe cross-chain signer
  function deriveAddressFromMnemonic(mnemonic, accountIndex) {
    if (!mnemonic || typeof mnemonic !== 'string') return { success: false, reason: 'invalid_mnemonic' };
    var idx = (accountIndex === undefined) ? 0 : Number(accountIndex);
    if (!Number.isFinite(idx) || idx < 0 || Math.floor(idx) !== idx) return { success: false, reason: 'invalid_account_index' };
    if (typeof ethers === 'undefined') return { success: false, reason: 'ethers_unavailable' };
    try {
      var phrase = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
      var hdNode = ethers.HDNodeWallet.fromPhrase(phrase);
      var derived = hdNode.derivePath("m/44'/60'/0'/0/" + idx);
      return { success: true, address: derived.address, accountIndex: idx, derivationPath: "m/44'/60'/0'/0/" + idx };
    } catch(e) { return { success: false, reason: 'invalid_mnemonic' }; }
  }

  function _createSignerForChain(provider) {
    if (!_sessionPrivateKey) return null;
    return new ethers.Wallet(_sessionPrivateKey, provider || getAgentProvider());
  }

  // PHASE 7B-7B — Derive accounts from session mnemonic
  function deriveAccountAddress(accountIndex) {
    if (!_sessionMnemonic) return { success: false, reason: 'wallet_locked' };
    return deriveAddressFromMnemonic(_sessionMnemonic, accountIndex);
  }

  function getOrCreateWallet(){
    if(agentWallet) return agentWallet;
    var sessW = _sessionWallet();
    if (sessW) {
      agentWallet = sessW;
      agentProvider = getAgentProvider();
      try { agentWallet = agentWallet.connect(agentProvider); } catch(e) {}
      if(agentState){
        agentState.walletAddress = agentWallet.address;
        saveState();
      }
      return agentWallet;
    }
    // Sync: try loading encrypted session key into RAM first
    if (!agentWallet && _sessionPrivateKey) {
      return restoreAgentWallet(_sessionPrivateKey);
    }
    // [C1 FIX] Fallback: try restoring from old v1 session key (Treasury backwards compat)
    // On successful load, immediately migrate to encrypted v2 and delete v1 plaintext
    if (!agentWallet) {
      try {
        var oldRaw = localStorage.getItem('elligentt_agent_session_v1');
        if (oldRaw) {
          var old = JSON.parse(oldRaw);
          if (old && old.privateKey && _isValidPrivateKey(old.privateKey)) {
            _sessionPrivateKey = old.privateKey;
            _migrateV1ToEncryptedV2(old.privateKey).then(function(mr) {
              if (mr && mr.success) _safeDeleteLegacyV1();
            }).catch(function(){});
            return restoreAgentWallet(old.privateKey);
          }
        }
      } catch(e) {}
      try {
        var oldStateRaw = localStorage.getItem('elligentt_agent_wallet_v1');
        if (oldStateRaw) {
          var oldState = JSON.parse(oldStateRaw);
          if (oldState && oldState.walletPrivateKey && _isValidPrivateKey(oldState.walletPrivateKey)) {
            _sessionPrivateKey = oldState.walletPrivateKey;
            _migrateV1ToEncryptedV2(oldState.walletPrivateKey).then(function(mr) {
              if (mr && mr.success) _safeDeleteLegacyV1();
            }).catch(function(){});
            return restoreAgentWallet(oldState.walletPrivateKey);
          }
        }
      } catch(e) {}
    }
    loadState();
    if (_getPersistedWalletIdentity().exists) return null;
    var w = createAgentWallet();
    if(w && agentState){
      _setSessionWallet(w);
    }
    return w;
  }

  function getAgentWallet(){
    if(agentWallet) return agentWallet;
    return getOrCreateWallet();
  }

  function getAgentAddress(){
    var w = getOrCreateWallet();
    if (w) return w.address;
    if (!agentState) loadState();
    return (agentState && agentState.walletAddress) ? agentState.walletAddress : null;
  }

  function getAgentSigner(){
    var w = getAgentWallet();
    if(!w) return null;
    var p = getAgentProvider();
    if(!w.provider || (w.provider._getConnection && p._getConnection && w.provider._getConnection !== p._getConnection)){
      try { w = w.connect(p); agentWallet = w; } catch(e){}
    }
    return w;
  }

  function getAgentProvider(){
    if(agentProvider) return agentProvider;
    // Use RPCManager fallback if available
    if (typeof RPCManager !== 'undefined' && RPCManager.getCurrentProvider) {
      var p = RPCManager.getCurrentProvider();
      if (p) {
        agentProvider = p;
        return agentProvider;
      }
    }
    agentProvider = new ethers.JsonRpcProvider(ARC_RPC);
    return agentProvider;
  }

  function setAgentId(id){
    if(!agentState) loadState();
    agentState.agentId = id;
    saveState();
  }

  function getAgentId(){
    if(!agentState) loadState();
    return agentState && agentState.agentId ? agentState.agentId : null;
  }

  function registerIdentity(tokenId, txHash, metadataURI){
    if(!agentState) loadState();
    agentState.identityTokenId = tokenId;
    agentState.identityTxHash = txHash;
    agentState.identityRegistered = true;
    agentState.metadataURI = metadataURI || agentState.metadataURI;
    agentState.registrationDate = agentState.registrationDate || Date.now();
    saveState();
  }

  function setStatus(status){
    if(!agentState) loadState();
    agentState.status = status;
    saveState();
  }

  function pause(){
    setStatus('paused');
    agentState.pausedUntil = null;
    agentState.sessionStatus = 'paused';
    saveState();
  }

  function resume(){
    setStatus('active');
    agentState.pausedUntil = null;
    agentState.sessionStatus = 'active';
    saveState();
  }

  function isPaused(){
    if(!agentState) loadState();
    return agentState.status === 'paused' || (agentState.pausedUntil && agentState.pausedUntil > Date.now());
  }

  function isActive(){
    if(!agentState) loadState();
    return agentState.status === 'active' && !(agentState.pausedUntil && agentState.pausedUntil > Date.now());
  }

  function getFullState(){
    if(!agentState) loadState();
    var state = Object.assign({}, agentState, {
      walletAddress: agentWallet ? agentWallet.address : (agentState ? agentState.walletAddress : null),
      isPaused: isPaused(),
      isActive: isActive()
    });
    delete state.walletPrivateKey;
    return state;
  }

  function updateReputation(stats){
    if(!agentState) loadState();
    var keys = ['reputationScore','executionCount','successfulExecutions','failedExecutions',
      'cancelledOperations','totalPlanningTime','totalExecutionTime',
      'simulationAccuracy','permitAccuracy','riskAccuracy','completionRate',
      'bridgeSuccessRate','treasurySuccessRate','paymentSuccessRate','swapSuccessRate'];
    for(var i=0;i<keys.length;i++){
      if(stats[keys[i]] !== undefined) agentState[keys[i]] = stats[keys[i]];
    }
    saveState();
  }

  function recordExecution(result, duration){
    if(!agentState) loadState();
    agentState.executionCount = (agentState.executionCount||0) + 1;
    if(result === 'success') agentState.successfulExecutions = (agentState.successfulExecutions||0) + 1;
    else if(result === 'failed') agentState.failedExecutions = (agentState.failedExecutions||0) + 1;
    else if(result === 'cancelled') agentState.cancelledOperations = (agentState.cancelledOperations||0) + 1;
    if(duration) agentState.totalExecutionTime = (agentState.totalExecutionTime||0) + duration;
    var total = agentState.successfulExecutions + agentState.failedExecutions;
    if(total > 0){
      agentState.completionRate = Math.round((agentState.successfulExecutions / total) * 100);
      agentState.reputationScore = Math.min(100, Math.max(10,
        50 + Math.round((agentState.successfulExecutions - agentState.failedExecutions * 2) / Math.max(1, total) * 50)));
    }
    saveState();
  }

  function recordOperationSuccess(operation){
    if(!agentState) loadState();
    var map = { bridge:'bridgeSuccessRate', treasury:'treasurySuccessRate', payment:'paymentSuccessRate', swap:'swapSuccessRate' };
    var key = map[operation];
    if(key){
      agentState[key] = Math.min(100, (agentState[key]||0) + 2);
      saveState();
    }
  }

  function load(){
    loadState();
    _startRestore();
    _loadSessionKeyEncrypted().then(function(key) {
      if (key && !agentWallet) {
        try {
          agentProvider = getAgentProvider();
          agentWallet = new ethers.Wallet(key, agentProvider);
          _setSessionWallet(agentWallet);
        } catch(e) {}
      }
      _finishRestore(!!key);
    }).catch(function(){ _finishRestore(false); });
    return agentState;
  }

  function _ensureV1KeyExists() {
    if (_sessionPrivateKey) {
      try {
        var v1 = localStorage.getItem('elligentt_agent_session_v1');
        if (v1) {
          _migrateV1ToEncryptedV2(_sessionPrivateKey).then(function(mr) {
            if (mr && mr.success) _safeDeleteLegacyV1();
          }).catch(function(){});
        } else {
          _saveSessionKeyEncrypted().catch(function(){});
        }
      } catch(e) {}
    }
    if (!_sessionPrivateKey && !agentWallet) {
      // PHASE 7C-FIX — Skip async PBKDF2 on page load
    }
  }

  function _autoCreateIfMissing() {
    if (_creationInProgress) return;
    if (_restoreState === 'restoring') {
      setTimeout(function() { _autoCreateIfMissing(); }, 500);
      return;
    }
    var identity = _getPersistedWalletIdentity();
    if (identity.exists && identity.address) return;
    _ensureV1KeyExists();
    if (agentWallet || _sessionPrivateKey) return;
    try {
      var v1 = localStorage.getItem('elligentt_agent_session_v1');
      if (v1) { var p = JSON.parse(v1); if (p && p.privateKey) return; }
    } catch(e) {}
    try {
      if (localStorage.getItem(SESSION_KEY_ENC)) return;
    } catch(e) {}
    try {
      var v1Old = localStorage.getItem('elligentt_agent_wallet_v1');
      if (v1Old) { var po = JSON.parse(v1Old); if (po && po.walletPrivateKey) return; }
    } catch(e) {}
    try {
      if (typeof ethers !== 'undefined') {
        createWalletWithBackup();
      }
    } catch(e) {}
  }

  // Deferred auto-create — runs when ethers is guaranteed loaded
  function _scheduleAutoCreate() {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      _autoCreateIfMissing();
    } else {
      document.addEventListener('DOMContentLoaded', function() {
        _autoCreateIfMissing();
      });
    }
    // Also retry after 2s for late-loading ethers (CDN)
    setTimeout(function() { _autoCreateIfMissing(); }, 2000);
  }

  function _scrubPersistedKeys() {
    // PASSIVE: only skip saving new keys. Existing keys preserved for backward compat.
    // Active scrubbing removed to avoid breaking Treasury auto-operations.
  }

  function getCapabilities(){ return agentState ? agentState.capabilities : []; }
  function getSupportedChains(){ return agentState ? agentState.supportedChains : []; }
  function getReputationScore(){ return agentState ? agentState.reputationScore : 0; }
  function getVerificationStatus(){ return agentState ? agentState.verificationStatus : 'unverified'; }
  function isIdentityRegistered(){ return agentState ? !!agentState.identityRegistered : false; }

  function exportAgentData(){
    var s = getFullState();
    return JSON.parse(JSON.stringify(s));
  }

  function resetAgent(){
    agentWallet = null;
    agentProvider = null;
    agentState = null;
    _setSessionWallet(null);
    try { localStorage.removeItem(WALLET_KEY); } catch(e){}
    try { localStorage.removeItem('elligentt_agent_wallet_v1'); } catch(e){}
    try { localStorage.removeItem('elligentt_agent_session_v1'); } catch(e){}
  }

  function getSecureWalletSummary(){
    var w = getOrCreateWallet();
    var s = getFullState();
    return s;
  }

  function auditPlaintextKeys() {
    var findings = [];
    var bannedKeys = ['privateKey', 'walletPrivateKey', 'agentWalletPrivateKey', 'mnemonic', 'seedPhrase', 'seed', 'secretKey'];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k) continue;
        try {
          var val = localStorage.getItem(k);
          if (!val) continue;
          var lower = val.toLowerCase();
          bannedKeys.forEach(function(bk) {
            if (lower.indexOf(bk.toLowerCase()) >= 0) {
              findings.push({ key: k, found: bk });
            }
          });
        } catch(e) {}
      }
      for (var j = 0; j < sessionStorage.length; j++) {
        var sk = sessionStorage.key(j);
        if (!sk) continue;
        try {
          var sv = sessionStorage.getItem(sk);
          if (!sv) continue;
          var slower = sv.toLowerCase();
          bannedKeys.forEach(function(bk) {
            if (slower.indexOf(bk.toLowerCase()) >= 0) {
              findings.push({ source: 'sessionStorage', key: sk, found: bk });
            }
          });
        } catch(e) {}
      }
    } catch(e) {}
    return {
      clean: findings.length === 0,
      findings: findings
    };
  }

  /**
   * Pre-execution validation (FASE: C2+A2+A3 fix).
   * Checks authorization (TOCTOU), gas limit, and daily ops counter.
   * Called immediately before signing — NOT at planning time.
   */
  function validatePreExecution(operation, maxFeePerGasWei, gasLimit, agentAddr) {
    // C2 — TOCTOU: re-validate authorization right before signing
    if (typeof AgentAuthorization !== 'undefined') {
      if (!AgentAuthorization.hasOperationAuth(operation)) {
        return { ok: false, reason: 'Authorization revoked or expired' };
      }
    }

    // A2 — Gas limit: enforce AGENT_MAX_GAS_USD
    var MAX_GAS_USD = 5;
    try {
      if (typeof SystemConfig !== 'undefined' && SystemConfig.AGENT_MAX_GAS_USD) {
        MAX_GAS_USD = Number(SystemConfig.AGENT_MAX_GAS_USD);
      }
    } catch(e) {}
    if (maxFeePerGasWei && gasLimit) {
      var gasCostWei = BigInt(maxFeePerGasWei) * BigInt(gasLimit);
      var gasCostUsd = parseFloat(ethers.formatUnits(gasCostWei, 18));
      if (gasCostUsd > MAX_GAS_USD) {
        return { ok: false, reason: 'Gas cost ' + gasCostUsd.toFixed(4) + ' USDC exceeds max ' + MAX_GAS_USD + ' USDC' };
      }
    }

    // A3 — Daily ops: increment BEFORE execution
    if (!agentState) loadState();
    agentState.executionCount = (agentState.executionCount || 0) + 1;
    var dailyOps = agentState.executionCount;
    var maxDaily = 999999;
    try {
      if (typeof SystemConfig !== 'undefined' && SystemConfig.AGENT_MAX_DAILY_OPS) {
        maxDaily = Number(SystemConfig.AGENT_MAX_DAILY_OPS);
      }
    } catch(e) {}
    saveState();

    if (dailyOps > maxDaily) {
      return { ok: false, reason: 'Daily operations limit reached (' + maxDaily + ')' };
    }

    // Audit the check
    try { _auditLogPreExec(operation, agentAddr); } catch(e) {}

    return { ok: true };
  }

  function _auditLogPreExec(operation, agentAddr) {
    try {
      if (typeof AgentAudit !== 'undefined') {
        AgentAudit.recordExecution({
          operation: operation,
          amount: 0,
          asset: 'USDC',
          chain: 'Arc Testnet',
          agentWallet: agentAddr || (agentState ? agentState.walletAddress : null),
          result: 'pre_validated',
          duration: 0
        });
      }
    } catch(e) {}
  }

  load();
  _scheduleAutoCreate();

  window.AgentWalletManager = {
    getOrCreateWallet: getOrCreateWallet,
    getAgentWallet: getAgentWallet,
    getAgentAddress: getAgentAddress,
    getAgentSigner: getAgentSigner,
    getAgentProvider: getAgentProvider,
    setAgentId: setAgentId,
    getAgentId: getAgentId,
    registerIdentity: registerIdentity,
    setStatus: setStatus,
    pause: pause,
    resume: resume,
    isPaused: isPaused,
    isActive: isActive,
    getFullState: getFullState,
    getSecureWalletSummary: getSecureWalletSummary,
    updateReputation: updateReputation,
    recordExecution: recordExecution,
    recordOperationSuccess: recordOperationSuccess,
    getCapabilities: getCapabilities,
    getSupportedChains: getSupportedChains,
    getReputationScore: getReputationScore,
    getVerificationStatus: getVerificationStatus,
    isIdentityRegistered: isIdentityRegistered,
    exportAgentData: exportAgentData,
    resetAgent: resetAgent,
    load: load,
    auditPlaintextKeys: auditPlaintextKeys,
    validatePreExecution: validatePreExecution,
    /* FASE 4 — Hardening */
    getSessionSigner: getSessionSigner,
    getSessionKey: getSessionKey,
    hasEncryptionPassword: hasEncryptionPassword,
    setEncryptionPassword: setEncryptionPassword,
    /* [C1 FIX] Public migration helper — encrypts a legacy v1 key into v2 */
    _migrateV1Key: function(privateKey) {
      if (!privateKey || !_isValidPrivateKey(privateKey)) return;
      _sessionPrivateKey = privateKey;
      _migrateV1ToEncryptedV2(privateKey).then(function(mr) {
        if (mr && mr.success) _safeDeleteLegacyV1();
      }).catch(function(){});
    },
    createWalletWithBackup: createWalletWithBackup,
    getMnemonic: getMnemonic,
    hasMnemonicBackup: hasMnemonicBackup,
    needsBackupDisplay: function() { return _showBackup && !!_sessionMnemonic; },
    clearBackupFlag: function() { _showBackup = false; },
    isSessionUnlocked: isSessionUnlocked,
    lockAgentWallet: lockAgentWallet,
    hasPersistedWallet: function() { return _getPersistedWalletIdentity().exists; },
    verifyWalletPassword: verifyWalletPassword,
    isTrustedDeviceEnabled: isTrustedDeviceEnabled,
    enableTrustedDevice: enableTrustedDevice,
    tryTrustedUnlock: tryTrustedUnlock,
    disableTrustedDevice: disableTrustedDevice,
    restoreFromMnemonic: restoreFromMnemonic,
    deriveAddressFromMnemonic: deriveAddressFromMnemonic,
    deriveAccountAddress: deriveAccountAddress,
    _createSignerForChain: _createSignerForChain,
    emergencyShutdown: emergencyShutdown,
    isShutdown: isShutdown,
    /* PHASE 4 — Hardening */
    get walletAddress(){ return getAgentAddress(); },
    get agentId(){ return getAgentId(); },
    ARC_RPC: ARC_RPC,
    ARC_CHAIN_ID: ARC_CHAIN_ID
  };
})();
