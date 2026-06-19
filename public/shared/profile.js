/**
 * Elligente Profile & Intelligent Wallet Module
 * ══════════════════════════════════════════════
 * Account management, embedded smart wallet, and activity tracking.
 * Prepares for Account Abstraction (ERC-4337) integration on Arc Network.
 *
 * Login is optional. The dApp works without an account.
 * When a user signs in, an Intelligent Wallet (smart account) is created.
 */

const ProfileManager = (() => {
  'use strict';

  const STORE_KEY = 'elligente_profile';
  const ACTIVITY_KEY = 'elligente_activity';

  function _emptyProfile() {
    return {
      id: null,
      email: null,
      name: null,
      avatar: null,
      wallet: { address: null, type: 'smart-account', network: 'Arc Testnet', chainId: 5042002 },
      auth: { provider: null, verified: false, createdAt: null, lastLogin: null },
      preferences: { currency: 'USD', locale: 'en-US' },
      stats: { transactions: 0, volume: 0, swaps: 0, bridges: 0, payments: 0, chainsUsed: new Set() },
    };
  }

  let _profile = null;

  function _load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) { _profile = _emptyProfile(); return _profile; }
      const p = JSON.parse(raw);
      p.stats = p.stats || {};
      p.stats.chainsUsed = new Set(p.stats.chainsUsed || []);
      _profile = { ..._emptyProfile(), ...p, wallet: { ..._emptyProfile().wallet, ...p.wallet }, auth: { ..._emptyProfile().auth, ...p.auth }, stats: { ..._emptyProfile().stats, ...p.stats } };
      return _profile;
    } catch (_) { _profile = _emptyProfile(); return _profile; }
  }

  function _save() {
    if (!_profile) return;
    try {
      const s = { ..._profile, stats: { ..._profile.stats, chainsUsed: [...(_profile.stats.chainsUsed || [])] } };
      localStorage.setItem(STORE_KEY, JSON.stringify(s));
    } catch (_) {}
  }

  function get() { if (!_profile) _load(); return _profile; }

  function isSignedIn() { return !!(get().id && get().auth.provider); }

  function generateWalletAddress() {
    const bytes = crypto.getRandomValues(new Uint8Array(20));
    return '0x' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }

  function generateUserId() {
    const r = crypto.getRandomValues(new Uint8Array(6));
    return 'USR-' + Array.from(r, b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  async function signIn(provider, userData) {
    const p = get();
    const isNew = !p.id;

    p.id = p.id || generateUserId();
    p.auth.provider = provider;
    p.auth.verified = true;
    p.auth.lastLogin = Date.now();
    if (isNew) p.auth.createdAt = Date.now();

    if (userData) {
      p.name = userData.name || p.name || provider + ' User';
      p.email = userData.email || p.email;
      p.avatar = userData.avatar || p.avatar;
    } else {
      p.name = p.name || provider.charAt(0).toUpperCase() + provider.slice(1) + ' User';
    }

    if (!p.wallet.address) {
      p.wallet.address = generateWalletAddress();
      p.wallet.type = 'smart-account';
      p.wallet.network = 'Arc Testnet';
      p.wallet.chainId = 5042002;
    }

    _save();
    return p;
  }

  function signOut() {
    const provider = _profile?.auth?.provider;
    _profile = _emptyProfile();
    _save();
    return provider;
  }

  function updateStats(type, amount, chainId) {
    const p = get();
    p.stats.transactions = (p.stats.transactions || 0) + 1;
    p.stats.volume = (p.stats.volume || 0) + (amount || 0);
    if (type === 'swap') p.stats.swaps = (p.stats.swaps || 0) + 1;
    if (type === 'bridge') p.stats.bridges = (p.stats.bridges || 0) + 1;
    if (type === 'send' || type === 'batch') p.stats.payments = (p.stats.payments || 0) + 1;
    if (chainId) p.stats.chainsUsed.add(chainId);
    _save();
  }

  function getActivity() {
    try {
      const raw = localStorage.getItem(ACTIVITY_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (_) { return []; }
  }

  function recordActivity(entry) {
    const activity = getActivity();
    activity.unshift({ ...entry, timestamp: Date.now() });
    if (activity.length > 100) activity.length = 100;
    try { localStorage.setItem(ACTIVITY_KEY, JSON.stringify(activity)); } catch (_) {}
  }

  async function fetchAssetBalances(provider, address) {
    if (!provider || !address || typeof ethers === 'undefined') return [];
    const tokens = [
      { symbol: 'USDC', address: '0x3600000000000000000000000000000000000000', decimals: 6, color: '#2775ca' },
      { symbol: 'EURC', address: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a', decimals: 6, color: '#4f8ef7' },
      { symbol: 'cirBTC', address: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF', decimals: 8, color: '#f7931a' },
    ];
    const abi = ['function balanceOf(address) view returns (uint256)'];
    const results = [];
    for (const t of tokens) {
      try {
        const contract = new ethers.Contract(t.address, abi, provider);
        const bal = await contract.balanceOf(address);
        const formatted = parseFloat(ethers.formatUnits(bal, t.decimals));
        results.push({ ...t, balance: formatted, raw: bal.toString() });
      } catch (_) {
        results.push({ ...t, balance: 0, raw: '0' });
      }
    }
    return results;
  }

  return {
    get, isSignedIn, signIn, signOut,
    updateStats, getActivity, recordActivity,
    fetchAssetBalances,
    generateWalletAddress, generateUserId,
  };
})();

if (typeof window !== 'undefined') {
  window.ProfileManager = ProfileManager;
}
