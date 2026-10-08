/**
 * Autonoma 2 — Context Engine
 * Builds a real-time snapshot of the user's financial context.
 * Read-only. Never executes transactions.
 * Attached to window.A2Context
 */
(function () {
  'use strict';

  var _cache = null;
  var _cacheTs = 0;
  var CACHE_TTL = 30000; // 30s

  async function get(force) {
    if (!force && _cache && (Date.now() - _cacheTs) < CACHE_TTL) return _cache;

    var ctx = {
      walletAddress: _evmWallet(),
      chainId: _chainId(),
      chainName: _chainName(),
      circleWalletAddress: null,
      circleWalletId: null,
      needsProvision: false,
      balances: {},
      contacts: [],
      ts: Date.now()
    };

    // Circle wallet
    try {
      var cr = await fetch('/api/agent/status', { credentials: 'same-origin' });
      if (cr.ok) {
        var cs = await cr.json();
        ctx.circleWalletAddress = cs.walletAddress || cs.address || null;
        ctx.circleWalletId = cs.walletId || null;
        ctx.needsProvision = cs.needsProvision || false;
      }
    } catch (e) { /* non-fatal */ }

    // Balances (non-fatal — LLM still runs if unavailable)
    if (ctx.walletAddress) {
      try {
        if (typeof BalanceService !== 'undefined') {
          var chainId = ctx.chainId || 5042;
          var tokens = ['USDC', 'EURC', 'cirBTC'];
          for (var i = 0; i < tokens.length; i++) {
            try {
              var b = await BalanceService.getTokenBalance(ctx.walletAddress, tokens[i], chainId);
              if (b !== null && b !== undefined) ctx.balances[tokens[i]] = b;
            } catch (e) { /* skip individual token failure */ }
          }
        }
      } catch (e) { /* non-fatal */ }
    }

    // Contacts
    try {
      if (typeof Store !== 'undefined') {
        ctx.contacts = (Store.load('contacts') || []).slice(0, 50);
      }
    } catch (e) { /* non-fatal */ }

    _cache = ctx;
    _cacheTs = Date.now();
    return ctx;
  }

  function invalidate() { _cache = null; _cacheTs = 0; }

  function _evmWallet() {
    if (typeof walletAddress !== 'undefined' && walletAddress) return walletAddress;
    if (typeof window !== 'undefined' && window.walletAddress) return window.walletAddress;
    return null;
  }

  function _chainId() {
    if (typeof activeChainId !== 'undefined' && activeChainId) return Number(activeChainId);
    return 5042;
  }

  function _chainName() {
    var id = _chainId();
    var names = { 5042: 'Arc Mainnet', 1: 'Ethereum', 8453: 'Base', 42161: 'Arbitrum', 10: 'Optimism', 137: 'Polygon' };
    return names[id] || 'Unknown';
  }

  window.A2Context = { get: get, invalidate: invalidate };

})();
