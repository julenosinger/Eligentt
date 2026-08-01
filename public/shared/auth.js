const AuthManager = (() => {
  'use strict';

  const SESSION_KEY = 'elligente_session';
  const PROFILE_KEY = 'elligente_auth_profile';
  const MIGRATED_KEY = 'elligente_auth_migrated';
  const API_BASE = '/api/auth';

  let _session = null;
  let _profile = null;
  let _remoteSigner = null;
  let _remoteProvider = null;
  let _custodialUnlocked = false;

  function _loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.ts) _session = { ts: parsed.ts };
      }
      const pRaw = localStorage.getItem(PROFILE_KEY);
      if (pRaw) _profile = JSON.parse(pRaw);
    } catch (_) {}
  }

  function _saveProfile(profile) {
    _profile = profile;
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(_profile)); } catch (_) {}
  }

  function _clearLegacyTokens() {
    try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
    try { localStorage.setItem(MIGRATED_KEY, '1'); } catch (_) {}
  }

  async function unlockCustodial(password) {
    const data = await _api('/unlock', { password });
    if (data.ok && data.unlocked) {
      _custodialUnlocked = true;
    }
    return data;
  }

  function isCustodialUnlocked() {
    return _custodialUnlocked;
  }

  function _clearSession() {
    _session = null;
    _profile = null;
    _remoteSigner = null;
    _remoteProvider = null;
    _custodialUnlocked = false;
    try {
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(PROFILE_KEY);
    } catch (_) {}
  }

  async function _api(endpoint, body, method = 'POST') {
    const headers = { 'Content-Type': 'application/json' };
    const opts = { method, headers, credentials: 'same-origin' };
    if (body && method !== 'GET') opts.body = JSON.stringify(body);
    const resp = await fetch(API_BASE + endpoint, opts);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  async function requestCode(email) {
    return _api('/register', { email });
  }

  async function verifyCode(email, code, password, name) {
    const data = await _api('/verify', { email, code, password: password || undefined, name: name || undefined });
    if (data.ok && data.sessionToken && data.profile) {
      _session = { ts: Date.now() };
      _saveProfile(data.profile);
      _clearLegacyTokens();
      _buildRemoteSigner();
    }
    return data;
  }

  async function loginWithPassword(email, password) {
    const data = await _api('/login', { email, password });
    if (data.ok && data.sessionToken && data.profile) {
      _session = { ts: Date.now() };
      _saveProfile(data.profile);
      _clearLegacyTokens();
      _buildRemoteSigner();
    }
    return data;
  }

  async function validateSession() {
    if (!_session) return false;
    try {
      const data = await _api('/session', null, 'GET');
      if (data.ok && data.profile) {
        _saveProfile(data.profile);
        if (data.custodialUnlocked) _custodialUnlocked = true;
        _buildRemoteSigner();
        return true;
      }
    } catch (_) {
      _clearSession();
    }
    return false;
  }

  async function logout() {
    try {
      await fetch(API_BASE + '/session', { method: 'DELETE', credentials: 'same-origin' });
    } catch (_) {}
    _clearSession();
  }

  async function _ensureUnlocked() {
    if (_custodialUnlocked) return true;
    if (typeof window._promptCustodialUnlock === 'function') {
      const password = await window._promptCustodialUnlock();
      if (!password) return false;
      try {
        const data = await unlockCustodial(password);
        return data.ok && data.unlocked;
      } catch (_) { return false; }
    }
    return false;
  }

  async function signOnServer(action, payload) {
    if (!_session) throw new Error('Not authenticated');
    const unlocked = await _ensureUnlocked();
    if (!unlocked) throw new Error('Custodial wallet locked. Unlock required.');
    try {
      return await _api('/sign', { action, ...payload });
    } catch (e) {
      if (e.message && e.message.indexOf('Custodial') >= 0) {
        _custodialUnlocked = false;
      }
      throw e;
    }
  }

  function _buildRemoteSigner() {
    if (!_profile || !_profile.wallet || !_profile.wallet.address) return;
    if (typeof ethers === 'undefined') return;

    const addr = _profile.wallet.address;
    const rpc = 'https://arc-testnet.drpc.org';
    _remoteProvider = new ethers.JsonRpcProvider(rpc);

    _remoteSigner = {
      _isRemoteSigner: true,
      provider: _remoteProvider,

      getAddress: async () => addr,

      signMessage: async (message) => {
        const result = await signOnServer('signMessage', { message });
        return result.signature;
      },

      // SECURITY: EIP-712 typed-data signing (capability only — dormant until the
      // relayer flow opts in). Produces a signature, never a transaction.
      signTypedData: async (domain, types, value) => {
        const result = await signOnServer('signTypedData', { domain, types, value });
        return result.signature;
      },

      signTransaction: async (tx) => {
        const serializable = {};
        for (const key of Object.keys(tx)) {
          const val = tx[key];
          if (typeof val === 'bigint') serializable[key] = '0x' + val.toString(16);
          else serializable[key] = val;
        }
        const result = await signOnServer('signTransaction', { transaction: serializable });
        return result.signedTransaction;
      },

      sendTransaction: async (tx) => {
        const serializable = {};
        for (const key of Object.keys(tx)) {
          const val = tx[key];
          if (typeof val === 'bigint') serializable[key] = '0x' + val.toString(16);
          else serializable[key] = val;
        }
        const result = await signOnServer('sendTransaction', { transaction: serializable });
        return {
          hash: result.txHash,
          wait: async () => {
            const receipt = await _remoteProvider.getTransactionReceipt(result.txHash);
            return receipt || { blockNumber: result.blockNumber, status: result.status };
          }
        };
      },

      connect: (prov) => {
        _remoteSigner.provider = prov;
        return _remoteSigner;
      },

      getNonce: async () => {
        return _remoteProvider.getTransactionCount(addr);
      },

      estimateGas: async (tx) => {
        return _remoteProvider.estimateGas({ ...tx, from: addr });
      },
    };

    _remoteSigner[Symbol.for('ethers.abstractSigner')] = true;
  }

  function isAuthenticated() {
    return !!(_session && _profile);
  }

  function getProfile() {
    return _profile;
  }

  function getSessionToken() {
    return null;
  }

  function getRemoteSigner() {
    return _remoteSigner;
  }

  function getRemoteProvider() {
    return _remoteProvider;
  }

  function getWalletAddress() {
    return _profile ? _profile.wallet?.address : null;
  }

  _loadSession();
  if (_session && _profile) {
    _buildRemoteSigner();
  }

  return {
    requestCode,
    verifyCode,
    loginWithPassword,
    validateSession,
    logout,
    signOnServer,
    isAuthenticated,
    getProfile,
    getSessionToken,
    getRemoteSigner,
    getRemoteProvider,
    getWalletAddress,
    unlockCustodial,
    isCustodialUnlocked,
  };
})();

if (typeof window !== 'undefined') {
  window.AuthManager = AuthManager;
}

