/**
 * FastBalanceEngine — fast, chain-aware balance loader for NON-Arc EVM networks.
 * ═══════════════════════════════════════════════════════════════════════════
 * Phase 1.4 — surgical performance layer for the Swap token selector.
 *
 * ARC MAINNET (5042) IS DELIBERATELY OUT OF SCOPE. Arc already loads fast and its
 * native USDC / gas accounting must never be altered. This engine refuses to touch
 * Arc: `getTokenBalance` for Arc transparently delegates to BalanceService, so the
 * Arc read path, cache and classification are byte-for-byte unchanged.
 *
 * For the supported non-Arc EVM networks (Ethereum 1, Base 8453, Arbitrum 42161,
 * Optimism 10, Polygon 137) it provides:
 *   - Bounded concurrency (no thundering herd of 50 simultaneous RPC calls).
 *   - In-flight request coalescing (identical reads share one Promise).
 *   - Optional Etherscan V2 (server-side proxy) as a RELIABILITY fallback for
 *     eligible chains, with RPC remaining the authoritative read path.
 *
 * It reads THROUGH BalanceService (never a second independent read path) and
 * reuses its cache, providers, native/ERC-20 classification and timeouts.
 *
 * Attached to window.FastBalanceEngine.
 */
(function () {
  'use strict';

  if (typeof window !== 'undefined' && window.FastBalanceEngine) return;

  var ARC_CHAIN_ID = 5042;

  // Non-Arc EVM networks accelerated by this engine.
  var SUPPORTED = { 1: true, 8453: true, 42161: true, 10: true, 137: true };

  // Etherscan V2 free-tier eligible chains. Base/Optimism/Arc are intentionally
  // excluded (free-tier availability is NOT assumed for them — they use RPC).
  var ETHERSCAN_ELIGIBLE = { 1: true, 42161: true, 137: true };

  var CONCURRENCY = 5;               // bounded reads in flight per render
  var ETHERSCAN_TIMEOUT_MS = 3500;   // soft timeout for the server proxy
  var INFLIGHT_TTL_MS = 15000;       // safety net for stuck in-flight entries

  var _inflight = {};                // key -> { promise, ts }

  function _isAddr(v) {
    return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
  }
  function _normAddr(a) {
    if (!a) return '';
    return String(a).toLowerCase();
  }
  function _key(address, tokenAddr, chainId) {
    return _normAddr(address) + '::' + (tokenAddr ? _normAddr(tokenAddr) : 'native') + '::' + Number(chainId);
  }
  function _tokenAddr(token) {
    if (token && typeof token === 'object' && token.address) return _normAddr(token.address);
    return null;
  }
  function _tokenDecimals(token) {
    var d = (token && token.decimals != null) ? Number(token.decimals) : null;
    return (d != null && Number.isFinite(d) && d >= 0) ? d : 18;
  }

  function isSupported(chainId) { return !!SUPPORTED[Number(chainId)]; }
  function canUseEtherscan(chainId) { return !!ETHERSCAN_ELIGIBLE[Number(chainId)]; }

  /* ════════════════════════════════════════════
     RAW → FORMATTED STRING (full precision, display-agnostic)
  ════════════════════════════════════════════ */
  function _fmtRaw(raw, decimals) {
    try {
      var d = _tokenDecimals({ decimals: decimals });
      if (typeof ethers !== 'undefined' && ethers.formatUnits) {
        return ethers.formatUnits(BigInt(String(raw)), d);
      }
      // Manual fallback (no ethers): bigint string → decimal string.
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
  ════════════════════════════════════════════ */
  function _readEtherscan(address, token, chainId) {
    var addr = _tokenAddr(token);
    var url = '/api/balance/etherscan?chainid=' + Number(chainId) +
      '&address=' + encodeURIComponent(address);
    if (addr) url += '&contractaddress=' + encodeURIComponent(addr);

    var fetchP = fetch(url, { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        // Server returns { ok:true, balance:"<raw>" } on success. Anything else
        // (error, rate-limit, unsupported) is treated as unavailable — never a
        // fabricated zero.
        if (d && d.ok && d.balance != null && d.balance !== '') return String(d.balance);
        return null;
      });

    var timeoutP = new Promise(function (_, reject) {
      setTimeout(function () { reject(new Error('etherscan timeout')); }, ETHERSCAN_TIMEOUT_MS);
    });

    return Promise.race([fetchP, timeoutP]).catch(function () { return null; });
  }

  /* ════════════════════════════════════════════
     CORE READ — RPC authoritative, Etherscan as reliability fallback
  ════════════════════════════════════════════ */
  function _read(address, token, id) {
    var bs = (typeof BalanceService !== 'undefined' && BalanceService.getTokenBalance)
      ? BalanceService.getTokenBalance(address, token, id)
      : Promise.resolve(null);

    // Arc is handled by the caller (never reaches here for 5042).
    if (!canUseEtherscan(id)) return bs;

    // RPC first (authoritative). Only if RPC fails do we consult Etherscan —
    // this preserves RPC as the source of truth and avoids parallel duplicate
    // reads to every provider by default.
    return bs.then(function (rpcRaw) {
      if (rpcRaw != null) return rpcRaw;
      return _readEtherscan(address, token, id).then(function (raw) {
        return raw != null ? _fmtRaw(raw, _tokenDecimals(token)) : null;
      });
    });
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

    var key = _key(address, _tokenAddr(token), id);
    var now = Date.now();
    var entry = _inflight[key];
    if (entry && (now - entry.ts) < INFLIGHT_TTL_MS) return entry.promise;

    var p = _read(address, token, id).then(function (raw) {
      delete _inflight[key];
      return raw;
    }, function () {
      delete _inflight[key];
      return null;
    });
    _inflight[key] = { promise: p, ts: now };
    return p;
  }

  /* ════════════════════════════════════════════
     PUBLIC — priority + bounded-concurrency batch scheduler
  ════════════════════════════════════════════ */
  /**
   * @param {string} address   wallet address
   * @param {Array}  items     [{ t, i }] sorted by priority (ascending)
   * @param {number} chainId   non-Arc EVM chain
   * @param {Function} onResult (i, t, balString) called per settled read
   * @param {number} [concurrency]
   * @returns {Promise<Array<{i, bal}>>} all results (for re-sort)
   */
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

  /** Clear all in-flight entries (call on wallet/account change). */
  function reset() {
    _inflight = {};
  }

  /** @public */
  window.FastBalanceEngine = {
    VERSION: '1.0.0',
    ARC_CHAIN_ID: ARC_CHAIN_ID,
    DEFAULT_CONCURRENCY: CONCURRENCY,
    isSupported: isSupported,
    canUseEtherscan: canUseEtherscan,
    getTokenBalance: getTokenBalance,
    schedule: schedule,
    reset: reset
  };
})();
