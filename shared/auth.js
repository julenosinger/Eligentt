const AuthManager = (() => {
  'use strict';

  const SESSION_KEY = 'elligente_session';
  const PROFILE_KEY = 'elligente_auth_profile';
  const API_BASE = '/api/auth';

  let _session = null;
  let _profile = null;
  let _remoteSigner = null;
  let _remoteProvider = null;

  function _loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (raw) _session = JSON.parse(raw);
      const pRaw = localStorage.getItem(PROFILE_KEY);
      if (pRaw) _profile = JSON.parse(pRaw);
    } catch (_) {}
  }

  function _saveSession(token, profile) {
    _session = { token, ts: Date.now() };
    _profile = profile;
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(_session));
      localStorage.setItem(PROFILE_KEY, JSON.stringify(_profile));
    } catch (_) {}
  }

  function _clearSession() {
    _session = null;
    _profile = null;
    _remoteSigner = null;
    _remoteProvider = null;
    try {
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(PROFILE_KEY);
    } catch (_) {}
  }

  async function _api(endpoint, body, method = 'POST') {
    const headers = { 'Content-Type': 'application/json' };
    if (_session && _session.token) {
      headers['Authorization'] = 'Bearer ' + _session.token;
    }
    const opts = { method, headers };
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
      _saveSession(data.sessionToken, data.profile);
      _buildRemoteSigner();
    }
    return data;
  }

  async function loginWithPassword(email, password) {
    const data = await _api('/login', { email, password });
    if (data.ok && data.sessionToken && data.profile) {
      _saveSession(data.sessionToken, data.profile);
      _buildRemoteSigner();
    }
    return data;
  }

  async function validateSession() {
    if (!_session || !_session.token) return false;
    try {
      const data = await _api('/session', null, 'GET');
      if (data.ok && data.profile) {
        _profile = data.profile;
        try { localStorage.setItem(PROFILE_KEY, JSON.stringify(_profile)); } catch (_) {}
        _buildRemoteSigner();
        return true;
      }
    } catch (_) {
      _clearSession();
    }
    return false;
  }

  async function logout() {
    if (_session && _session.token) {
      try {
        await fetch(API_BASE + '/session', {
          method: 'DELETE',
          headers: { 'Authorization': 'Bearer ' + _session.token },
        });
      } catch (_) {}
    }
    _clearSession();
  }

  async function signOnServer(action, payload) {
    if (!_session || !_session.token) throw new Error('Not authenticated');
    return _api('/sign', { action, ...payload });
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
    return !!(_session && _session.token && _profile);
  }

  function getProfile() {
    return _profile;
  }

  function getSessionToken() {
    return _session ? _session.token : null;
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
  };
})();

if (typeof window !== 'undefined') {
  window.AuthManager = AuthManager;
}

