/**
 * FastBalanceEngine — fast, chain-aware balance loader for NON-Arc EVM networks.
 * ═══════════════════════════════════════════════════════════════════════════
 * Phase 1.4 / 1.4.2 — surgical performance layer for the Swap token selector.
 *
 * ARC MAINNET (5042) IS DELIBERATELY OUT OF SCOPE. Arc already loads fast and its
 * native USDC / gas accounting must never be altered. This engine refuses to touch
 * Arc: `getTokenBalance` for Arc transparently delegates to BalanceService, so the
 * Arc read path, cache and classification are byte-for-byte unchanged.
 *
 * Provider selection for non-Arc EVM (Ethereum 1, Base 8453, Arbitrum 42161,
 * Optimism 10, Polygon 137):
 *
 *   Alchemy (if ALCHEMY_BALANCE_ENABLED && eligible)  →  primary
 *     └─ RPC (BalanceService)                          →  fallback
 *         └─ Etherscan V2 (eligible chains only)       →  secondary fallback
 *
 *   Without the flag (default): RPC → Etherscan (Phase 1.4 behavior).
 *
 * Alchemy is behind a configurable feature flag (`window.ALCHEMY_BALANCE_ENABLED`
 * === true), DEFAULT DISABLED, so it can be rolled back without any deployment of
 * unrelated changes.
 *
 * It reads THROUGH BalanceService (never a second independent read path for RPC)
 * and reuses its cache, providers, native/ERC-20 classification and timeouts.
 *
 * Attached to window.FastBalanceEngine.
 */
