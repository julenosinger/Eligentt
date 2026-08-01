/**
 * Elligentt Key Migration — Phase 5 Remediation
 * Automatically migrates all legacy plaintext keys to encrypted storage.
 * Runs once on app load. Never creates new wallets.
 * Attached to window.KeyMigration
 */
(function(){
  'use strict';

  var migrated = false;
  var results = { found: [], migrated: [], removed: [], errors: [] };

  /* ── Detect if migration already ran this session ── */
  function hasMigrated() { return migrated; }

  /* ── Safe key verification — validates it's a real Ethereum private key ── */
  function isValidPrivateKey(key) {
    if (!key || typeof key !== 'string') return false;
    if (!key.startsWith('0x') || key.length !== 66) return false;
    return /^0x[0-9a-fA-F]{64}$/.test(key);
  }

  /* ── Encrypt a key using WebCrypto AES-GCM with a device-derived key ── */
  async function _encryptKey(plaintextKey, storageKey) {
    try {
      var subtle = window.crypto && window.crypto.subtle;
      if (!subtle) return null;

      var enc = new TextEncoder();
      var deviceSecret = _getDeviceSecret();
      var keyMaterial = await subtle.importKey('raw', enc.encode(deviceSecret + '|' + storageKey), 'PBKDF2', false, ['deriveKey']);
      var derivedKey = await subtle.deriveKey(
        { name: 'PBKDF2', salt: enc.encode('elligentt_remediation_salt_v5'), iterations: 100000, hash: 'SHA-256' },
        keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
      );

      var iv = window.crypto.getRandomValues(new Uint8Array(12));
      var cipher = await subtle.encrypt({ name: 'AES-GCM', iv: iv }, derivedKey, enc.encode(plaintextKey));
      var combined = new Uint8Array(iv.length + cipher.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(cipher), iv.length);

      var base64 = btoa(String.fromCharCode.apply(null, combined));
      return 'ENC_V5:' + base64;
    } catch(e) {
      results.errors.push('Encryption failed for ' + storageKey + ': ' + (e.message || 'error'));
      return null;
    }
  }

  function _getDeviceSecret() {
    try {
      var existing = localStorage.getItem('elligentt_device_remediation_secret');
      if (existing && existing.length >= 32) return existing;
      var arr = new Uint8Array(32);
      window.crypto.getRandomValues(arr);
      var secret = Array.from(arr, function(b) { return b.toString(16).padStart(2, '0'); }).join('');
      localStorage.setItem('elligentt_device_remediation_secret', secret);
      return secret;
    } catch(e) { throw new Error('PRODUCTION ERROR: Crypto.getRandomValues unavailable. Cannot generate device secret.'); }
  }

  /* ── Decrypt a migrated key ── */
  async function decryptMigratedKey(encryptedData, storageKey) {
    try {
      if (!encryptedData || !encryptedData.startsWith('ENC_V5:')) return null;
      var subtle = window.crypto && window.crypto.subtle;
      if (!subtle) return null;
      var enc = new TextEncoder();
      var deviceSecret = _getDeviceSecret();
      var keyMaterial = await subtle.importKey('raw', enc.encode(deviceSecret + '|' + storageKey), 'PBKDF2', false, ['deriveKey']);
      var derivedKey = await subtle.deriveKey(
        { name: 'PBKDF2', salt: enc.encode('elligentt_remediation_salt_v5'), iterations: 100000, hash: 'SHA-256' },
        keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
      );
      var binaryStr = atob(encryptedData.substring(7));
      var bytes = new Uint8Array(binaryStr.length);
      for (var i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      var iv = bytes.slice(0, 12);
      var data = bytes.slice(12);
      var decrypted = await subtle.decrypt({ name: 'AES-GCM', iv: iv }, derivedKey, data);
      return new TextDecoder().decode(decrypted);
    } catch(e) { return null; }
  }

  /* ── Report findings ── */
  function getReport() {
    return {
      found: results.found.slice(),
      migrated: results.migrated.slice(),
      removed: results.removed.slice(),
      errors: results.errors.slice(),
      complete: migrated
    };
  }

  /* ════════════════════════════════════════
     MIGRATION TARGETS
  ════════════════════════════════════════ */

  /* Target 1: elligentt_agent_session_v1 → encrypted v2 */
  async function _migrateAgentSessionV1() {
    try {
      var raw = localStorage.getItem('elligentt_agent_session_v1');
      if (!raw) return;
      results.found.push('elligentt_agent_session_v1');

      var parsed = JSON.parse(raw);
      var key = parsed && parsed.privateKey;
      if (!isValidPrivateKey(key)) {
        results.errors.push('elligentt_agent_session_v1: no valid private key');
        return;
      }

      // Check if v2 already exists with a valid key
      var v2exists = localStorage.getItem('elligentt_agent_session_v2');
      if (v2exists) {
        results.removed.push('elligentt_agent_session_v1 (v2 already exists)');
        localStorage.removeItem('elligentt_agent_session_v1');
        return;
      }

      var encrypted = await _encryptKey(key, 'agent_session');
      if (!encrypted) return;

      var payload = JSON.stringify({ privateKey: encrypted, version: 5 });
      localStorage.setItem('elligentt_agent_session_v2', payload);
      results.migrated.push('elligentt_agent_session_v1 → v2');

      // Verify
      var verify = localStorage.getItem('elligentt_agent_session_v2');
      if (verify && verify.indexOf('ENC_V5:') !== -1) {
        localStorage.removeItem('elligentt_agent_session_v1');
        results.removed.push('elligentt_agent_session_v1 (deleted after successful migration)');
      }
    } catch(e) {
      results.errors.push('elligentt_agent_session_v1 migration error: ' + (e.message || e));
    }
  }

  /* Target 2: elligentt_session_wallet_v1 → encrypted */
  async function _migrateSessionWalletV1() {
    try {
      var raw = localStorage.getItem('elligentt_session_wallet_v1');
      if (!raw) return;
      results.found.push('elligentt_session_wallet_v1');

      var key = raw;
      // Handle both raw key and JSON-wrapped
      try {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.privateKey) key = parsed.privateKey;
        else if (typeof parsed === 'string' && parsed.length >= 64) key = parsed;
      } catch(e) { /* raw string */ }

      if (!isValidPrivateKey(key)) {
        results.errors.push('elligentt_session_wallet_v1: no valid private key');
        return;
      }

      var encrypted = await _encryptKey(key, 'session_wallet');
      if (!encrypted) return;

      localStorage.setItem('elligentt_session_wallet_v2', JSON.stringify({ key: encrypted, version: 5 }));
      results.migrated.push('elligentt_session_wallet_v1 → v2');

      var verify = localStorage.getItem('elligentt_session_wallet_v2');
      if (verify && verify.indexOf('ENC_V5:') !== -1) {
        localStorage.removeItem('elligentt_session_wallet_v1');
        results.removed.push('elligentt_session_wallet_v1 (deleted)');
      }
    } catch(e) {
      results.errors.push('elligentt_session_wallet_v1 migration error: ' + (e.message || e));
    }
  }

  /* Target 3: elligentt_agent_wallet_v1 walletPrivateKey */
  async function _migrateAgentWalletV1() {
    try {
      var raw = localStorage.getItem('elligentt_agent_wallet_v1');
      if (!raw) return;
      var parsed = JSON.parse(raw);
      var key = parsed && parsed.walletPrivateKey;
      if (!isValidPrivateKey(key)) return;
      results.found.push('elligentt_agent_wallet_v1 (walletPrivateKey)');

      // Check if v2 already stores this key
      var v2raw = localStorage.getItem('elligentt_agent_wallet_v2');
      if (v2raw) {
        try {
          var v2 = JSON.parse(v2raw);
          if (v2 && v2.schemaVersion >= 3) {
            // v2 already has encrypted key — just scrub v1
            localStorage.removeItem('elligentt_agent_wallet_v1');
            results.removed.push('elligentt_agent_wallet_v1 (v2 already present, deleted)');
            return;
          }
        } catch(e) {}
      }

      var encrypted = await _encryptKey(key, 'agent_wallet');
      if (!encrypted) return;

      // Store encrypted key in v2
      parsed.walletPrivateKey = encrypted;
      parsed._encryptedKey = encrypted;
      parsed._migrationVersion = 5;
      localStorage.setItem('elligentt_agent_wallet_v2', JSON.stringify(parsed));
      results.migrated.push('elligentt_agent_wallet_v1 walletPrivateKey → encrypted v2');

      // Verify then delete v1
      if (localStorage.getItem('elligentt_agent_wallet_v2')) {
        localStorage.removeItem('elligentt_agent_wallet_v1');
        results.removed.push('elligentt_agent_wallet_v1 (deleted after migration)');
      }
    } catch(e) {
      results.errors.push('elligentt_agent_wallet_v1 migration error: ' + (e.message || e));
    }
  }

  /* ── Scan all localStorage for any remaining plaintext keys ── */
  function _scanForPlaintextKeys() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k) continue;
        try {
          var val = localStorage.getItem(k);
          if (!val || typeof val !== 'string') continue;
          // Look for 0x + 64 hex pattern
          var matches = val.match(/0x[a-fA-F0-9]{64}/g);
          if (matches) {
            for (var m = 0; m < matches.length; m++) {
              results.found.push('SUSPICIOUS: ' + k + ' contains plaintext key pattern');
            }
          }
          // Look for "privateKey" field with hex value
          if (val.indexOf('privateKey') !== -1) {
            try {
              var obj = JSON.parse(val);
              if (obj && obj.privateKey && isValidPrivateKey(obj.privateKey)) {
                results.found.push('SUSPICIOUS: ' + k + ' has privateKey field');
              }
            } catch(e) {}
          }
        } catch(e) {}
      }
    } catch(e) {}
  }

  /* ════════════════════════════════════════
     MAIN MIGRATION FUNCTION
  ════════════════════════════════════════ */
  async function runMigration() {
    if (migrated) return getReport();

    results = { found: [], migrated: [], removed: [], errors: [] };

    await _migrateAgentSessionV1();
    await _migrateSessionWalletV1();
    await _migrateAgentWalletV1();
    _scanForPlaintextKeys();

    migrated = true;

    // Record migration completion
    try {
      localStorage.setItem('elligentt_remediation_v5_migration_done', Date.now().toString());
    } catch(e) {}

    return getReport();
  }

  function resetMigrationFlag() {
    migrated = false;
    try { localStorage.removeItem('elligentt_remediation_v5_migration_done'); } catch(e) {}
  }

  window.KeyMigration = {
    runMigration: runMigration,
    getReport: getReport,
    isValidPrivateKey: isValidPrivateKey,
    encryptKey: _encryptKey,
    decryptMigratedKey: decryptMigratedKey,
    hasMigrated: hasMigrated,
    resetMigrationFlag: resetMigrationFlag
  };
})();
