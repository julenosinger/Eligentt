/**
 * Elligentt Price Oracle Engine (FASE 3.1)
 * ═══════════════════════════════════════
 * Multi-source price oracle: Pool Price, Reserve Ratio, TWAP.
 * Fallback chain: TWAP → Pool Price → Reserve Ratio.
 * Chainlink/Arc Oracle integration ready (when available).
 * Attached to window.PriceOracleEngine
 */
(function(){
  'use strict';

  var ORACLE_SOURCES = ['twap', 'pool', 'reserve_ratio'];
  var activeSource = 'twap';

  function getPoolPrice(reserveA, reserveB, decA, decB) {
    var rA = Number(reserveA || 0);
    var rB = Number(reserveB || 0);
    if (rA <= 0 || rB <= 0) return null;

    return {
      priceAB: parseFloat((rA / rB).toFixed(6)),
      priceBA: parseFloat((rB / rA).toFixed(8)),
      source: 'pool',
      timestamp: Date.now()
    };
  }

  function getReserveRatioPrice(reserveA, reserveB) {
    var rA = Number(reserveA || 0);
    var rB = Number(reserveB || 0);
    if (rA <= 0 || rB <= 0) return null;

    return {
      priceAB: parseFloat((rA / rB).toFixed(6)),
      priceBA: parseFloat((rB / rA).toFixed(8)),
      ratio: parseFloat((rA / (rA + rB) * 100).toFixed(2)),
      source: 'reserve_ratio',
      timestamp: Date.now()
    };
  }

  function getTWAPPrice(minutes) {
    if (typeof TwapEngine === 'undefined') return null;
    var twap = TwapEngine.calculateTWAP(minutes || 15);
    if (!twap) return null;
    return {
      priceAB: twap.twapAB,
      priceBA: twap.twapBA,
      avgReserveA: twap.avgReserveA,
      avgReserveB: twap.avgReserveB,
      source: 'twap_' + (minutes || 15) + 'm',
      snapshots: twap.snapshots,
      windowMinutes: minutes || 15,
      timestamp: Date.now()
    };
  }

  function getBestPrice(reserveA, reserveB) {
    var sources = [];

    var twap = getTWAPPrice(15);
    if (twap) sources.push(twap);

    var pool = getPoolPrice(reserveA, reserveB);
    if (pool) sources.push(pool);

    var ratio = getReserveRatioPrice(reserveA, reserveB);
    if (ratio) sources.push(ratio);

    var best = twap || pool || ratio || null;
    activeSource = best ? best.source : 'unknown';

    return {
      best: best,
      sources: sources,
      activeSource: activeSource,
      sourceCount: sources.length,
      timestamp: Date.now()
    };
  }

  function comparePrices(priceA, priceB) {
    if (!priceA || !priceB) return null;
    var diff = Math.abs(priceA.priceAB - priceB.priceAB);
    var dev = priceA.priceAB > 0 ? (diff / priceA.priceAB) * 100 : 0;
    return {
      deviationPct: parseFloat(dev.toFixed(4)),
      sourceA: priceA.source,
      sourceB: priceB.source,
      priceA: priceA.priceAB,
      priceB: priceB.priceAB
    };
  }

  function checkOracleHealth(reserveA, reserveB) {
    var prices = getBestPrice(reserveA, reserveB);
    var issues = [];

    if (prices.sources.length < 2) {
      issues.push({ severity: 'MEDIUM', message: 'Only ' + prices.sources.length + ' price source(s) available' });
    }

    if (prices.sources.length >= 2) {
      var dev = comparePrices(prices.sources[0], prices.sources[1]);
      if (dev && dev.deviationPct > 5) {
        issues.push({ severity: 'HIGH', message: 'Price deviation between sources: ' + dev.deviationPct.toFixed(2) + '%' });
      } else if (dev && dev.deviationPct > 2) {
        issues.push({ severity: 'MEDIUM', message: 'Moderate price deviation: ' + dev.deviationPct.toFixed(2) + '%' });
      }
    }

    if (!prices.best) {
      issues.push({ severity: 'CRITICAL', message: 'No price source available' });
    }

    return {
      healthy: issues.length === 0,
      activeSource: activeSource,
      prices: prices,
      issues: issues,
      requiredSources: ORACLE_SOURCES.length,
      availableSources: prices.sourceCount
    };
  }

  function getActiveSource() { return activeSource; }

  function getSupportedSources() { return ORACLE_SOURCES.slice(); }

  window.PriceOracleEngine = {
    getPoolPrice: getPoolPrice,
    getReserveRatioPrice: getReserveRatioPrice,
    getTWAPPrice: getTWAPPrice,
    getBestPrice: getBestPrice,
    comparePrices: comparePrices,
    checkOracleHealth: checkOracleHealth,
    getActiveSource: getActiveSource,
    getSupportedSources: getSupportedSources,
    ORACLE_SOURCES: ORACLE_SOURCES
  };
})();
