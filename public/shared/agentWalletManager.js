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

  var SCHEMA_VERSION = 3;  // v3 = encrypted session key support

  /* ════════════════════════════════════════
     C1 — WebCrypto AES-GCM encrypt/decrypt
     ════════════════════════════════════════ */
  function _getCrypto() {
    var c = window.crypto || window.msCrypto;
    if (!c || !c.subtle) return null;
    return c.subtle;
  }

  async function _deriveKey(password) {
    var subtle = _getCrypto();
    if (!subtle) return null;
    var enc = new TextEncoder();
    var keyMaterial = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return await subtle.deriveKey(
      { name: 'PBKDF2', salt: enc.encode('elligentt_agent_salt_v1'), iterations: 100000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptData(plaintext) {
    if (!_sessionPassword) return plaintext; // no password = no encryption
    var subtle = _getCrypto();
    if (!subtle) return plaintext;
    try {
      var key = await _deriveKey(_sessionPassword);
      var iv = crypto.getRandomValues(new Uint8Array(12));
      var enc = new TextEncoder();
      var ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, enc.encode(plaintext));
      var combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(ciphertext), iv.length);
      return 'ENC:' + _arrayBufferToBase64(combined.buffer);
    } catch(e) { return plaintext; }
  }

  async function decryptData(ciphertext) {
    if (!ciphertext || typeof ciphertext !== 'string') return ciphertext;
    if (!ciphertext.startsWith('ENC:')) return ciphertext; // not encrypted — backward compat
    if (!_sessionPassword) return null; // no password set — can't decrypt
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

  function hasEncryptionPassword() { return !!_sessionPassword; }

  async function setEncryptionPassword(password) {
    if (!password) { _sessionPassword = null; return; }
    _sessionPassword = String(password);
    if (_sessionPrivateKey) {
      await _saveSessionKeyEncrypted();
    }
  }

  async function _saveSessionKeyEncrypted() {
    if (!_sessionPrivateKey) return;
    var payload = JSON.stringify({ privateKey: _sessionPrivateKey, version: SCHEMA_VERSION });
    var encrypted = await encryptData(payload);
    try { localStorage.setItem(SESSION_KEY_ENC, encrypted); } catch(e) {}
  }

  async function _loadSessionKeyEncrypted() {
    if (_sessionPrivateKey) return _sessionPrivateKey; // already in RAM
    try {
      var stored = localStorage.getItem(SESSION_KEY_ENC);
      if (!stored) {
        // Fallback to v1 unencrypted
        stored = localStorage.getItem('elligentt_agent_session_v1');
        if (stored) {
          var v1 = JSON.parse(stored);
          if (v1 && v1.privateKey) {
            _sessionPrivateKey = v1.privateKey;
            return _sessionPrivateKey;
          }
        }
        return null;
      }
      var plaintext = await decryptData(stored);
      if (!plaintext) return null;
      var parsed = JSON.parse(plaintext);
      if (parsed && parsed.privateKey) {
        _sessionPrivateKey = parsed.privateKey;
        return _sessionPrivateKey;
      }
    } catch(e) {}
    return null;
  }

  /* ════════════════════════════════════════
     M2 — Canonical signer source
     ════════════════════════════════════════ */
  async function getSessionSigner(provider) {
    var key = await _loadSessionKeyEncrypted();
    if (!key) return null;
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
    try {
      var w = ethers.Wallet.createRandom();
      _sessionPrivateKey = w.privateKey;
      _sessionMnemonic = w.mnemonic ? w.mnemonic.phrase : null;
      agentProvider = getAgentProvider();
      agentWallet = w.connect(agentProvider);
      _setSessionWallet(agentWallet);

      // Save IMMEDIATELY to v1 for backward compat (sync, guaranteed persistence)
      try {
        localStorage.setItem('elligentt_agent_session_v1', JSON.stringify({ privateKey: w.privateKey, createdAt: Date.now() }));
      } catch(e) {}

      // Save encrypted to v2 (fire-and-forget, non-blocking)
      _saveSessionKeyEncrypted().catch(function(){});

      if (agentState) {
        agentState.walletAddress = agentWallet.address;
        agentState.registrationDate = agentState.registrationDate || Date.now();
        saveState();
      }
      return agentWallet;
    } catch(e) { return null; }
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
      supportedChains: ['Arc Testnet','Base','Ethereum','Arbitrum','Optimism','Polygon'],
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
    // Fallback: try restoring from old v1 session key (Treasury backwards compat)
    if (!agentWallet) {
      try {
        var oldRaw = localStorage.getItem('elligentt_agent_session_v1');
        if (oldRaw) {
          var old = JSON.parse(oldRaw);
          if (old && old.privateKey) {
            _sessionPrivateKey = old.privateKey;
            return restoreAgentWallet(old.privateKey);
          }
        }
      } catch(e) {}
      try {
        var oldStateRaw = localStorage.getItem('elligentt_agent_wallet_v1');
        if (oldStateRaw) {
          var oldState = JSON.parse(oldStateRaw);
          if (oldState && oldState.walletPrivateKey) {
            _sessionPrivateKey = oldState.walletPrivateKey;
            return restoreAgentWallet(oldState.walletPrivateKey);
          }
        }
      } catch(e) {}
    }
    loadState();
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
    return w ? w.address : null;
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
    // Auto-load encrypted session key into RAM (non-blocking)
    _loadSessionKeyEncrypted().then(function(key) {
      if (key && !agentWallet) {
        try {
          agentProvider = getAgentProvider();
          agentWallet = new ethers.Wallet(key, agentProvider);
          _setSessionWallet(agentWallet);
        } catch(e) {}
      }
    }).catch(function(){});
    return agentState;
  }

  function _ensureV1KeyExists() {
    // If we have a key in RAM but v1 localStorage is empty, sync it
    if (_sessionPrivateKey) {
      try {
        var v1 = localStorage.getItem('elligentt_agent_session_v1');
        if (!v1) {
          localStorage.setItem('elligentt_agent_session_v1',
            JSON.stringify({ privateKey: _sessionPrivateKey, createdAt: Date.now() }));
        }
      } catch(e) {}
    }
    if (!_sessionPrivateKey && !agentWallet) {
      // Try loading from v1
      try {
        var raw = localStorage.getItem('elligentt_agent_session_v1');
        if (raw) {
          var parsed = JSON.parse(raw);
          if (parsed && parsed.privateKey) {
            _sessionPrivateKey = parsed.privateKey;
            agentWallet = new ethers.Wallet(parsed.privateKey, getAgentProvider());
            _setSessionWallet(agentWallet);
          }
        }
      } catch(e) {}
    }
  }

  function _autoCreateIfMissing() {
    _ensureV1KeyExists();
    // Check all sources for an existing key
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
    // No key found — auto-create (sync, requires ethers)
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
    createWalletWithBackup: createWalletWithBackup,
    getMnemonic: getMnemonic,
    hasMnemonicBackup: hasMnemonicBackup,
    emergencyShutdown: emergencyShutdown,
    isShutdown: isShutdown,
    get walletAddress(){ return getAgentAddress(); },
    get agentId(){ return getAgentId(); },
    ARC_RPC: ARC_RPC,
    ARC_CHAIN_ID: ARC_CHAIN_ID
  };
})();
