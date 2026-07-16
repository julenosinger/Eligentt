/**
 * Elligentt LP Analytics Engine (FASE 3.6)
 * ═══════════════════════════════════════
 * Calculates: TVL, LP share, liquidity ratio, pool concentration.
 * Prepared for: APR, APY, fee yield, LP rewards, protocol revenue.
 * Attached to window.LPAnalytics
 */
(function(){
  'use strict';

  function calculate(reserveA, reserveB, lpSupply, userLPBalance, poolConfig) {
    var result = {
      valid: false,
      tvl: 0,
      reserveA: Number(reserveA || 0),
      reserveB: Number(reserveB || 0),
      lpSupply: Number(lpSupply || 0),
      userLPBalance: Number(userLPBalance || 0),
      metrics: {}
    };

    if (!reserveA || !reserveB || !lpSupply) {
      result.error = 'Insufficient data';
      return result;
    }

    var rA = Number(reserveA);
    var rB = Number(reserveB);
    var lpTotal = Number(lpSupply);

    // TVL = value of both reserves (using reserveA as USDC = $1)
    var reserveBValueUsd = rB * 67000; // cirBTC at reference price
    result.tvl = parseFloat((rA + reserveBValueUsd).toFixed(2));

    // LP share
    if (userLPBalance > 0 && lpTotal > 0) {
      result.metrics.lpShare = parseFloat(((userLPBalance / lpTotal) * 100).toFixed(4));
      result.metrics.userReserveAShare = parseFloat((rA * result.metrics.lpShare / 100).toFixed(2));
      result.metrics.userReserveBShare = parseFloat((rB * result.metrics.lpShare / 100).toFixed(8));
    }

    // Liquidity ratio (USDC dominance)
    result.metrics.liquidityRatio = parseFloat(((rA / result.tvl) * 100).toFixed(2));

    // Reserve distribution
    result.metrics.reserveDistribution = {
      tokenA: parseFloat(((rA / rA + (rB || 1) * 67000) * 100).toFixed(2)),
      tokenB: parseFloat((((rB || 0) * 67000 / result.tvl) * 100).toFixed(2))
    };

    // Pool concentration (reserve balance)
    result.metrics.poolConcentration = rA > 0 && rB > 0
      ? parseFloat((Math.max(rA, rB * 67000) / result.tvl * 100).toFixed(2))
      : 0;

    // Price ratios
    if (rB > 0 && rA > 0) {
      result.metrics.priceUsdcPerBtc = parseFloat((rA / rB).toFixed(2));
      result.metrics.priceBtcPerUsdc = parseFloat((rB / rA).toFixed(8));
    }

    // Fee yield estimate (0.3% fee, daily estimate based on volume%)
    if (typeof HistoricalMetrics !== 'undefined') {
      var dailyVolume = HistoricalMetrics.getAverage('volume', 24) || 0;
      result.metrics.dailyVolume = parseFloat(dailyVolume.toFixed(2));
      result.metrics.dailyFeeRevenue = parseFloat((dailyVolume * 0.003).toFixed(4));
      if (lpTotal > 0) {
        result.metrics.dailyFeePerLPToken = parseFloat((result.metrics.dailyFeeRevenue / lpTotal).toFixed(8));
      }
    }

    // APR estimate prep (placeholder for future yield tracking)
    result.metrics.aprEstimate = result.tvl > 0
      ? parseFloat(((result.metrics.dailyFeeRevenue || 0) * 365 / result.tvl * 100).toFixed(2))
      : 0;

    result.valid = true;
    return result;
  }

  function estimateLPValue(userLPBalance, reserveA, reserveB, lpSupply) {
    if (!userLPBalance || !lpSupply || lpSupply <= 0) return 0;
    var share = userLPBalance / lpSupply;
    return {
      sharePct: parseFloat((share * 100).toFixed(4)),
      reserveAShare: parseFloat((reserveA * share).toFixed(2)),
      reserveBShare: parseFloat((reserveB * share).toFixed(8)),
      estimatedUsd: parseFloat((reserveA * share + reserveB * share * 67000).toFixed(2))
    };
  }

  function quickAnalytics(reserveA, reserveB) {
    return {
      tvl: parseFloat((reserveA + reserveB * 67000).toFixed(2)),
      ratio: parseFloat((reserveA / reserveB).toFixed(2)) || 0,
      concentration: parseFloat((Math.max(reserveA, reserveB * 67000) / (reserveA + reserveB * 67000) * 100).toFixed(1)),
      tokenCount: 2,
      usdcDominance: parseFloat(((reserveA / (reserveA + reserveB * 67000)) * 100).toFixed(1))
    };
  }

  window.LPAnalytics = {
    calculate: calculate,
    estimateLPValue: estimateLPValue,
    quickAnalytics: quickAnalytics
  };
})();
