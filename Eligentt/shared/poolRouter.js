/**
 * Elligentt Smart Router — foundation (Phase 5).
 * =============================================================================
 * An ORCHESTRATOR for route discovery + quote comparison + validation. It does
 * NOT perform any financial math: every quote flows through PoolEngine (which
 * reuses SwapMath). The router only selects the best safe route.
 *
 * This phase provides route QUOTING only. Multi-hop transaction execution is
 * intentionally NOT implemented.
 *
 * Attached to: window.PoolRouter
 */
(function () {
  'use strict';

  function toBig(v) {
    if (typeof v === 'bigint') return v;
    if (v == null) return 0n;
    var s = String(v).trim();
    if (/^\d+$/.test(s)) return BigInt(s);
    return 0n;
  }

  var DEFAULTS = {
    maxPriceImpactBps: 2500,   // hard block above 25% impact
    warnPriceImpactBps: 1500,  // warn above 15%
    maxUtilizationBps: 5000,   // block above 50% of reserveIn
    maxStateAgeMs: 60000,      // stale after 60s
    defaultSlippageBps: 50,    // 0.5%
  };

  function createRouter(opts) {
    opts = opts || {};
    var PE = (opts.poolEngine !== undefined)
      ? opts.poolEngine
      : ((typeof window !== 'undefined' && window.PoolEngine) ? window.PoolEngine : null);
    var SM = (opts.swapMath !== undefined)
      ? opts.swapMath
      : ((typeof window !== 'undefined' && window.SwapMath) ? window.SwapMath : null);
    var config = {
      maxPriceImpactBps: opts.maxPriceImpactBps != null ? opts.maxPriceImpactBps : DEFAULTS.maxPriceImpactBps,
      warnPriceImpactBps: opts.warnPriceImpactBps != null ? opts.warnPriceImpactBps : DEFAULTS.warnPriceImpactBps,
      maxUtilizationBps: opts.maxUtilizationBps != null ? opts.maxUtilizationBps : DEFAULTS.maxUtilizationBps,
      maxStateAgeMs: opts.maxStateAgeMs != null ? opts.maxStateAgeMs : DEFAULTS.maxStateAgeMs,
      defaultSlippageBps: opts.defaultSlippageBps != null ? opts.defaultSlippageBps : DEFAULTS.defaultSlippageBps,
    };
    var telemetry = [];

    function record(entry) {
      telemetry.push(Object.assign({ ts: Date.now() }, entry));
      if (telemetry.length > 500) telemetry.shift();
    }

    function deployedPools() {
      if (!PE || !Array.isArray(PE.REGISTRY)) return [];
      return PE.REGISTRY.filter(function (p) { return p.deployed; });
    }

    /** Pool graph: token → pool edge → token, from verified deployed pools only. */
    function buildGraph() {
      var edges = [];
      var pools = deployedPools();
      for (var i = 0; i < pools.length; i++) {
        var p = pools[i];
        var st = PE.getPoolState ? PE.getPoolState(p.id) : null;
        var avail = !!(st && st.reserveARaw != null && st.reserveBRaw != null && st.reserveARaw > 0n && st.reserveBRaw > 0n);
        edges.push({
          poolId: p.id,
          poolAddress: p.address,
          tokenA: p.tokenA,
          tokenB: p.tokenB,
          reserveARaw: st ? st.reserveARaw : null,
          reserveBRaw: st ? st.reserveBRaw : null,
          feeBps: p.feeBps,
          available: avail,
          deployed: !!p.deployed,
          stateUpdatedAt: st ? st.updatedAt : null,
        });
      }
      return edges;
    }

    function findPool(tokenA, tokenB) {
      var all = deployedPools();
      for (var i = 0; i < all.length; i++) {
        var p = all[i];
        if ((p.tokenA === tokenA && p.tokenB === tokenB) || (p.tokenA === tokenB && p.tokenB === tokenA)) return p;
      }
      return null;
    }

    /** Quote a single (direct) pool through PoolEngine. Returns raw BigInt. */
    function quoteDirect(pool, tokenInSym, amountInRaw) {
      if (!PE || !PE.getPoolState || !PE.getAmountOut) return { ok: false, error: 'ROUTE_QUOTE_UNAVAILABLE' };
      var st = PE.getPoolState(pool.id);
      if (!st) return { ok: false, error: 'POOL_STATE_UNAVAILABLE' };
      if (!st.deployed) return { ok: false, error: 'POOL_NOT_DEPLOYED' };
      if (st.reserveARaw == null || st.reserveBRaw == null) return { ok: false, error: 'INVALID_RESERVES' };
      if (st.reserveARaw <= 0n || st.reserveBRaw <= 0n) return { ok: false, error: 'INSUFFICIENT_LIQUIDITY' };
      var isA = tokenInSym === pool.tokenA;
      if (!isA && tokenInSym !== pool.tokenB) return { ok: false, error: 'INVALID_TOKEN' };
      var rIn = isA ? st.reserveARaw : st.reserveBRaw;
      var rOut = isA ? st.reserveBRaw : st.reserveARaw;
      var out = PE.getAmountOut(amountInRaw, rIn, rOut, pool.feeBps);
      if (out <= 0n) return { ok: false, error: 'INSUFFICIENT_LIQUIDITY' };
      var impact = PE.priceImpactBps(amountInRaw, rIn, rOut, pool.feeBps);
      var util = PE.utilizationBps(amountInRaw, rIn);
      return {
        ok: true,
        amountOutRaw: out,
        priceImpactBps: impact,
        utilizationBps: util,
        feeBps: pool.feeBps,
        poolId: pool.id,
        poolAddress: pool.address,
        stateUpdatedAt: st.updatedAt,
      };
    }

    /**
     * findBestRoute({ tokenIn, tokenOut, amountInRaw, slippageBps })
     * Returns { ok, bestRoute, alternatives, candidateCount, rejected, reason }.
     * Never returns a fake quote: failures carry an explicit reason.
     */
    function findBestRoute(req) {
      req = req || {};
      var amountInRaw = toBig(req.amountInRaw);
      var slippageBps = req.slippageBps != null ? req.slippageBps : config.defaultSlippageBps;

      if (!PE) { record({ op: 'route', result: 'ROUTE_QUOTE_UNAVAILABLE' }); return { ok: false, reason: 'ROUTE_QUOTE_UNAVAILABLE' }; }
      if (amountInRaw <= 0n) { record({ op: 'route', result: 'INVALID_AMOUNT' }); return { ok: false, reason: 'INVALID_AMOUNT' }; }

      var candidates = [];
      var direct = findPool(req.tokenIn, req.tokenOut);
      if (direct) candidates.push({ pool: direct, hops: [req.tokenIn, req.tokenOut] });
      // NOTE: multi-hop discovery is intentionally deferred (Phase 6). Only
      // verified direct pools are quoted in this phase.

      var quoted = [];
      var rejected = [];
      for (var i = 0; i < candidates.length; i++) {
        var c = candidates[i];
        var q = quoteDirect(c.pool, req.tokenIn, amountInRaw);
        if (!q.ok) { rejected.push({ poolId: c.pool.id, hops: c.hops, reason: q.error }); continue; }
        if (PE.isStale && PE.isStale(c.pool.id, config.maxStateAgeMs)) { rejected.push({ poolId: c.pool.id, hops: c.hops, reason: 'ROUTES_STALE' }); continue; }
        if (q.priceImpactBps === null) { rejected.push({ poolId: c.pool.id, hops: c.hops, reason: 'PRICE_IMPACT_UNAVAILABLE' }); continue; }
        if (q.priceImpactBps > config.maxPriceImpactBps) { rejected.push({ poolId: c.pool.id, hops: c.hops, reason: 'PRICE_IMPACT_TOO_HIGH' }); continue; }
        if (q.utilizationBps !== null && q.utilizationBps > config.maxUtilizationBps) { rejected.push({ poolId: c.pool.id, hops: c.hops, reason: 'UTILIZATION_TOO_HIGH' }); continue; }
        quoted.push({
          routeId: c.pool.id,
          path: c.hops,
          pools: [c.pool.id],
          amountInRaw: amountInRaw,
          expectedOutRaw: q.amountOutRaw,
          priceImpactBps: q.priceImpactBps,
          utilizationBps: q.utilizationBps,
          feeBps: q.feeBps,
          quotedAt: Date.now(),
          stateUpdatedAt: q.stateUpdatedAt,
          confidence: 'FRESH',
          minOutRaw: (SM && SM.calcMinOut) ? SM.calcMinOut(q.amountOutRaw, slippageBps) : null,
        });
      }

      record({ op: 'route', tokenIn: req.tokenIn, tokenOut: req.tokenOut, candidates: candidates.length, quoted: quoted.length, rejected: rejected.length });

      if (quoted.length === 0) {
        if (rejected.length === 0) return { ok: false, reason: 'NO_ROUTE_AVAILABLE', rejected: rejected };
        var allStale = rejected.every(function (r) { return r.reason === 'ROUTES_STALE'; });
        if (allStale) return { ok: false, reason: 'ROUTES_STALE', rejected: rejected };
        var allNoLiq = rejected.every(function (r) { return r.reason === 'INSUFFICIENT_LIQUIDITY'; });
        if (allNoLiq) return { ok: false, reason: 'INSUFFICIENT_LIQUIDITY', rejected: rejected };
        return { ok: false, reason: rejected[0].reason, rejected: rejected };
      }

      quoted.sort(function (a, b) {
        if (a.expectedOutRaw !== b.expectedOutRaw) return (a.expectedOutRaw > b.expectedOutRaw) ? -1 : 1;
        return a.feeBps - b.feeBps;
      });

      return { ok: true, bestRoute: quoted[0], alternatives: quoted.slice(1), candidateCount: candidates.length, rejected: rejected };
    }

    function getTelemetry() { return telemetry.slice(); }
    function getConfig() { return Object.assign({}, config); }
    function configure(o) {
      if (o && o.maxPriceImpactBps != null) config.maxPriceImpactBps = o.maxPriceImpactBps;
      if (o && o.warnPriceImpactBps != null) config.warnPriceImpactBps = o.warnPriceImpactBps;
      if (o && o.maxUtilizationBps != null) config.maxUtilizationBps = o.maxUtilizationBps;
      if (o && o.maxStateAgeMs != null) config.maxStateAgeMs = o.maxStateAgeMs;
      if (o && o.defaultSlippageBps != null) config.defaultSlippageBps = o.defaultSlippageBps;
      return getConfig();
    }

    return {
      buildGraph: buildGraph,
      findPool: findPool,
      quoteDirect: quoteDirect,
      findBestRoute: findBestRoute,
      getTelemetry: getTelemetry,
      getConfig: getConfig,
      configure: configure,
    };
  }

  window.PoolRouter = {
    VERSION: '1.0.0',
    createRouter: createRouter,
    DEFAULTS: DEFAULTS,
  };
})();
