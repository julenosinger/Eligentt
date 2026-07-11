/**
 * RobinhoodTokenRegistry — Production Token Registry for Robinhood Chain
 * ==========================================================================
 * Dedicated, isolated module for Robinhood Mainnet (4663) and Testnet (46630).
 *
 * Provides:
 *   - Dynamic ERC-20 metadata discovery (name, symbol, decimals, totalSupply)
 *   - Balance fetching via Multicall3 (batch) with individual fallback
 *   - Allowance reading for any spender
 *   - Token validation (bytecode, ERC-20 compliance)
 *   - Logo resolution with priority chain
 *   - Custom token import (persisted to localStorage)
 *   - Instant case-insensitive search
 *   - Metadata cache with TTL-based invalidation
 *   - Native ETH balance & gas balance
 *
 * Does NOT alter existing registries or Arc Testnet behavior.
 * Follows the project's IIFE module pattern for consistency.
 */
const RobinhoodTokenRegistry = (() => {
  'use strict';

  // ── Constants ──────────────────────────────────────────
  const RH_MAINNET = 4663;
  const RH_TESTNET  = 46630;
  const RH_CHAINS = [RH_MAINNET, RH_TESTNET];
  const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
  const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes metadata cache
  const BALANCE_TTL_MS = 30 * 1000;    // 30 seconds balance cache
  const STORAGE_KEY_IMPORTED = 'elligente_rh_imported_tokens';
  const STORAGE_KEY_DISCOVERED = 'elligente_rh_discovered_addrs';
  const DEV_LOG_ENABLED = (() => { try { return localStorage.getItem('arcpay_debug') === '1'; } catch (_) { return false; } })();

  // ── ERC-20 ABI fragments ───────────────────────────────
  const ERC20_ABI = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function totalSupply() view returns (uint256)',
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
  ];
  const MC_ABI = [
    'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[])',
  ];

  // ── Native ETH token definition ────────────────────────
  const NATIVE_ETH = {
    address: '0x0000000000000000000000000000000000000000',
    symbol: 'ETH',
    name: 'Ether',
    decimals: 18,
    isNative: true,
    verified: true,
    logo: null,
  };

  // ── Private state ──────────────────────────────────────
  let _metadataCache = {};   // address -> { name,symbol,decimals,totalSupply,ts }
  let _balanceCache = {};    // address -> { balance,formatted,usd,ts }
  let _allowanceCache = {};  // key -> { amount,ts }
  let _discoveredAddrs = []; // addresses discovered on-chain
  let _importedTokens = [];  // user-imported token objects

  // ── Logging ────────────────────────────────────────────
  function _log(tag, msg, data) {
    if (!DEV_LOG_ENABLED) return;
    try { console.log('[RHTokenRegistry][' + tag + ']', msg, data || ''); } catch (_) {}
  }

  function _warn(tag, msg, data) {
    if (!DEV_LOG_ENABLED) return;
    try { console.warn('[RHTokenRegistry][' + tag + ']', msg, data || ''); } catch (_) {}
  }

  // ── Storage helpers ────────────────────────────────────
  function _loadImported() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_IMPORTED);
      return raw ? JSON.parse(raw) : [];
    } catch (_) { return []; }
  }

  function _saveImported(tokens) {
    try { localStorage.setItem(STORAGE_KEY_IMPORTED, JSON.stringify(tokens)); } catch (_) {}
  }

  function _loadDiscovered() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_DISCOVERED);
      return raw ? JSON.parse(raw) : [];
    } catch (_) { return []; }
  }

  function _saveDiscovered(addrs) {
    try { localStorage.setItem(STORAGE_KEY_DISCOVERED, JSON.stringify(addrs)); } catch (_) {}
  }

  // ── Provider helper ────────────────────────────────────
  function _getProvider(chainId) {
    try {
      if (typeof getCachedProvider === 'function') {
        var chain = _getChain(chainId);
        if (chain && chain.rpc) return getCachedProvider(chain.rpc);
      }
      if (typeof ethers === 'undefined') return null;
      var rpc = chainId === RH_MAINNET
        ? 'https://rpc.mainnet.chain.robinhood.com'
        : 'https://rpc.testnet.chain.robinhood.com';
      return new ethers.JsonRpcProvider(rpc);
    } catch (_) { return null; }
  }

  function _getChain(chainId) {
    try {
      if (typeof CHAIN_REGISTRY !== 'undefined') return CHAIN_REGISTRY[chainId] || null;
      if (typeof CHAINS !== 'undefined') return CHAINS.find(function (c) { return c.chainId === chainId; }) || null;
    } catch (_) {}
    return null;
  }

  function _isRobinhood(chainId) {
    return chainId === RH_MAINNET || chainId === RH_TESTNET;
  }

  // ═══════════════════════════════════════════════════════
  //  METADATA CACHE
  // ═══════════════════════════════════════════════════════
  function _cacheMeta(addr, meta) {
    _metadataCache[addr.toLowerCase()] = { ...meta, ts: Date.now() };
  }

  function _cachedMeta(addr) {
    var key = addr.toLowerCase();
    var cached = _metadataCache[key];
    if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) return cached;
    return null;
  }

  function invalidateMeta(addr) {
    var key = addr ? addr.toLowerCase() : null;
    if (key) { delete _metadataCache[key]; _log('cache', 'Meta invalidated: ' + key); }
  }

  function clearMetadataCache() {
    _metadataCache = {};
    _log('cache', 'Metadata cache cleared');
  }

  // ═══════════════════════════════════════════════════════
  //  METADATA RETRIEVAL (dynamic, no hardcoding)
  // ═══════════════════════════════════════════════════════
  async function fetchTokenMetadata(tokenAddr, chainId) {
    if (!tokenAddr || tokenAddr === '0x0000000000000000000000000000000000000000') return NATIVE_ETH;
    var addr = tokenAddr.toLowerCase();
    // Return cached if fresh
    var cached = _cachedMeta(addr);
    if (cached) { _log('meta', 'Cache hit: ' + addr, cached); return cached; }
    // Native ETH
    if (addr === '0x0000000000000000000000000000000000000000') {
      _cacheMeta(addr, NATIVE_ETH);
      return NATIVE_ETH;
    }
    var prov = _getProvider(chainId);
    if (!prov) { _warn('meta', 'No provider for chain ' + chainId); return null; }
    try {
      var contract = new ethers.Contract(tokenAddr, ERC20_ABI, prov);
      var results;
      try {
        results = await Promise.all([
          contract.name().catch(function () { return null; }),
          contract.symbol().catch(function () { return null; }),
          contract.decimals().catch(function () { return null; }),
          contract.totalSupply().catch(function () { return null; }),
        ]);
      } catch (e) {
        // Sequential fallback
        var name = null, symbol = null, dec = null, supply = null;
        try { name = await contract.name(); } catch (_) {}
        try { symbol = await contract.symbol(); } catch (_) {}
        try { dec = await contract.decimals(); } catch (_) {}
        try { supply = await contract.totalSupply(); } catch (_) {}
        results = [name, symbol, dec, supply];
      }
      if (!results[1] && !results[0]) { _warn('meta', 'No symbol/name for ' + addr); return null; }
      var meta = {
        address: tokenAddr,
        name: results[0] || results[1] || 'Unknown Token',
        symbol: results[1] || results[0] || '???',
        decimals: typeof results[2] === 'number' ? results[2] : (results[2] !== null ? Number(results[2]) : 18),
        totalSupply: results[3] ? results[3].toString() : null,
        chainId: chainId,
        isNative: false,
        verified: false,
        logo: null,
      };
      _cacheMeta(addr, meta);
      _log('meta', 'Fetched: ' + meta.symbol + ' (' + addr + ')');
      return meta;
    } catch (e) {
      _warn('meta', 'Failed for ' + addr, e.message);
      return null;
    }
  }

  async function fetchNativeMetadata(chainId) {
    var chain = _getChain(chainId);
    return {
      address: '0x0000000000000000000000000000000000000000',
      name: chain ? (chain.nativeCurrency && chain.nativeCurrency.name) || 'Ether' : 'Ether',
      symbol: chain ? (chain.nativeCurrency && chain.nativeCurrency.symbol) || 'ETH' : 'ETH',
      decimals: chain ? (chain.nativeCurrency && chain.nativeCurrency.decimals) || 18 : 18,
      chainId: chainId,
      isNative: true,
      verified: true,
      logo: null,
    };
  }

  // ═══════════════════════════════════════════════════════
  //  TOKEN DISCOVERY
  // ═══════════════════════════════════════════════════════
  function getDiscoveredAddresses() {
    if (_discoveredAddrs.length === 0) _discoveredAddrs = _loadDiscovered();
    return _discoveredAddrs.slice();
  }

  function addDiscoveredAddress(addr) {
    var lower = addr.toLowerCase();
    if (_discoveredAddrs.indexOf(lower) === -1) {
      _discoveredAddrs.push(lower);
      _saveDiscovered(_discoveredAddrs);
      _log('discover', 'New address: ' + lower);
    }
  }

  async function discoverTokens(walletAddr, chainId, existingTxHashes) {
    if (!walletAddr || !_isRobinhood(chainId)) return [];
    _log('discover', 'Scanning for tokens on chain ' + chainId);

    var discovered = [];
    var known = getDiscoveredAddresses();

    // 1. From existing app token registry (per-chain tokens)
    try {
      var chain = _getChain(chainId);
      if (chain && chain.tokens) {
        Object.keys(chain.tokens).forEach(function (sym) {
          var t = chain.tokens[sym];
          if (t.address && t.address !== '0x0000000000000000000000000000000000000000') {
            var lower = t.address.toLowerCase();
            if (known.indexOf(lower) === -1) {
              known.push(lower);
              discovered.push(t.address);
            }
          }
        });
      }
    } catch (_) {}

    // 2. User-imported tokens
    try {
      var imported = getImportedTokens();
      imported.forEach(function (t) {
        if (t.chainId === chainId) {
          var lower = t.address.toLowerCase();
          if (known.indexOf(lower) === -1) {
            known.push(lower);
            discovered.push(t.address);
          }
        }
      });
    } catch (_) {}

    // 3. Previously discovered (from storage)
    try {
      var prevDiscovered = _loadDiscovered();
      prevDiscovered.forEach(function (addr) {
        if (known.indexOf(addr.toLowerCase()) === -1) {
          known.push(addr.toLowerCase());
          discovered.push(addr);
        }
      });
    } catch (_) {}

    _saveDiscovered(known);
    return discovered;
  }

  // ═══════════════════════════════════════════════════════
  //  BALANCE SERVICE (Multicall3 + individual fallback)
  // ═══════════════════════════════════════════════════════
  async function fetchNativeBalance(walletAddr, chainId) {
    var cacheKey = 'native_' + chainId + '_' + walletAddr.toLowerCase();
    var cached = _balanceCache[cacheKey];
    if (cached && (Date.now() - cached.ts) < BALANCE_TTL_MS) return cached;

    var prov = _getProvider(chainId);
    if (!prov) return { balance: 0n, formatted: 0, usd: 0, error: 'no-provider' };
    try {
      var raw = await prov.getBalance(walletAddr);
      var formatted = parseFloat(ethers.formatEther(raw));
      var result = { balance: raw, formatted: formatted, usd: 0, error: false, ts: Date.now() };
      _balanceCache[cacheKey] = result;
      return result;
    } catch (e) {
      return { balance: 0n, formatted: 0, usd: 0, error: e.message, ts: Date.now() };
    }
  }

  async function fetchBalances(walletAddr, chainId, tokenAddrs) {
    if (!walletAddr || !tokenAddrs || !tokenAddrs.length) return [];
    var prov = _getProvider(chainId);
    if (!prov) {
      return tokenAddrs.map(function (a) { return { address: a, balance: 0n, formatted: 0, error: 'no-provider' }; });
    }

    var tokens = [];
    var metaCacheHits = [];
    for (var i = 0; i < tokenAddrs.length; i++) {
      var addr = tokenAddrs[i];
      var meta = _cachedMeta(addr);
      if (!meta) {
        metaCacheHits.push(i);
        tokens.push({ address: addr, decimals: 18 });
      } else {
        tokens.push({ address: addr, decimals: meta.decimals || 18 });
      }
    }

    var results;
    // Try Multicall3 batch
    try {
      var erc20Iface = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
      var calls = tokens.map(function (t) {
        return {
          target: t.address,
          allowFailure: true,
          callData: erc20Iface.encodeFunctionData('balanceOf', [walletAddr]),
        };
      });
      var mc = new ethers.Contract(MULTICALL3, MC_ABI, prov);
      var mcResults = await mc.aggregate3(calls);
      results = tokens.map(function (t, idx) {
        var r = mcResults[idx];
        if (!r.success) return { address: t.address, balance: 0n, formatted: 0, error: true };
        var decoded = erc20Iface.decodeFunctionResult('balanceOf', r.returnData);
        var raw = decoded[0];
        return {
          address: t.address,
          balance: raw,
          formatted: parseFloat(ethers.formatUnits(raw, t.decimals)),
          error: false,
        };
      });
      _log('balance', 'Multicall3 batch complete, ' + results.length + ' tokens');
    } catch (e) {
      _warn('balance', 'Multicall3 failed, falling back to individual', e.message);
      // Individual fallback
      results = [];
      for (var j = 0; j < tokens.length; j++) {
        try {
          var contract = new ethers.Contract(tokens[j].address, ['function balanceOf(address) view returns (uint256)'], prov);
          var bal = await contract.balanceOf(walletAddr);
          results.push({
            address: tokens[j].address,
            balance: bal,
            formatted: parseFloat(ethers.formatUnits(bal, tokens[j].decimals)),
            error: false,
          });
        } catch (_) {
          results.push({ address: tokens[j].address, balance: 0n, formatted: 0, error: true });
        }
      }
    }

    // Cache results
    for (var k = 0; k < results.length; k++) {
      var r = results[k];
      var cacheKey = 'bal_' + chainId + '_' + r.address.toLowerCase() + '_' + walletAddr.toLowerCase();
      _balanceCache[cacheKey] = { ...r, ts: Date.now() };
    }

    // Fetch any uncached metadata
    if (metaCacheHits.length > 0) {
      for (var m = 0; m < metaCacheHits.length; m++) {
        var idx = metaCacheHits[m];
        fetchTokenMetadata(tokenAddrs[idx], chainId).catch(function () {});
      }
    }

    return results.filter(function (r) { return r.formatted > 0; });
  }

  function invalidateBalance(addr, walletAddr, chainId) {
    var key = 'bal_' + chainId + '_' + addr.toLowerCase() + '_' + walletAddr.toLowerCase();
    delete _balanceCache[key];
    var nkey = 'native_' + chainId + '_' + walletAddr.toLowerCase();
    delete _balanceCache[nkey];
    _log('balance', 'Invalidated: ' + addr);
  }

  function clearBalanceCache() {
    _balanceCache = {};
    _log('balance', 'Balance cache cleared');
  }

  // ═══════════════════════════════════════════════════════
  //  ALLOWANCE SERVICE
  // ═══════════════════════════════════════════════════════
  async function fetchAllowance(tokenAddr, ownerAddr, spenderAddr, chainId) {
    if (!tokenAddr || !ownerAddr || !spenderAddr) return { amount: 0n, error: 'missing-params' };
    var cacheKey = 'allow_' + chainId + '_' + tokenAddr.toLowerCase() + '_' + ownerAddr.toLowerCase() + '_' + spenderAddr.toLowerCase();
    var cached = _allowanceCache[cacheKey];
    if (cached && (Date.now() - cached.ts) < BALANCE_TTL_MS) return cached;

    var prov = _getProvider(chainId);
    if (!prov) return { amount: 0n, error: 'no-provider' };
    try {
      var contract = new ethers.Contract(tokenAddr, ERC20_ABI, prov);
      var raw = await contract.allowance(ownerAddr, spenderAddr);
      var result = { amount: raw, formatted: parseFloat(ethers.formatUnits(raw, 18)), error: false, ts: Date.now() };
      _allowanceCache[cacheKey] = result;
      return result;
    } catch (e) {
      return { amount: 0n, formatted: 0, error: e.message, ts: Date.now() };
    }
  }

  function invalidateAllowance(tokenAddr, ownerAddr, spenderAddr, chainId) {
    var key = 'allow_' + chainId + '_' + tokenAddr.toLowerCase() + '_' + ownerAddr.toLowerCase() + '_' + spenderAddr.toLowerCase();
    delete _allowanceCache[key];
  }

  function clearAllowanceCache() {
    _allowanceCache = {};
  }

  // ═══════════════════════════════════════════════════════
  //  TOKEN VALIDATION
  // ═══════════════════════════════════════════════════════
  async function validateToken(tokenAddr, chainId) {
    if (!tokenAddr || !ethers.isAddress(tokenAddr)) return { valid: false, reason: 'invalid-address' };
    if (tokenAddr === '0x0000000000000000000000000000000000000000') return { valid: true, reason: 'native', isNative: true };
    var prov = _getProvider(chainId);
    if (!prov) return { valid: false, reason: 'no-provider' };
    try {
      // Check bytecode exists
      var code = await prov.getCode(tokenAddr);
      if (!code || code === '0x') return { valid: false, reason: 'no-bytecode' };
      // Check ERC-20 interface compliance
      var meta = await fetchTokenMetadata(tokenAddr, chainId);
      if (!meta || !meta.symbol || meta.decimals === null) return { valid: false, reason: 'not-erc20' };
      if (meta.decimals < 0 || meta.decimals > 255) return { valid: false, reason: 'invalid-decimals' };
      return { valid: true, reason: 'ok', meta: meta };
    } catch (e) {
      return { valid: false, reason: 'validation-error: ' + e.message };
    }
  }

  // ═══════════════════════════════════════════════════════
  //  LOGO RESOLUTION
  // ═══════════════════════════════════════════════════════
  function resolveLogo(symbol, tokenAddr) {
    // 1. Existing app assets (known tokens)
    var tokenMeta = null;
    try {
      if (typeof UB_TOKEN_META !== 'undefined') tokenMeta = UB_TOKEN_META[symbol];
      if (!tokenMeta && typeof TOKEN_REGISTRY !== 'undefined') tokenMeta = TOKEN_REGISTRY[symbol];
    } catch (_) {}
    if (tokenMeta && tokenMeta.icon) return { type: 'text', value: tokenMeta.icon, color: tokenMeta.color || '#888' };

    // 2. Fallback: first character as generated icon
    var icon = (symbol && symbol.length > 0) ? symbol[0].toUpperCase() : '?';
    return {
      type: 'generated',
      value: icon,
      color: _colorForAddress(tokenAddr),
    };
  }

  function _colorForAddress(addr) {
    if (!addr) return '#888';
    var h = 0;
    for (var i = 2; i < Math.min(addr.length, 10); i++) {
      h = ((h << 5) - h + addr.charCodeAt(i)) | 0;
    }
    return 'hsl(' + (Math.abs(h) % 360) + ', 50%, 45%)';
  }

  // ═══════════════════════════════════════════════════════
  //  CUSTOM TOKEN IMPORT
  // ═══════════════════════════════════════════════════════
  function getImportedTokens() {
    if (_importedTokens.length === 0) _importedTokens = _loadImported();
    return _importedTokens.slice();
  }

  async function importToken(tokenAddr, chainId) {
    if (!chainId) return { success: false, error: 'Missing chain ID' };
    if (!_isRobinhood(chainId)) return { success: false, error: 'Not a Robinhood chain' };

    // Validate address
    if (!ethers.isAddress(tokenAddr)) return { success: false, error: 'Invalid token address' };

    var addrLower = tokenAddr.toLowerCase();

    // Check for duplicates
    if (_importedTokens.length === 0) _importedTokens = _loadImported();
    var existing = _importedTokens.find(function (t) { return t.address.toLowerCase() === addrLower && t.chainId === chainId; });
    if (existing) return { success: false, error: 'Token already imported' };

    // Validate on-chain
    var validation = await validateToken(tokenAddr, chainId);
    if (!validation.valid) return { success: false, error: 'Token validation failed: ' + validation.reason };

    // Fetch metadata
    var meta = await fetchTokenMetadata(tokenAddr, chainId);
    if (!meta) return { success: false, error: 'Could not fetch token metadata' };

    // Store
    var imported = {
      address: tokenAddr,
      chainId: chainId,
      name: meta.name,
      symbol: meta.symbol,
      decimals: meta.decimals,
      importedAt: Date.now(),
    };
    _importedTokens.push(imported);
    _saveImported(_importedTokens);
    addDiscoveredAddress(tokenAddr);
    _log('import', 'Imported: ' + meta.symbol + ' (' + addrLower + ')');
    return { success: true, token: imported };
  }

  function removeImportedToken(tokenAddr, chainId) {
    var addrLower = tokenAddr.toLowerCase();
    _importedTokens = _loadImported();
    _importedTokens = _importedTokens.filter(function (t) { return !(t.address.toLowerCase() === addrLower && t.chainId === chainId); });
    _saveImported(_importedTokens);
    _log('import', 'Removed: ' + addrLower);
    return true;
  }

  // ═══════════════════════════════════════════════════════
  //  TOKEN SEARCH
  // ═══════════════════════════════════════════════════════
  function searchTokens(query, chainId) {
    if (!query || query.trim().length === 0) return getAllKnownTokens(chainId);
    var q = query.toLowerCase().trim();
    var all = getAllKnownTokens(chainId);
    return all.filter(function (t) {
      return (t.name && t.name.toLowerCase().indexOf(q) !== -1) ||
             (t.symbol && t.symbol.toLowerCase().indexOf(q) !== -1) ||
             (t.address && t.address.toLowerCase().indexOf(q) !== -1);
    });
  }

  function getAllKnownTokens(chainId) {
    var tokens = [];
    // Native ETH
    tokens.push({
      address: '0x0000000000000000000000000000000000000000',
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
      chainId: chainId,
      isNative: true,
      verified: true,
      logo: resolveLogo('ETH'),
    });
    // From per-chain config
    try {
      var chain = _getChain(chainId);
      if (chain && chain.tokens) {
        Object.keys(chain.tokens).forEach(function (sym) {
          var t = chain.tokens[sym];
          if (t.address && t.address !== '0x0000000000000000000000000000000000000000' && sym !== 'ETH') {
            tokens.push({
              address: t.address,
              name: sym,
              symbol: sym,
              decimals: t.decimals || 18,
              chainId: chainId,
              isNative: false,
              verified: true,
              logo: resolveLogo(sym, t.address),
            });
          }
        });
      }
    } catch (_) {}
    // Imported tokens
    var imported = getImportedTokens();
    imported.forEach(function (t) {
      if (t.chainId === chainId) {
        var idx = tokens.findIndex(function (x) { return x.address.toLowerCase() === t.address.toLowerCase(); });
        var entry = {
          address: t.address,
          name: t.name,
          symbol: t.symbol,
          decimals: t.decimals,
          chainId: chainId,
          isNative: false,
          verified: false,
          imported: true,
          logo: resolveLogo(t.symbol, t.address),
        };
        if (idx === -1) tokens.push(entry); else tokens[idx] = entry;
      }
    });
    // Discovered from cache
    Object.keys(_metadataCache).forEach(function (addr) {
      var m = _metadataCache[addr];
      if (!m || m.chainId !== chainId) return;
      var idx = tokens.findIndex(function (x) { return x.address.toLowerCase() === addr; });
      if (idx === -1) {
        tokens.push({
          address: m.address,
          name: m.name,
          symbol: m.symbol,
          decimals: m.decimals,
          chainId: chainId,
          isNative: false,
          verified: m.verified,
          discovered: true,
          logo: resolveLogo(m.symbol, m.address),
        });
      }
    });
    return tokens;
  }

  // ═══════════════════════════════════════════════════════
  //  UNIFIED BALANCE INTEGRATION
  // ═══════════════════════════════════════════════════════
  async function getPortfolioForChain(walletAddr, chainId) {
    if (!walletAddr || !_isRobinhood(chainId)) return { assets: [], totalUSD: 0 };

    var assets = [];
    var totalUSD = 0;

    // 1. Native ETH
    try {
      var native = await fetchNativeBalance(walletAddr, chainId);
      if (native.formatted > 0) {
        var chain = _getChain(chainId);
        assets.push({
          token: 'ETH',
          tokenName: 'Ether',
          icon: '<svg viewBox="0 0 32 32" width="12" height="12"><path d="M16 4v10l-8 4 8-4 8 4-8-4V4zM16 20l-8-4 8 10 8-10-8 4z" fill="white"/></svg>',
          color: '#627eea',
          chainId: chain ? (chain.id || chain.name) : ('Robinhood_' + chainId),
          chainName: chain ? (chain.shortName || chain.name) : 'Robinhood',
          balance: native.formatted,
          usd: 0,
          address: '0x0000000000000000000000000000000000000000',
        });
      }
    } catch (_) {}

    // 2. Discover ERC-20 tokens
    try {
      var discovered = await discoverTokens(walletAddr, chainId);
      if (discovered.length > 0) {
        var balances = await fetchBalances(walletAddr, chainId, discovered);
        for (var i = 0; i < balances.length; i++) {
          var b = balances[i];
          if (b.formatted <= 0) continue;
          var meta = _cachedMeta(b.address) || await fetchTokenMetadata(b.address, chainId).catch(function () { return null; });
          if (!meta) continue;
          var logo = resolveLogo(meta.symbol, b.address);
          var chain = _getChain(chainId);
          assets.push({
            token: meta.symbol,
            tokenName: meta.name,
            icon: logo.value,
            color: logo.color,
            chainId: chain ? (chain.id || chain.name) : ('Robinhood_' + chainId),
            chainName: chain ? (chain.shortName || chain.name) : 'Robinhood',
            balance: b.formatted,
            usd: 0,
            address: b.address,
          });
        }
      }
    } catch (_) {}

    return { assets: assets, totalUSD: totalUSD };
  }

  async function injectIntoUnifiedBalance() {
    if (typeof walletAddress === 'undefined' || !walletAddress) return;
    if (typeof UB === 'undefined' || !UB.state) return;

    for (var i = 0; i < RH_CHAINS.length; i++) {
      try {
        var portfolio = await getPortfolioForChain(walletAddress, RH_CHAINS[i]);
        for (var j = 0; j < portfolio.assets.length; j++) {
          var asset = portfolio.assets[j];
          // Avoid duplicates if UB already has this chain+token
          var dup = UB.state.assets.find(function (a) {
            return a.token === asset.token && a.chainId === asset.chainId;
          });
          if (!dup) {
            UB.state.assets.push(asset);
            UB.state.totalUSD += asset.usd;
          }
        }
      } catch (_) {}
    }
  }

  // ═══════════════════════════════════════════════════════
  //  TRANSACTION SYNC
  // ═══════════════════════════════════════════════════════
  function onTransactionComplete(txData) {
    if (!txData || !txData.chainId) return;
    if (!_isRobinhood(txData.chainId)) return;
    // Invalidate affected balances
    if (txData.tokenAddr) invalidateBalance(txData.tokenAddr, txData.from || walletAddress, txData.chainId);
    // Also invalidate native for gas changes
    var wallet = txData.from || (typeof walletAddress !== 'undefined' ? walletAddress : null);
    if (wallet) {
      var nkey = 'native_' + txData.chainId + '_' + wallet.toLowerCase();
      delete _balanceCache[nkey];
    }
    _log('sync', 'Balances invalidated after tx');
  }

  // ═══════════════════════════════════════════════════════
  //  PUBLIC API
  // ═══════════════════════════════════════════════════════
  return {
    // Constants
    MAINNET: RH_MAINNET,
    TESTNET: RH_TESTNET,
    CHAINS: RH_CHAINS,
    NATIVE_ETH: NATIVE_ETH,

    // Metadata
    fetchTokenMetadata: fetchTokenMetadata,
    fetchNativeMetadata: fetchNativeMetadata,
    invalidateMeta: invalidateMeta,
    clearMetadataCache: clearMetadataCache,

    // Discovery
    discoverTokens: discoverTokens,
    getDiscoveredAddresses: getDiscoveredAddresses,
    addDiscoveredAddress: addDiscoveredAddress,

    // Balances
    fetchNativeBalance: fetchNativeBalance,
    fetchBalances: fetchBalances,
    invalidateBalance: invalidateBalance,
    clearBalanceCache: clearBalanceCache,

    // Allowances
    fetchAllowance: fetchAllowance,
    invalidateAllowance: invalidateAllowance,
    clearAllowanceCache: clearAllowanceCache,

    // Validation
    validateToken: validateToken,

    // Logo
    resolveLogo: resolveLogo,

    // Import
    getImportedTokens: getImportedTokens,
    importToken: importToken,
    removeImportedToken: removeImportedToken,

    // Search
    searchTokens: searchTokens,
    getAllKnownTokens: getAllKnownTokens,

    // Portfolio / UB integration
    getPortfolioForChain: getPortfolioForChain,
    injectIntoUnifiedBalance: injectIntoUnifiedBalance,

    // Transaction sync
    onTransactionComplete: onTransactionComplete,

    // Utilities
    isRobinhood: _isRobinhood,
    getChain: _getChain,
    getProvider: _getProvider,
  };
})();

if (typeof window !== 'undefined') window.RobinhoodTokenRegistry = RobinhoodTokenRegistry;
