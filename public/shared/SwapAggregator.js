/**
 * SwapAggregator — orchestrator that compares Tower + local pools and selects
 * the best execution for the user.
 * ═══════════════════════════════════════════════════════════════════════
 * QUOTE EVERYTHING, EXECUTE ONLY WHAT IS SAFE.
 *
 * Both sources are ALWAYS quoted independently (in parallel), regardless of
 * whether a local pool exists — a local pool is NEVER a reason to skip the
 * Tower quote. A rejection/timeout in one source never breaks the other.
 *
 * QUOTE availability is separate from EXECUTION availability:
 *   - bestQuote           → highest expectedOutRaw (any valid quote, reference)
 *   - bestExecutableQuote → highest expectedOutRaw among quotes that can be
 *                           executed by the Elligentt execution path.
 * Tower executability is determined SOLELY by the full validity of the Tower
 * route (calldata/target/spender + quote validation). The existence of a local
 * Arc pool NEVER makes Tower non-executable: Tower and Elligentt are INDEPENDENT
 * providers/roles that are quoted and compared side-by-side in the UI.
 *
 * Deterministic selection:
 *   1. primary  — highest expectedOutRaw (net token output)
 *   2. tiebreak — highest minOutRaw (safest floor)
 *   3. tiebreak — lowest feeBps
 *
 * Gas is intentionally NOT factored in (no reliable estimate exists for the
 * local path); this is documented, not guessed. Only verified data is used.
 *
 * Attached to window.SwapAggregator
 */