(function () {
  'use strict';

  if (typeof window !== 'undefined' && window.FastBalanceEngine) return;

  var ARC_CHAIN_ID = 5042;

  // Non-Arc EVM networks accelerated by this engine.
  var SUPPORTED = { 1: true, 8453: true, 42161: true, 10: true, 137: true };

  // Etherscan V2 free-tier eligible chains (Ethereum, Arbitrum, Polygon).
  var ETHERSCAN_ELIGIBLE = { 1: true, 42161: true, 137: true };

  // Alchemy-eligible chains (all five non-Arc targets). Arc is NEVER here.
  var ALCHEMY_ELIGIBLE = { 1: true, 8453: true, 42161: true, 10: true, 137: true };

  var CONCURRENCY = 5;               // bounded reads in flight per render
  var ETHERSCAN_TIMEOUT_MS = 3500;   // soft timeout for the Etherscan proxy
  var ALCHEMY_TIMEOUT_MS = 3500;     // soft timeout for the Alchemy proxy
  var INFLIGHT_TTL_MS = 15000;       // safety net for stuck in-flight entries

  var ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  var ETH_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

  var _inflight = {};                // key -> { promise, ts }

  // Display-only cache (stale-while-revalidate). NEVER used for MAX/approval/
  // execution — it only makes the token picker render instantly. Keyed by
  // wallet + chain + canonical token identity.
  var _displayCache = {};
  var DISPLAY_CACHE_TTL_MS = 60000;  // stale-while-revalidate window (display only)

  function _isAddr(v) {
    return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
  }
  function _normAddr(a) {
    if (!a) return '';
    return String(a).toLowerCase();
  }
  function _tokenAddr(token) {
    if (token && typeof token === 'object' && token.address) return _normAddr(token.address);
    return null;
  }
  function _tokenDecimals(token) {
    var d = (token && token.decimals != null) ? Number(token.decimals) : null;
    return (d != null && Number.isFinite(d) && d >= 0) ? d : 18;
  }

  // P7 fix — canonical token identity: distinguishes native vs ERC-20 and includes
  // the representation decimals so incompatible identities never share a dedup key.
  function _isNativeToken(token) {
    var addr = _tokenAddr(token);
    return !addr || addr === ZERO_ADDRESS || addr === ETH_SENTINEL;
  }
  function _tokenIdentity(token) {
    if (_isNativeToken(token)) return 'native';
    return _tokenAddr(token) + '::' + _tokenDecimals(token);
  }
  function _key(address, token, chainId) {
    return _normAddr(address) + '::' + _tokenIdentity(token) + '::' + Number(chainId);
  }

  function isSupported(chainId) { return !!SUPPORTED[Number(chainId)]; }
  function canUseEtherscan(chainId) { return !!ETHERSCAN_ELIGIBLE[Number(chainId)]; }
  function canUseAlchemy(chainId) { return !!ALCHEMY_ELIGIBLE[Number(chainId)]; }

  // P5 — feature flag, DEFAULT DISABLED. Enable only after integration checks.
  function _alchemyEnabled() {
    try { return typeof window !== 'undefined' && window.ALCHEMY_BALANCE_ENABLED === true; } catch (_) { return false; }
  }

  /* ════════════════════════════════════════════
     RAW → FORMATTED STRING (full precision, display-agnostic)
  ════════════════════════════════════════════ */
  function _fmtRaw(raw, decimals) {
    try {
      var d = Number(decimals);
      if (!Number.isFinite(d) || d < 0) d = 18;
      if (typeof ethers !== 'undefined' && ethers.formatUnits) {
        return ethers.formatUnits(BigInt(String(raw)), d);
      }
      var s = String(raw);
      if (d === 0) return s;
      while (s.length <= d) s = '0' + s;
      return s.slice(0, s.length - d) + '.' + s.slice(s.length - d);
    } catch (_) {
      return null;
    }
  }

  /* ════════════════════════════════════════════
     ETHERSCAN V2 (server-side proxy — key never reaches the browser)
     P7 fix: native tokens use action=balance (NO contractaddress); only real
     ERC-20 addresses use action=tokenbalance.
  ════════════════════════════════════════════ */
  function _readEtherscan(address, token, chainId) {
    var isNative = _isNativeToken(token);
    var url = '/api/balance/etherscan?chainid=' + Number(chainId) +
      '&address=' + encodeURIComponent(address);
    if (!isNative) url += '&contractaddress=' + encodeURIComponent(_tokenAddr(token));

    var fetchP = fetch(url, { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok && d.balance != null && d.balance !== '') return String(d.balance);
        return null;
      });
    var timeoutP = new Promise(function (_, reject) {
      setTimeout(function () { reject(new Error('etherscan timeout')); }, ETHERSCAN_TIMEOUT_MS);
    });
    return Promise.race([fetchP, timeoutP]).catch(function () { return null; });
  }

  /* ════════════════════════════════════════════
     ALCHEMY (server-side proxy — key never reaches the browser)
     Native → eth_getBalance; ERC-20 → alchemy_getTokenBalances.
  ════════════════════════════════════════════ */
  function _readAlchemy(address, token, chainId) {
    var isNative = _isNativeToken(token);
    var body = { chainid: Number(chainId), address: address };
    if (!isNative) body.contract = _tokenAddr(token);

    var fetchP = fetch('/api/balance/alchemy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); }).then(function (d) {
      // Server returns { ok:true, balance:"<decimal string>" }. Any error/rate-
      // limit/unsupported is unavailable — never a fabricated zero.
      if (d && d.ok && d.balance != null && d.balance !== '') return String(d.balance);
      return null;
    });
    var timeoutP = new Promise(function (_, reject) {
      setTimeout(function () { reject(new Error('alchemy timeout')); }, ALCHEMY_TIMEOUT_MS);
    });
    return Promise.race([fetchP, timeoutP]).catch(function () { return null; });
  }

  /* ════════════════════════════════════════════
     PROVIDER SELECTION (P5)
     Alchemy (flag) → RPC (authoritative) → Etherscan (eligible).
     RPC is created LAZILY so Alchemy success avoids the RPC call entirely.
  ════════════════════════════════════════════ */
  function _rpcRead(address, token, id) {
    if (typeof BalanceService !== 'undefined' && BalanceService.getTokenBalance) {
      return BalanceService.getTokenBalance(address, token, id);
    }
    return Promise.resolve(null);
  }

  function _read(address, token, id) {
    if (_alchemyEnabled() && canUseAlchemy(id)) {
      return _readAlchemy(address, token, id).then(function (alRaw) {
        if (alRaw != null) return _fmtRaw(alRaw, _tokenDecimals(token));
        // Alchemy unavailable → RPC → (Etherscan).
        return _rpcRead(address, token, id).then(function (rpcRaw) {
          if (rpcRaw != null) return rpcRaw;
          if (canUseEtherscan(id)) {
            return _readEtherscan(address, token, id).then(function (raw) {
              return raw != null ? _fmtRaw(raw, _tokenDecimals(token)) : null;
            });
          }
          return null;
        });
      });
    }

    // Default (no Alchemy): RPC → Etherscan.
    var bs = _rpcRead(address, token, id);
    if (canUseEtherscan(id)) {
      return bs.then(function (rpcRaw) {
        if (rpcRaw != null) return rpcRaw;
        return _readEtherscan(address, token, id).then(function (raw) {
          return raw != null ? _fmtRaw(raw, _tokenDecimals(token)) : null;
        });
      });
    }
    return bs;
  }

  /* ════════════════════════════════════════════
     PUBLIC — single read with in-flight dedup
  ════════════════════════════════════════════ */
  function getTokenBalance(address, token, chainId) {
    if (!_isAddr(address)) return Promise.resolve(null);
    var id = Number(chainId);
    if (!Number.isFinite(id)) return Promise.resolve(null);

    // Arc → delegate to BalanceService, its pipeline is NEVER touched.
    if (id === ARC_CHAIN_ID) {
      if (typeof BalanceService !== 'undefined' && BalanceService.getTokenBalance) {
        return BalanceService.getTokenBalance(address, token, id);
      }
      return Promise.resolve(null);
    }

    var key = _key(address, token, id);
    var now = Date.now();
    var entry = _inflight[key];
    if (entry && (now - entry.ts) < INFLIGHT_TTL_MS) return entry.promise;

    var p = _read(address, token, id).then(function (raw) {
      delete _inflight[key];
      if (raw != null) {
        // Cache the confirmed value for instant (stale-while-revalidate) display.
        _displayCache[key] = { value: String(raw), ts: now };
      }
      return raw;
    }, function () {
      delete _inflight[key];
      return null;
    });
    _inflight[key] = { promise: p, ts: now };
    return p;
  }

  /* ════════════════════════════════════════════
     PUBLIC — synchronous cached read (P3 instant display)
  ════════════════════════════════════════════ */
  /**
   * Return a previously confirmed formatted balance WITHOUT fetching, so the
   * token picker can render immediately and refresh in the background.
   * Returns null when nothing is cached (caller shows "—"/loading).
   */
  function getCachedBalance(address, token, chainId) {
    if (!_isAddr(address)) return null;
    var id = Number(chainId);
    if (!Number.isFinite(id)) return null;
    var entry = _displayCache[_key(address, token, id)];
    if (!entry) return null;
    if (Date.now() - entry.ts > DISPLAY_CACHE_TTL_MS) return null;
    return entry.value;
  }

  /* ════════════════════════════════════════════
     PUBLIC — priority + bounded-concurrency batch scheduler
  ════════════════════════════════════════════ */
  function schedule(address, items, chainId, onResult, concurrency) {
    var limit = Math.max(1, Math.min(concurrency || CONCURRENCY, items.length));
    var queue = items.slice();
    var results = [];

    return new Promise(function (resolve) {
      var running = 0;

      function pump() {
        if (queue.length === 0) {
          if (running === 0) resolve(results);
          return;
        }
        var item = queue.shift();
        running++;
        var tokenArg = { address: item.t.address, symbol: item.t.symbol, decimals: item.t.decimals };
        getTokenBalance(address, tokenArg, chainId)
          .then(function (raw) {
            var bal = (raw != null) ? String(raw) : null;
            results.push({ i: item.i, bal: bal });
            if (typeof onResult === 'function') {
              try { onResult(item.i, item.t, bal); } catch (_) {}
            }
          })
          .catch(function () {
            results.push({ i: item.i, bal: null });
            if (typeof onResult === 'function') {
              try { onResult(item.i, item.t, null); } catch (_) {}
            }
          })
          .finally(function () {
            running--;
            pump();
          });
      }

      for (var n = 0; n < limit; n++) pump();
    });
  }

  /** Clear all in-flight + display-cache entries (call on wallet/account change). */
  function reset() {
    _inflight = {};
    _displayCache = {};
  }

  /** @public */
  window.FastBalanceEngine = {
    VERSION: '1.1.0',
    ARC_CHAIN_ID: ARC_CHAIN_ID,
    DEFAULT_CONCURRENCY: CONCURRENCY,
    isSupported: isSupported,
    canUseEtherscan: canUseEtherscan,
    canUseAlchemy: canUseAlchemy,
    getTokenBalance: getTokenBalance,
    getCachedBalance: getCachedBalance,
    schedule: schedule,
    reset: reset
  };
})();
