/**
 * BalanceService — single source of truth for cross-chain token balances.
 * ═══════════════════════════════════════════════════════════════════════════
 * GOLDEN RULE (HARD INVARIANT):
 *   A token's balance is ALWAYS read on the chain where the token lives —
 *   NEVER on the chain the wallet is currently connected to.
 *
 *   - Wallet on Arc  → read ETH balance on Base/Ethereum/etc.
 *   - Wallet on Base → read EURC balance on Arc.
 *   - Any combination of the supported networks (Arc 5042, Ethereum 1,
 *     Base 8453, Arbitrum 42161, Optimism 10, Polygon 137) must work.
 *
 * It never uses window.ethereum / MetaMask / the wallet's signing provider for
 * balance reads. Every read goes through a dedicated ethers.JsonRpcProvider
 * resolved from `chainId → CHAIN_REGISTRY → chain.rpc` (singleton per URL).
 *
 * Attached to window.BalanceService.
 */
(function () {
  'use strict';

  if (typeof window !== 'undefined' && window.BalanceService) return;

  var ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  var ETH_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  var TIMEOUT_MS = 5000;          // per-read RPC timeout (4-6s window)
  var CACHE_TTL_MS = 10000;       // in-memory cache TTL (8-12s window)
  var PROVIDER_TTL_MS = 5 * 60 * 1000; // provider reuse window

  var ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)'
  ];

  var _providers = {};   // url(lowercased) -> { provider, createdAt }
  var _cache = {};       // cacheKey -> { value, ts }
  var _stats = { hits: 0, misses: 0, errors: 0, providers: 0 };

  function _warn() {
    try { console.warn.apply(console, arguments); } catch (_) {}
  }

  function _isAddr(v) {
    return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
  }

  /* ════════════════════════════════════════════
     CHAIN RESOLUTION — chainId → CHAIN_REGISTRY entry
  ════════════════════════════════════════════ */

  /**
   * Resolve the chain entry for a numeric chainId. Prefers the in-app full
   * registry (getChainById), then the config-level ElligenteChains registry,
   * then a window.CHAIN_REGISTRY / CHAINS fallback.
   */
  function _chain(chainId) {
    var id = Number(chainId);
    if (!Number.isFinite(id)) return null;

    // 1) Full registry from the app (has tokens, rpcFallbacks, cctp, nativeCurrency).
    try { if (typeof getChainById === 'function') { var c = getChainById(id); if (c) return c; } } catch (_) {}

    // 2) Config-level registry (config/chains.js → window.ElligenteChains).
    try {
      if (window.ElligenteChains && window.ElligenteChains.CHAIN_REGISTRY && window.ElligenteChains.CHAIN_REGISTRY[id]) {
        return window.ElligenteChains.CHAIN_REGISTRY[id];
      }
    } catch (_) {}

    // 3) Direct window registry (defensive — some builds expose CHAIN_REGISTRY).
    try { if (window.CHAIN_REGISTRY && window.CHAIN_REGISTRY[id]) return window.CHAIN_REGISTRY[id]; } catch (_) {}

    // 4) CHAINS array fallback.
    try {
      if (typeof CHAINS !== 'undefined' && Array.isArray(CHAINS)) {
        var f = CHAINS.find(function (x) { return Number(x && x.chainId) === id; });
        if (f) return f;
      }
    } catch (_) {}

    return null;
  }

  /* ════════════════════════════════════════════
     RPC URL / PROVIDER MANAGEMENT
  ════════════════════════════════════════════ */

  function _resolveUrl(u) {
    if (!u) return u;
    // ethers.JsonRpcProvider needs an absolute URL; resolve same-origin
    // relative proxies (e.g. '/api/rpc/arc') against the current origin.
    if (u.charAt(0) === '/' && u.charAt(1) !== '/') {
      try { return window.location.origin + u; } catch (_) { return u; }
    }
    return u;
  }

  /**
   * Ordered RPC list for a chain: primary `chain.rpc` first, then any
   * `chain.rpcFallbacks` (Arc ships a proxy + several public endpoints).
   */
  function _rpcList(chain) {
    var list = [];
    if (chain && chain.rpc) list.push(chain.rpc);
    if (chain && Array.isArray(chain.rpcFallbacks)) {
      for (var i = 0; i < chain.rpcFallbacks.length; i++) {
        var u = chain.rpcFallbacks[i];
        if (u && list.indexOf(u) === -1) list.push(u);
      }
    }
    return list;
  }

  /**
   * Get (or reuse) a JsonRpcProvider for a specific RPC URL — singleton per
   * URL so providers are created once and reused across reads. Reuses the app's
   * getCachedProvider when available to keep exactly one provider per URL.
   */
  function _provider(url) {
    if (typeof ethers === 'undefined') return null;
    var full = _resolveUrl(url);
    if (!full) return null;
    var key = String(full).toLowerCase();
    var now = Date.now();

    if (_providers[key] && (now - _providers[key].createdAt) < PROVIDER_TTL_MS) {
      return _providers[key].provider;
    }

    try {
      if (typeof getCachedProvider === 'function') {
        var cached = getCachedProvider(full);
        if (cached) {
          _providers[key] = { provider: cached, createdAt: now };
          _stats.providers = Object.keys(_providers).length;
          return cached;
        }
      }
    } catch (_) {}

    try {
      var prov = new ethers.JsonRpcProvider(full);
      _providers[key] = { provider: prov, createdAt: now };
      _stats.providers = Object.keys(_providers).length;
      return prov;
    } catch (_) {
      return null;
    }
  }

  /* ════════════════════════════════════════════
     TOKEN META — address / decimals / native detection
  ════════════════════════════════════════════ */

  /**
   * Resolve token metadata for a token on a SPECIFIC chain:
   *   { symbol, address, decimals, isNative }
   *
   * Native detection (chain-consistent, never the connected wallet's chain):
   *   - 0x0 / 0xeee…e sentinels → native.
   *   - No address + symbol === chain.nativeCurrency.symbol → native (e.g. ETH).
   *   - Real address → ERC-20 (even on Arc, where the gas token is USDC but the
   *     swap token is the ERC-20 USDC at 0x3600…0000).
   */
  function _resolveTokenMeta(chain, chainId, token) {
    var sym = null, addr = null, decimals = null;

    if (token && typeof token === 'object') {
      sym = token.symbol || token.sym || null;
      addr = token.address || null;
      decimals = (token.decimals != null) ? token.decimals : null;
    } else if (typeof token === 'string') {
      sym = token;
    }
    if (!sym) return null;

    var S = String(sym).toUpperCase();

    // Address resolution is CHAIN-SPECIFIC: the token address must come from
    // the chain where the token lives, never from the wallet's active chain.
    if (!addr && chain && chain.tokens && chain.tokens[sym] && chain.tokens[sym].address) {
      addr = chain.tokens[sym].address;
    }
    if (!addr && chain && chain.tokens && chain.tokens[S] && chain.tokens[S].address) {
      addr = chain.tokens[S].address;
    }
    if (!addr) {
      try { if (typeof getTokenAddressForChain === 'function') addr = getTokenAddressForChain(chainId, sym); } catch (_) {}
    }
    if (!addr) {
      try { if (typeof getTokenAddressForChain === 'function') addr = getTokenAddressForChain(chainId, S); } catch (_) {}
    }

    var natSym = (chain && chain.nativeCurrency && chain.nativeCurrency.symbol) || null;
    var isNative = false;
    if (addr === ZERO_ADDRESS || addr === ETH_SENTINEL) {
      isNative = true;
    } else if (!addr) {
      // No ERC-20 address resolvable: native only when the symbol matches the
      // chain's native currency (e.g. ETH on Base/Ethereum/Arbitrum/Optimism).
      isNative = !!(natSym && S === String(natSym).toUpperCase());
    }
    // else: has a real address → ERC-20 (balanceOf).

    if (decimals == null) {
      if (chain && chain.tokens && chain.tokens[sym] && chain.tokens[sym].decimals != null) {
        decimals = Number(chain.tokens[sym].decimals);
      } else if (chain && chain.tokens && chain.tokens[S] && chain.tokens[S].decimals != null) {
        decimals = Number(chain.tokens[S].decimals);
      } else if (isNative && natSym && chain.nativeCurrency && chain.nativeCurrency.decimals != null) {
        decimals = Number(chain.nativeCurrency.decimals);
      } else {
        try { if (typeof getTokenDecimals === 'function') decimals = Number(getTokenDecimals(sym)); } catch (_) {}
      }
      if (decimals == null || !Number.isFinite(decimals)) decimals = 18;
    }

    return { symbol: sym, address: addr || null, decimals: Number(decimals) || 18, isNative: isNative };
  }

  /* ════════════════════════════════════════════
     CACHE (in-memory, TTL 10s, key = address + tokenAddress + chainId)
  ════════════════════════════════════════════ */

  function _cacheKey(address, tokenAddress, chainId) {
    return String(address).toLowerCase() + '::' + String(tokenAddress || 'native').toLowerCase() + '::' + Number(chainId);
  }
  function _cacheGet(key) {
    var entry = _cache[key];
    if (entry && (Date.now() - entry.ts) < CACHE_TTL_MS) { _stats.hits++; return entry.value; }
    _stats.misses++;
    return null;
  }
  function _cacheSet(key, value) {
    _cache[key] = { value: value, ts: Date.now() };
  }

  function _withTimeout(promise, ms) {
    ms = ms || TIMEOUT_MS;
    return Promise.race([
      promise,
      new Promise(function (_, reject) {
        setTimeout(function () { reject(new Error('BalanceService timeout (' + ms + 'ms)')); }, ms);
      })
    ]);
  }

  /* ════════════════════════════════════════════
     CORE READ (raw bigint, graceful degradation)
  ════════════════════════════════════════════ */

  /**
   * Read the RAW (bigint) balance of `token` on `chainId` for `address`.
   * Iterates the chain's ordered RPC list and returns the first success.
   * NEVER throws — returns null on any failure (RPC offline, bad token, etc.).
   */
  async function getTokenBalanceRaw(address, token, chainId) {
    try {
      if (!_isAddr(address)) return null;
      var id = Number(chainId);
      if (!Number.isFinite(id)) return null;

      var chain = _chain(id);
      if (!chain) { _warn('[BalanceService] no chain registry entry for chain', id); return null; }

      var meta = _resolveTokenMeta(chain, id, token);
      if (!meta) return null;

      // Native tokens must have a way to be read: either native (getBalance)
      // or an ERC-20 address (balanceOf). A symbol we cannot resolve at all is
      // treated as unavailable → null (fail-closed, never a fake balance).
      if (!meta.isNative && (!meta.address || !_isAddr(meta.address))) return null;

      var rpcList = _rpcList(chain);
      if (!rpcList.length) { _warn('[BalanceService] no RPC configured for chain', id); return null; }

      var lastErr = null;
      for (var i = 0; i < rpcList.length; i++) {
        try {
          var prov = _provider(rpcList[i]);
          if (!prov) continue;

          var bal;
          if (meta.isNative) {
            bal = await _withTimeout(prov.getBalance(address), TIMEOUT_MS);
          } else {
            var contract = new ethers.Contract(meta.address, ERC20_ABI, prov);
            bal = await _withTimeout(contract.balanceOf(address), TIMEOUT_MS);
          }

          if (typeof bal === 'bigint') return bal;
          try { return BigInt(String(bal)); } catch (_) { return null; }
        } catch (e) {
          lastErr = e;
        }
      }

      _stats.errors++;
      _warn('[BalanceService] getTokenBalanceRaw failed for chain', id, 'token', meta.symbol, (lastErr && lastErr.message) || lastErr);
      return null;
    } catch (e) {
      _stats.errors++;
      _warn('[BalanceService] getTokenBalanceRaw exception:', (e && e.message) || e);
      return null;
    }
  }

  /* ════════════════════════════════════════════
     PUBLIC API — getTokenBalance (formatted string)
  ════════════════════════════════════════════ */

  /**
   * Fetch the formatted balance of a token on a specific chain.
   *
   * @param {string} address        - wallet address (0x…)
   * @param {object|string} token   - { address, symbol, decimals } or a symbol
   * @param {number} chainId        - chainId of the chain where the token lives
   * @returns {Promise<string|null>} formatted balance string, or null on error
   */
  async function getTokenBalance(address, token, chainId) {
    try {
      if (!_isAddr(address)) return null;
      var id = Number(chainId);
      if (!Number.isFinite(id)) return null;

      var chain = _chain(id);
      if (!chain) return null;

      var meta = _resolveTokenMeta(chain, id, token);
      if (!meta) return null;

      // Cache key is scoped to (address + tokenAddress + chainId) so balances
      // never leak across chains or wallets.
      var key = _cacheKey(address, meta.isNative ? 'native' : meta.address, id);
      var cached = _cacheGet(key);
      if (cached != null) return cached;

      var raw = await getTokenBalanceRaw(address, token, id);
      if (raw == null) return null;

      var formatted = ethers.formatUnits(raw, meta.decimals);
      _cacheSet(key, formatted);
      return formatted;
    } catch (e) {
      _stats.errors++;
      _warn('[BalanceService] getTokenBalance exception:', (e && e.message) || e);
      return null;
    }
  }

  /**
   * Invalidate cached balances for a wallet (call on connect/switch/tx).
   * @param {string} [address]
   */
  function invalidate(address) {
    var keys = Object.keys(_cache);
    if (!address) { _cache = {}; return; }
    var lower = String(address).toLowerCase();
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf(lower) === 0) delete _cache[keys[i]];
    }
  }

  /**
   * Invalidate cached balances for a specific chainId.
   * @param {number} chainId
   */
  function invalidateChain(chainId) {
    var id = Number(chainId);
    var keys = Object.keys(_cache);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].slice(-String(id).length) === String(id)) delete _cache[keys[i]];
    }
  }

  function getStats() {
    return {
      cacheKeys: Object.keys(_cache).length,
      providers: Object.keys(_providers).length,
      hits: _stats.hits,
      misses: _stats.misses,
      errors: _stats.errors
    };
  }

  /** @public */
  window.BalanceService = {
    VERSION: '1.0.0',
    // GOLDEN RULE: balance is always read on the chain where the token lives.
    getTokenBalance: getTokenBalance,
    getTokenBalanceRaw: getTokenBalanceRaw,
    invalidate: invalidate,
    invalidateChain: invalidateChain,
    getStats: getStats
  };
})();
