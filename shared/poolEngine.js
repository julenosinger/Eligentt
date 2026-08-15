/**
 * Elligentt Pool Engine — canonical liquidity pool state + math (Phase 2).
 * =============================================================================
 * Single source of truth for pool CALCULATIONS used by Swap / Pool / LP /
 * Analytics / Monitoring. Reuses SwapMath for all AMM math (no second formula).
 *
 * Everything is BigInt-based internally; floats are only produced for display.
 * Metrics that cannot be derived from real data return `null` (never a fake 0).
 *
 * Attached to: window.PoolEngine
 */
(function () {
  'use strict';

  /* ── Error codes (never convert errors to fake zero values) ── */
  var ERR = {
    POOL_ENGINE_UNAVAILABLE: 'POOL_ENGINE_UNAVAILABLE',
    POOL_NOT_DEPLOYED: 'POOL_NOT_DEPLOYED',
    POOL_UNAVAILABLE: 'POOL_UNAVAILABLE',
    POOL_STATE_UNAVAILABLE: 'POOL_STATE_UNAVAILABLE',
    POOL_STATE_STALE: 'POOL_STATE_STALE',
    INVALID_POOL: 'INVALID_POOL',
    INVALID_POOL_STATE: 'INVALID_POOL_STATE',
    INVALID_TOKEN: 'INVALID_TOKEN',
    ZERO_LIQUIDITY: 'ZERO_LIQUIDITY',
    INSUFFICIENT_LIQUIDITY: 'INSUFFICIENT_LIQUIDITY',
    RPC_ERROR: 'RPC_ERROR',
    STALE_DATA: 'STALE_DATA',
    INVALID_RESERVES: 'INVALID_RESERVES',
    UNKNOWN_DECIMALS: 'UNKNOWN_DECIMALS',
    UNKNOWN_TOKEN_DECIMALS: 'UNKNOWN_TOKEN_DECIMALS',
    QUOTE_UNAVAILABLE: 'QUOTE_UNAVAILABLE',
    QUOTE_STALE: 'QUOTE_STALE',
    TVL_UNAVAILABLE: 'TVL_UNAVAILABLE',
    PRICE_UNAVAILABLE: 'PRICE_UNAVAILABLE',
    UNSUPPORTED_LP: 'UNSUPPORTED_LP',
    ANALYTICS_UNAVAILABLE: 'ANALYTICS_UNAVAILABLE'
  };

  function SM() {
    try { return (typeof window !== 'undefined' && window.SwapMath) ? window.SwapMath : null; } catch (e) { return null; }
  }

  function toBig(v) {
    var m = SM();
    if (m) return m.toBig(v);
    if (typeof v === 'bigint') return v;
    var s = String(v == null ? '' : v).trim();
    return /^\d+$/.test(s) ? BigInt(s) : 0n;
  }

  function pow10(d) {
    var n = Math.floor(Number(d) || 0);
    return n < 0 ? 0n : 10n ** BigInt(n);
  }

  /* ══════════════════════════════════════════════════════════════
     CANONICAL REGISTRY — verified on-chain (Phase 2 audit).
     Only deployed contracts are `deployed: true`. Undeployed pools must
     never be presented as executable.
     ══════════════════════════════════════════════════════════════ */
  var REGISTRY = [
    {
      id: 'usdc-eurc',
      address: '0x18076d992005186AeB13AC5270CaD6E27DB95247',
      tokenA: 'USDC', tokenB: 'EURC',
      tokenAAddress: '0x3600000000000000000000000000000000000000',
      tokenBAddress: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
      tokenADecimals: 6, tokenBDecimals: 6,
      feeBps: 10, type: 'stable',
      deployed: true,
      verifiedAt: '2026-08-14'
    },
    {
      id: 'usdc-cirbtc',
      address: '0x14590fB7dCbD5CeBabFF63B915ef23d008dB98F4',
      tokenA: 'USDC', tokenB: 'cirBTC',
      tokenAAddress: '0x3600000000000000000000000000000000000000',
      tokenBAddress: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF',
      tokenADecimals: 6, tokenBDecimals: 8,
      feeBps: 30, type: 'crypto',
      deployed: true,
      verifiedAt: '2026-08-14'
    },
    {
      id: 'eurc-cirbtc',
      address: '0x38076d992005186AeB13aC5270CaD6E27dB95249',
      tokenA: 'EURC', tokenB: 'cirBTC',
      tokenAAddress: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
      tokenBAddress: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF',
      tokenADecimals: 6, tokenBDecimals: 8,
      feeBps: 30, type: 'crypto',
      deployed: false, // verified no bytecode on-chain
      verifiedAt: '2026-08-14'
    },
    {
      id: 'eth-usdc',
      address: '0x48076d992005186AeB13aC5270CaD6E27dB9524A',
      tokenA: 'ETH', tokenB: 'USDC',
      tokenAAddress: '0x0000000000000000000000000000000000000000',
      tokenBAddress: '0x3600000000000000000000000000000000000000',
      tokenADecimals: 18, tokenBDecimals: 6,
      feeBps: 30, type: 'crypto',
      deployed: false, // verified no bytecode on-chain
      verifiedAt: '2026-08-14'
    }
  ];

  function getPool(id) {
    for (var i = 0; i < REGISTRY.length; i++) if (REGISTRY[i].id === id) return REGISTRY[i];
    return null;
  }
  function getDeployedPools() { return REGISTRY.filter(function (p) { return p.deployed; }); }

  /* ══════════════════════════════════════════════════════════════
     PURE CALCULATIONS — real reserves in raw units (BigInt).
     ══════════════════════════════════════════════════════════════ */

  /**
   * Spot price of 1 tokenA in tokenB, scaled by 1e18 (fixed point).
   *   spotBPerA = (reserveB/10^decB) / (reserveA/10^decA)
   * Returns null for invalid/zero reserves.
   */
  function spotPriceScaled(reserveARaw, reserveBRaw, decA, decB) {
    var rA = toBig(reserveARaw), rB = toBig(reserveBRaw);
    if (rA <= 0n || rB <= 0n) return null;
    var dA = Math.floor(Number(decA) || 0), dB = Math.floor(Number(decB) || 0);
    if (dA < 0 || dB < 0) return null;
    // (rB / 10^dB) / (rA / 10^dA) = rB * 10^dA / (rA * 10^dB), scale 1e18
    var num = rB * pow10(dA) * 10n ** 18n;
    var den = rA * pow10(dB);
    return num / den;
  }

  /** Human spot price (number) for display; null if unavailable. */
  function spotPrice(reserveARaw, reserveBRaw, decA, decB) {
    var s = spotPriceScaled(reserveARaw, reserveBRaw, decA, decB);
    return s === null ? null : Number(s) / 1e18;
  }

  /** amountOut via constant-product (reuses SwapMath). */
  function getAmountOut(amountInRaw, reserveInRaw, reserveOutRaw, feeBps) {
    var m = SM();
    if (m) return m.getAmountOut(amountInRaw, reserveInRaw, reserveOutRaw, feeBps);
    // fallback (should not happen — SwapMath is loaded)
    var a = toBig(amountInRaw), ri = toBig(reserveInRaw), ro = toBig(reserveOutRaw);
    if (a <= 0n || ri <= 0n || ro <= 0n) return 0n;
    var fee = BigInt(Math.floor(Number(feeBps) || 0));
    var inFee = a * (10000n - fee) / 10000n;
    return ro * inFee / (ri + inFee);
  }

  /**
   * Pool utilization in basis points (1 = 0.01%).
   *   utilization = amountIn / reserveIn
   * This is NOT price impact.
   */
  function utilizationBps(amountInRaw, reserveInRaw) {
    var a = toBig(amountInRaw), r = toBig(reserveInRaw);
    if (a <= 0n) return 0;
    if (r <= 0n) return null;
    return Number(a * 10000n / r);
  }

  /**
   * Price impact in basis points (1 = 0.01%): spot price vs execution price.
   *   impact = (spot - execution) / spot
   * Separate from utilization.
   */
  function priceImpactBps(amountInRaw, reserveInRaw, reserveOutRaw, feeBps) {
    var a = toBig(amountInRaw), ri = toBig(reserveInRaw), ro = toBig(reserveOutRaw);
    if (a <= 0n || ri <= 0n || ro <= 0n) return null;
    var fee = BigInt(Math.floor(Number(feeBps) || 0));
    var inFee = a * (10000n - fee) / 10000n;
    if (inFee <= 0n) return null;
    // impact = 1 - (executionPrice / spotPrice), derived to a single division:
    //   = 10000 - 10000 * reserveIn * amountInWithFee / (amountIn * (reserveIn + amountInWithFee))
    var num = 10000n * ri * inFee;
    var den = a * (ri + inFee);
    if (den <= 0n) return null;
    return Number(10000n - num / den);
  }

  /**
   * Reserve imbalance. Normalizes both sides to USD, then measures skew.
   * Returns { balanceScore, imbalancePct, dominantReserve, warning } or null.
   */
  function reserveImbalance(reserveARaw, reserveBRaw, decA, decB, priceAUsd, priceBUsd) {
    var rA = toBig(reserveARaw), rB = toBig(reserveBRaw);
    var pA = Number(priceAUsd), pB = Number(priceBUsd);
    if (rA <= 0n || rB <= 0n) return null;
    if (!isFinite(pA) || !isFinite(pB) || pA <= 0 || pB <= 0) return null;
    var usdA = Number(rA) / Math.pow(10, Math.floor(Number(decA) || 0)) * pA;
    var usdB = Number(rB) / Math.pow(10, Math.floor(Number(decB) || 0)) * pB;
    if (usdA + usdB <= 0) return null;
    var total = usdA + usdB;
    var imbalancePct = Math.abs(usdA - usdB) / total * 100;
    var dominant = usdA >= usdB ? 'A' : 'B';
    var warning = null;
    if (imbalancePct > 50) warning = 'Pool is heavily imbalanced — liquidity is one-sided.';
    else if (imbalancePct > 20) warning = 'Pool is moderately imbalanced.';
    return {
      balanceScore: Math.max(0, 100 - imbalancePct),
      imbalancePct: imbalancePct,
      dominantReserve: dominant,
      warning: warning
    };
  }

  /**
   * TVL in USD from real reserves × verified token prices.
   * Returns null when either token price is unavailable (never fake).
   */
  function tvlUsd(reserveARaw, reserveBRaw, decA, decB, priceAUsd, priceBUsd) {
    var rA = toBig(reserveARaw), rB = toBig(reserveBRaw);
    var pA = Number(priceAUsd), pB = Number(priceBUsd);
    if (rA < 0n || rB < 0n) return null;
    if (!isFinite(pA) || !isFinite(pB)) return null;
    if (pA <= 0 && rA > 0n) return null;
    if (pB <= 0 && rB > 0n) return null;
    var aUsd = Number(rA) / Math.pow(10, Math.floor(Number(decA) || 0)) * pA;
    var bUsd = Number(rB) / Math.pow(10, Math.floor(Number(decB) || 0)) * pB;
    return aUsd + bUsd;
  }

  /**
   * LP share in basis points (1 = 0.01%) = lpBalance / lpSupply.
   */
  function lpShareBps(lpBalanceRaw, lpSupplyRaw) {
    var bal = toBig(lpBalanceRaw), sup = toBig(lpSupplyRaw);
    if (sup <= 0n) return null;
    return Number(bal * 10000n / sup);
  }

  /**
   * LP position value in USD = share × TVL.
   */
  function positionValueUsd(shareBps, reserveARaw, reserveBRaw, decA, decB, priceAUsd, priceBUsd) {
    var tvl = tvlUsd(reserveARaw, reserveBRaw, decA, decB, priceAUsd, priceBUsd);
    if (tvl === null) return null;
    var share = Number(shareBps);
    if (!isFinite(share) || share < 0) return null;
    return tvl * share / 10000;
  }

  /**
   * Impermanent loss in basis points for a price ratio change.
   *   il = 2*sqrt(k)/(1+k) - 1
   * Returns null for invalid ratio (k must be > 0).
   */
  function impermanentLossBps(priceRatio) {
    var k = Number(priceRatio);
    if (!isFinite(k) || k <= 0) return null;
    var il = 2 * Math.sqrt(k) / (1 + k) - 1;
    return Math.round(il * 10000);
  }

  /**
   * Standardized trade depth: expected output + execution price + impact +
   * utilization for a fixed USD input size. Reuses SwapMath.
   * Returns null when the pool has no liquidity or prices are unavailable.
   */
  function depth(reserveARaw, reserveBRaw, decA, decB, priceInUsd, feeBps, amountUsd) {
    var p = Number(priceInUsd);
    if (!isFinite(p) || p <= 0) return null;
    var dIn = Math.floor(Number(decA) || 0);
    var amountInRaw = toBig(Math.round(amountUsd / p * Math.pow(10, dIn)));
    var amountOutRaw = getAmountOut(amountInRaw, reserveARaw, reserveBRaw, feeBps);
    if (amountOutRaw <= 0n) return null;
    var impact = priceImpactBps(amountInRaw, reserveARaw, reserveBRaw, feeBps);
    var util = utilizationBps(amountInRaw, reserveARaw);
    return {
      amountInUsd: amountUsd,
      amountOutRaw: amountOutRaw,
      executionPrice: spotPrice(amountInRaw, amountOutRaw, decA, decB), // out per in
      priceImpactBps: impact,
      utilizationBps: util
    };
  }

  /* ══════════════════════════════════════════════════════════════
     ADD / REMOVE LIQUIDITY VALIDATION (pure)
     ══════════════════════════════════════════════════════════════ */

  /**
   * Optimal tokenB amount for a given tokenA deposit at the current ratio.
   *   optimalB = amountA * spotPrice (B per A)
   * Returns { amountBRaw, spotPriceScaled } or null.
   */
  function addLiquidityOptimalB(amountARaw, reserveARaw, reserveBRaw, decA, decB) {
    var a = toBig(amountARaw);
    var spot = spotPriceScaled(reserveARaw, reserveBRaw, decA, decB);
    if (spot === null || a <= 0n) return null;
    // amountB raw = amountA raw (scaled) * spot(B per A)
    // spot is 1e18-scaled price of A in B (human). amountB raw = amountA_human * spot_human * 10^decB
    var dB = Math.floor(Number(decB) || 0);
    var amountAHumanScaled = a * 10n ** 18n;              // amountA in 1e18-scaled human units of A
    // amountB human (scaled 1e18) = amountA_human_scaled * spot_scaled / 1e18
    var amountBHumanScaled = amountAHumanScaled * spot / 10n ** 18n; // but amountAHumanScaled is in A's decimals; need to divide by 10^decA
    // Correct: amountB_raw = amountA_raw * spot * 10^decB / (10^decA * 1e18) ... let's do it cleanly.
    var dA = Math.floor(Number(decA) || 0);
    // amountA_human = amountA_raw / 10^dA
    // amountB_human = amountA_human * spot_human
    // amountB_raw = amountB_human * 10^dB
    // => amountB_raw = amountA_raw * spot_scaled * 10^dB / (10^dA * 1e18)
    var num = a * spot * pow10(dB);
    var den = pow10(dA) * 10n ** 18n;
    return { amountBRaw: num / den, spotPriceScaled: spot };
  }

  /**
   * Remove-liquidity expected amounts for a given LP amount.
   *   share = lpAmount / lpSupply
   *   amountA = reserveA * share, amountB = reserveB * share
   * Returns { amountARaw, amountBRaw, shareBps } or null.
   */
  function removeLiquidityAmounts(lpAmountRaw, lpSupplyRaw, reserveARaw, reserveBRaw) {
    var lp = toBig(lpAmountRaw), sup = toBig(lpSupplyRaw);
    if (sup <= 0n || lp <= 0n || lp > sup) return null;
    var rA = toBig(reserveARaw), rB = toBig(reserveBRaw);
    var amountA = rA * lp / sup;
    var amountB = rB * lp / sup;
    return { amountARaw: amountA, amountBRaw: amountB, shareBps: Number(lp * 10000n / sup) };
  }

  /* ══════════════════════════════════════════════════════════════
     TOKEN METADATA — canonical address + decimals (single source).
     UI-only fields (icon, color) live in the app, NOT here.
     ══════════════════════════════════════════════════════════════ */
  var TOKENS = {
    USDC:   { sym: 'USDC',   name: 'USD Coin',  decimals: 6,  address: '0x3600000000000000000000000000000000000000' },
    EURC:   { sym: 'EURC',   name: 'Euro Coin',  decimals: 6,  address: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a' },
    cirBTC: { sym: 'cirBTC', name: 'Circle BTC', decimals: 8,  address: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF' },
    ETH:    { sym: 'ETH',    name: 'Ether',      decimals: 18, address: '0x0000000000000000000000000000000000000000' }
  };

  function getToken(sym) { return TOKENS[sym] || null; }

  /* ══════════════════════════════════════════════════════════════
     LIVE POOL STATE — canonical on-chain snapshot (raw BigInt).
     Populated by the app after each on-chain read (loadSinglePool).
     PoolEngine does NOT read the chain itself; it owns the *state*.
     ══════════════════════════════════════════════════════════════ */
  var _states = {};

  function updatePoolState(id, state) {
    var p = getPool(id);
    if (!p) return false;
    if (!state) state = {};
    _states[id] = {
      reserveARaw: state.reserveARaw != null ? toBig(state.reserveARaw) : null,
      reserveBRaw: state.reserveBRaw != null ? toBig(state.reserveBRaw) : null,
      lpSupplyRaw: state.lpSupplyRaw != null ? toBig(state.lpSupplyRaw) : null,
      updatedAt: Number(state.updatedAt) || Date.now(),
      error: state.error || null
    };
    return true;
  }

  /** Canonical pool state snapshot (registry config + raw reserves + age). */
  function getPoolState(id) {
    var p = getPool(id);
    if (!p) return null;
    var s = _states[id] || { reserveARaw: null, reserveBRaw: null, lpSupplyRaw: null, updatedAt: 0, error: null };
    return {
      id: p.id,
      address: p.address,
      tokenA: p.tokenA, tokenB: p.tokenB,
      tokenAAddress: p.tokenAAddress, tokenBAddress: p.tokenBAddress,
      tokenADecimals: p.tokenADecimals, tokenBDecimals: p.tokenBDecimals,
      feeBps: p.feeBps, type: p.type, deployed: p.deployed,
      reserveARaw: s.reserveARaw, reserveBRaw: s.reserveBRaw, lpSupplyRaw: s.lpSupplyRaw,
      updatedAt: s.updatedAt, error: s.error
    };
  }

  function hasLiquidity(id) {
    var s = getPoolState(id);
    return !!(s && s.reserveARaw && s.reserveBRaw && s.reserveARaw > 0n && s.reserveBRaw > 0n);
  }

  /** True when the snapshot is missing or older than maxAgeMs (default 60s). */
  function isStale(id, maxAgeMs) {
    var s = getPoolState(id);
    if (!s || s.updatedAt <= 0) return true;
    var max = Number(maxAgeMs);
    if (!isFinite(max) || max <= 0) max = 60000;
    return (Date.now() - s.updatedAt) > max;
  }

  /**
   * Validate a pool's state BEFORE any financial calculation.
   * Returns { ok, code, state }. Invalid/unavailable state produces an explicit
   * error code — never a fabricated zero.
   */
  function validatePoolState(id) {
    var p = getPool(id);
    if (!p) return { ok: false, code: ERR.INVALID_POOL };
    if (!p.deployed) return { ok: false, code: ERR.POOL_NOT_DEPLOYED };
    if (!TOKENS[p.tokenA] || !TOKENS[p.tokenB]) return { ok: false, code: ERR.INVALID_TOKEN };
    if (p.tokenADecimals == null || p.tokenBDecimals == null) return { ok: false, code: ERR.UNKNOWN_TOKEN_DECIMALS };
    if (p.feeBps == null || p.feeBps < 0 || p.feeBps >= 10000) return { ok: false, code: ERR.INVALID_POOL };
    var s = _states[id];
    if (!s || s.updatedAt <= 0) return { ok: false, code: ERR.POOL_STATE_UNAVAILABLE };
    if (s.reserveARaw == null || s.reserveBRaw == null) return { ok: false, code: ERR.INVALID_RESERVES };
    if (s.reserveARaw < 0n || s.reserveBRaw < 0n) return { ok: false, code: ERR.INVALID_RESERVES };
    if (s.reserveARaw <= 0n && s.reserveBRaw <= 0n) return { ok: false, code: ERR.ZERO_LIQUIDITY };
    return { ok: true, code: null, state: getPoolState(id) };
  }

  /**
   * Canonical end-to-end quote from live state (used by Swap).
   * Returns { ok, amountOutRaw, priceImpactBps, utilizationBps, code }.
   * Never fabricates output: failures carry an error code, not a 0.
   */
  function quote(id, tokenInSym, amountInRaw) {
    var v = validatePoolState(id);
    if (!v.ok) return { ok: false, code: v.code };
    var s = v.state;
    var a = toBig(amountInRaw);
    if (a <= 0n) return { ok: false, code: ERR.INVALID_TOKEN };
    var isA = tokenInSym === s.tokenA;
    var isB = tokenInSym === s.tokenB;
    if (!isA && !isB) return { ok: false, code: ERR.INVALID_TOKEN };
    var rIn = isA ? s.reserveARaw : s.reserveBRaw;
    var rOut = isA ? s.reserveBRaw : s.reserveARaw;
    if (rIn <= 0n || rOut <= 0n) return { ok: false, code: ERR.ZERO_LIQUIDITY };
    var out = getAmountOut(a, rIn, rOut, s.feeBps);
    var impact = priceImpactBps(a, rIn, rOut, s.feeBps);
    var util = utilizationBps(a, rIn);
    return { ok: true, amountOutRaw: out, priceImpactBps: impact, utilizationBps: util };
  }

  window.PoolEngine = {
    VERSION: '1.2.0',
    ERR: ERR,
    REGISTRY: REGISTRY,
    TOKENS: TOKENS,
    getPool: getPool,
    getToken: getToken,
    getDeployedPools: getDeployedPools,
    updatePoolState: updatePoolState,
    getPoolState: getPoolState,
    validatePoolState: validatePoolState,
    hasLiquidity: hasLiquidity,
    isStale: isStale,
    quote: quote,
    spotPriceScaled: spotPriceScaled,
    spotPrice: spotPrice,
    getAmountOut: getAmountOut,
    utilizationBps: utilizationBps,
    priceImpactBps: priceImpactBps,
    reserveImbalance: reserveImbalance,
    tvlUsd: tvlUsd,
    lpShareBps: lpShareBps,
    positionValueUsd: positionValueUsd,
    impermanentLossBps: impermanentLossBps,
    depth: depth,
    addLiquidityOptimalB: addLiquidityOptimalB,
    removeLiquidityAmounts: removeLiquidityAmounts
  };
})();
