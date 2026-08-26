/**
 * LocalAdapter — Elligentt's own pools as a first-class liquidity source.
 * ═══════════════════════════════════════════════════════════════════════
 * Encapsulates the EXISTING local route/quote flow (PoolEngine / PoolRouter /
 * the canonical getAmountOut). It does NOT reimplement AMM math — it reuses the
 * existing top-level swap functions and SwapMath. It exposes a normalized quote
 * shape identical to TowerAdapter so the SwapAggregator can compare both:
 *
 *   { source:'local', ok, tokenIn, tokenOut, amountInRaw, expectedOutRaw,
 *     minOutRaw, priceImpactBps, route, executionType:'local' }
 *
 * Attached to window.LocalAdapter
 */
(function () {
  'use strict';

  if (typeof window !== 'undefined' && window.LocalAdapter) return;

  function positiveBig(v) {
    try { return typeof v === 'bigint' && v > 0n; } catch (_) { return false; }
  }

  /**
   * Quote the Elligentt local pools for a swap.
   * @param {object} opts { tokenIn, tokenOut, amountInRaw: bigint, slippageBps }
   * @returns {Promise<{source:'local', ok:boolean, error?:string, ...}>}
   */
  async function getQuote(opts) {
    opts = opts || {};
    var tokenIn = opts.tokenIn;
    var tokenOut = opts.tokenOut;
    var amountInRaw = opts.amountInRaw;
    var slippageBps = opts.slippageBps != null ? Number(opts.slippageBps) : 50;

    try {
      if (typeof findRoute !== 'function' || typeof calcRouteOutputRaw !== 'function') {
        return { source: 'local', ok: false, error: 'LOCAL_ROUTING_UNAVAILABLE' };
      }
      if (!positiveBig(amountInRaw)) {
        return { source: 'local', ok: false, error: 'INVALID_AMOUNT' };
      }

      var route = findRoute(tokenIn, tokenOut);
      if (!route || route.noLiq) {
        return { source: 'local', ok: false, error: 'NO_ROUTE_AVAILABLE' };
      }

      var expectedOutRaw = null;

      // On-chain quote for direct pools (mirrors the existing swap flow).
      if (route.type === 'direct' && route.pools[0].address && route.pools[0].address !== '0x0000000000000000000000000000000000000000') {
        try {
          var readProvider = getCachedProvider('https://arc-testnet.drpc.org');
          var pc = new ethers.Contract(route.pools[0].address, POOL_CONTRACT_ABI, readProvider);
          var tokenInAddr = getTokAddr(tokenIn);
          var amtOutBig = await pc.getAmountOut(amountInRaw, tokenInAddr);
          if (amtOutBig > 0n) expectedOutRaw = amtOutBig;
        } catch (_) {
          // on-chain quote unavailable → fall through to canonical PoolEngine quote
        }
      }

      // Canonical local quote via PoolEngine (raw — the single execution source).
      if (expectedOutRaw === null) {
        var res = calcRouteOutputRaw(route, amountInRaw);
        if (!res || !res.ok || !positiveBig(res.amountOutRaw)) {
          return { source: 'local', ok: false, error: (res && res.error) || 'LOCAL_QUOTE_FAILED' };
        }
        expectedOutRaw = res.amountOutRaw;
      }

      var minOutRaw = (typeof SwapMath !== 'undefined' && SwapMath.calcMinOut)
        ? SwapMath.calcMinOut(expectedOutRaw, slippageBps)
        : null;
      if (minOutRaw == null || !positiveBig(minOutRaw)) {
        return { source: 'local', ok: false, error: 'MIN_OUT_UNAVAILABLE' };
      }

      var feeBps = (typeof getRouteFee === 'function') ? getRouteFee(route) : null;

      return {
        source: 'local',
        ok: true,
        tokenIn: tokenIn,
        tokenOut: tokenOut,
        chainId: 5042002,
        amountInRaw: amountInRaw,
        expectedOutRaw: expectedOutRaw,
        minOutRaw: minOutRaw,
        priceImpactBps: null, // unavailable in the local adapter (see updateSwapRate's canonical check)
        feeBps: feeBps,
        route: route,
        executionType: 'local',
      };
    } catch (e) {
      return { source: 'local', ok: false, error: (e && e.message) || String(e) };
    }
  }

  window.LocalAdapter = {
    getQuote: getQuote,
    version: '1.0.0',
  };
})();