(function () {
  'use strict';

  if (typeof window !== 'undefined' && window.SwapAggregator) return;

  function positiveBig(v) {
    try { return typeof v === 'bigint' && v > 0n; } catch (_) { return false; }
  }

  var ZERO_ADDR = '0x0000000000000000000000000000000000000000';

  /**
   * Whether an external (Tower / LI.FI) quote carries the fields required to be
   * EXECUTED (valid calldata, non-zero target, valid spender). This mirrors the
   * execution guard in executeSwap; a reference quote without these is never
   * executable.
   */
  function externalExecutionValid(q) {
    if (!q || !q.calldata || !/^0x[0-9a-fA-F]+$/.test(q.calldata)) return false;
    if (!q.to || !/^0x[0-9a-fA-F]{40}$/.test(q.to) || q.to === ZERO_ADDR) return false;
    if (q.spender != null && (!/^0x[0-9a-fA-F]{40}$/.test(q.spender) || q.spender === ZERO_ADDR)) return false;
    return true;
  }

  // Backward-compatible alias (Tower-only semantics preserved).
  function towerExecutionValid(q) { return externalExecutionValid(q); }

  /** Shared deterministic comparator: expectedOutRaw desc → minOutRaw desc → feeBps asc. */
  function byBetter(a, b) {
    if (a.expectedOutRaw !== b.expectedOutRaw) return (a.expectedOutRaw > b.expectedOutRaw) ? -1 : 1;
    if (a.minOutRaw !== b.minOutRaw) return (a.minOutRaw > b.minOutRaw) ? -1 : 1;
    return ((a.feeBps || 0) - (b.feeBps || 0));
  }

  /**
   * Wrap a quote promise so it settles (never hangs) after `ms`, returning the
   * fallback. A slow source is isolated: it cannot block the other source beyond
   * the timeout.
   */
  function withTimeout(promise, ms, fallback) {
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        resolve(fallback);
      }, ms);
      promise.then(function (v) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      }, function (e) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(Object.assign({}, fallback, { error: (e && e.message) || 'QUOTE_REJECTED' }));
      });
    });
  }

  /**
   * Deterministic best-quote selection from a list of normalized quotes.
   * @param {Array<object>} quotes normalized quotes (source, ok, expectedOutRaw, minOutRaw, ...)
   * @returns {{ok:boolean, best?:object, alternatives?:object[], reason?:string, quotes:object[]}}
   */
  function pickBest(quotes) {
    quotes = quotes || [];
    var valid = [];
    for (var i = 0; i < quotes.length; i++) {
      var q = quotes[i];
      if (!q || q.ok !== true) continue;
      if (!positiveBig(q.expectedOutRaw)) continue;
      if (!positiveBig(q.minOutRaw)) continue;
      valid.push(q);
    }

    if (valid.length === 0) {
      return { ok: false, reason: 'NO_ROUTE_AVAILABLE', quotes: quotes.slice() };
    }

    valid.sort(byBetter);

    return { ok: true, best: valid[0], alternatives: valid.slice(1), quotes: quotes.slice() };
  }

  /**
   * Deterministic selection of the best EXECUTABLE quote (same ordering rule,
   * but only quotes with `executable === true` are considered). This is the only
   * quote the UI may ever promise/execute.
   */
  function pickBestExecutable(quotes) {
    quotes = quotes || [];
    var valid = [];
    for (var i = 0; i < quotes.length; i++) {
      var q = quotes[i];
      if (!q || q.ok !== true) continue;
      if (q.executable !== true) continue;
      if (!positiveBig(q.expectedOutRaw)) continue;
      if (!positiveBig(q.minOutRaw)) continue;
      valid.push(q);
    }

    if (valid.length === 0) {
      return { ok: false, reason: 'NO_EXECUTABLE_ROUTE', quotes: quotes.slice() };
    }

    valid.sort(byBetter);

    return { ok: true, best: valid[0], alternatives: valid.slice(1), quotes: quotes.slice() };
  }

  /**
   * Validate a quote against the requested parameters. A quote that does not
   * match the request is rejected. chainId / tokenIn / tokenOut / amountInRaw
   * are MANDATORY — a quote missing any of them is INVALID (not comparable).
   * A stale (expired) quote is also rejected.
   */
  function _tokenKey(t) {
    // Normalize a token (string sym or object) to a comparable key.
    if (!t) return null;
    if (typeof t === 'object') return (t.address || '').toLowerCase() + ':' + String(t.chainId || '');
    return String(t);
  }

  function validateAgainst(q, opts) {
    if (!q || q.ok !== true) return false;
    // Token comparison: accepts both symbol-strings and token objects.
    if (opts.tokenIn != null) {
      var reqKey = _tokenKey(opts.tokenIn);
      var gotKey = _tokenKey(q.tokenIn);
      // Also compare by tokenInAddr when the quote carries it.
      var gotAddr = q.tokenInAddr ? q.tokenInAddr.toLowerCase() : null;
      var reqAddr = (typeof opts.tokenIn === 'object' && opts.tokenIn && opts.tokenIn.address) ? opts.tokenIn.address.toLowerCase() : null;
      if (reqAddr && gotAddr && reqAddr !== gotAddr) return false;
      if (!reqAddr && !gotAddr && gotKey !== reqKey) return false;
    }
    if (opts.tokenOut != null) {
      var reqKeyO = _tokenKey(opts.tokenOut);
      var gotKeyO = _tokenKey(q.tokenOut);
      var gotAddrO = q.tokenOutAddr ? q.tokenOutAddr.toLowerCase() : null;
      var reqAddrO = (typeof opts.tokenOut === 'object' && opts.tokenOut && opts.tokenOut.address) ? opts.tokenOut.address.toLowerCase() : null;
      if (reqAddrO && gotAddrO && reqAddrO !== gotAddrO) return false;
      if (!reqAddrO && !gotAddrO && gotKeyO !== reqKeyO) return false;
    }
    if (opts.amountInRaw != null && (q.amountInRaw == null || String(q.amountInRaw) !== String(opts.amountInRaw))) return false;
    if (opts.chainId != null && (q.chainId == null || Number(q.chainId) !== Number(opts.chainId))) {
      // LI.FI quotes carry fromChainId/toChainId instead of chainId.
      if (q.fromChainId != null && Number(q.fromChainId) === Number(opts.chainId)) {
        // same-chain source matches — allowed
      } else {
        return false;
      }
    }
    // Source/destination chain validation. LI.FI quotes carry explicit
    // fromChainId/toChainId. Single-chain providers (Tower / local) carry only
    // chainId; for a SAME-chain request, chainId stands in for both. A single
    // chainId can never satisfy a CROSS-chain request (explicit from/to required).
    var sameChainReq = opts.fromChainId != null && opts.toChainId != null &&
      Number(opts.fromChainId) === Number(opts.toChainId);
    var qFrom = q.fromChainId != null ? q.fromChainId : (sameChainReq ? q.chainId : null);
    var qTo   = q.toChainId   != null ? q.toChainId   : (sameChainReq ? q.chainId : null);
    if (opts.fromChainId != null && (qFrom == null || Number(qFrom) !== Number(opts.fromChainId))) return false;
    if (opts.toChainId != null && (qTo == null || Number(qTo) !== Number(opts.toChainId))) return false;
    if (q.expiresAt != null && Date.now() > q.expiresAt) return false; // stale
    return true;
  }

  /**
   * Quote Tower + local pools in parallel and select the best route.
   * Distinguishes bestQuote (highest expectedOutRaw) from bestExecutableQuote
   * (highest expectedOutRaw among quotes that can actually be executed).
   * @param {object} opts { tokenIn, tokenOut, amountInRaw: bigint, slippageBps, userAddress?, chainId?, hasLocalPool? }
   * @returns {Promise<{ok:boolean, executable:boolean, best?:object, bestExecutable?:object, alternatives?:object[], reason?:string, quotes:object[]}>}
   */
  async function getBestQuote(opts) {
    opts = opts || {};
    var timeoutMs = opts.timeoutMs != null ? Number(opts.timeoutMs) : 8000;
    var hasLocalPool = opts.hasLocalPool === true;
    // excludeLocal: when true the local pool is NOT quoted at all (used by the
    // Unified Balance EVM-Wallet flow, which must route through LI.FI/Tower only).
    var excludeLocal = opts.excludeLocal === true;

    var towerPromise = (typeof TowerAdapter !== 'undefined' && TowerAdapter.getQuote)
      ? TowerAdapter.getQuote(opts)
      : Promise.resolve({ source: 'tower', ok: false, error: 'TOWER_UNAVAILABLE' });

    var localPromise = excludeLocal
      ? Promise.resolve({ source: 'local', ok: false, error: 'LOCAL_EXCLUDED' })
      : ((typeof LocalAdapter !== 'undefined' && LocalAdapter.getQuote)
        ? LocalAdapter.getQuote(opts)
        : Promise.resolve({ source: 'local', ok: false, error: 'LOCAL_UNAVAILABLE' }));

    // LI.FI accepts token objects (with .address) or symbol strings.
    // When a token object is provided it resolves directly by address, bypassing
    // the symbol→chain registry lookup — enables any token from LI.FI's catalog.
    var lifiFromChain = opts.fromChainId != null ? Number(opts.fromChainId) : (opts.chainId != null ? Number(opts.chainId) : null);
    var lifiToChain   = opts.toChainId   != null ? Number(opts.toChainId)   : (opts.chainId != null ? Number(opts.chainId) : null);
    var lifiPromise = (typeof LiFiAdapter !== 'undefined' && LiFiAdapter.getQuote)
      ? LiFiAdapter.getQuote({
          tokenIn:     opts.tokenIn,
          tokenOut:    opts.tokenOut,
          amountInRaw: opts.amountInRaw,
          slippageBps: opts.slippageBps,
          fromChainId: lifiFromChain,
          toChainId:   lifiToChain,
          fromAddress: opts.userAddress,
        })
      : Promise.resolve({ source: 'lifi', ok: false, error: 'LIFI_UNAVAILABLE' });

    // Isolated failures: a slow/rejecting source settles to an error quote after
    // its own timeout, never blocking the other source beyond `timeoutMs`.
    var wrapped = [
      withTimeout(towerPromise, timeoutMs, { source: 'tower', ok: false, error: 'TIMEOUT' }),
      withTimeout(localPromise, timeoutMs, { source: 'local', ok: false, error: 'TIMEOUT' }),
      withTimeout(lifiPromise, timeoutMs, { source: 'lifi', ok: false, error: 'TIMEOUT' }),
    ];

    var results = await Promise.allSettled(wrapped);

    var quotes = results.map(function (r) {
      if (r.status === 'fulfilled') return r.value;
      return { source: 'unknown', ok: false, error: 'QUOTE_REJECTED' };
    });

    // Reject quotes that do not match the request (amount/token/chain/expiry).
    for (var i = 0; i < quotes.length; i++) {
      var q = quotes[i];
      if (q && q.ok === true && !validateAgainst(q, opts)) {
        quotes[i] = Object.assign({}, q, { ok: false, error: 'QUOTE_MISMATCH' });
      }
    }

    // Finalize executability (single source of truth for bestExecutableQuote).
    //   local  → executable only when a local route actually exists (hasLocalPool)
    //   tower  → executable whenever its route is fully valid (calldata/target/
    //            spender), INDEPENDENT of local-pool existence (Tower and
    //            Elligentt are separate providers — never each other's gate).
    //   lifi   → executable whenever its route is fully valid (LI.FI calldata/
    //            target + chain match). LI.FI is an independent provider too.
    for (var j = 0; j < quotes.length; j++) {
      var qq = quotes[j];
      if (qq && qq.ok === true) {
        if (qq.source === 'local') qq.executable = hasLocalPool;
        else if (qq.source === 'tower') qq.executable = towerExecutionValid(qq);
        else if (qq.source === 'lifi') qq.executable = externalExecutionValid(qq);
        else qq.executable = false;
      } else if (qq) {
        qq.executable = false;
      }
    }

    var decision = pickBest(quotes);             // bestQuote (highest expectedOutRaw)
    decision.quotes = quotes;
    var exec = pickBestExecutable(quotes);       // bestExecutableQuote
    decision.bestExecutable = exec.ok ? exec.best : null;
    decision.executable = exec.ok;
    if (!decision.ok) decision.reason = 'NO_ROUTE_AVAILABLE';
    else if (!decision.executable) decision.reason = 'NO_EXECUTABLE_ROUTE';
    return decision;
  }

  window.SwapAggregator = {
    getBestQuote: getBestQuote,
    pickBest: pickBest,
    pickBestExecutable: pickBestExecutable,
    towerExecutionValid: towerExecutionValid,
    externalExecutionValid: externalExecutionValid,
    version: '1.3.0',
  };
})();
