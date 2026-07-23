/**
 * Elligentt Price Impact Engine (FASE 2.3)
 * ═══════════════════════════════════════
 * Calculates price impact using on-chain pool reserves via constant-product formula.
 * Classifies into tiers: LOW, MEDIUM, HIGH, CRITICAL.
 * Attached to window.PriceImpactEngine
 */
(function(){
  'use strict';

  var TIERS = {
    LOW:      { max: 1,    label: 'LOW',      color: '#22c55e' },
    MEDIUM:   { max: 5,    label: 'MEDIUM',   color: '#f59e0b' },
    HIGH:     { max: 10,   label: 'HIGH',     color: '#f97316' },
    CRITICAL: { max: Infinity, label: 'CRITICAL', color: '#ef4444' }
  };

  var WARN_THRESHOLD = 5;
  var CONFIRM_THRESHOLD = 10;
  var BLOCK_THRESHOLD = 15;

  function _constantProductPriceImpact(amountIn, reserveIn) {
    if (!reserveIn || reserveIn <= 0) return Infinity;
    if (!amountIn || amountIn <= 0) return 0;
    return (amountIn / (reserveIn + amountIn)) * 100;
  }

  function calculate(amountIn, reserveA, reserveB, tokenIn, tokenOut, poolConfig) {
    var result = {
      valid: false,
      priceImpact: null,
      tier: null,
      tierLabel: null,
      tierColor: null,
      requiresWarning: false,
      requiresConfirmation: false,
      blocksSwap: false,
      recommendations: [],
      reserveIn: 0,
      reserveOut: 0,
      poolUtilization: 0
    };

    if (!amountIn || isNaN(Number(amountIn)) || Number(amountIn) <= 0) {
      result.error = 'Invalid amount input';
      return result;
    }
    if (!reserveA || !reserveB) {
      result.error = 'Pool reserves unavailable';
      return result;
    }

    var amt = Number(amountIn);
    var rA = Number(reserveA);
    var rB = Number(reserveB);

    var reserveIn = rA;
    var reserveOut = rB;

    if (tokenIn && poolConfig && poolConfig.tokens) {
      var tokens = poolConfig.tokens;
      if (tokens.length >= 2) {
        var isTokenA = (tokenIn.toUpperCase && tokenIn.toUpperCase() === 'USDC');
        if (!isTokenA) {
          reserveIn = rB;
          reserveOut = rA;
        }
      }
    }

    result.reserveIn = reserveIn;
    result.reserveOut = reserveOut;

    var impact = _constantProductPriceImpact(amt, reserveIn);
    result.priceImpact = parseFloat(impact.toFixed(3));
    result.poolUtilization = parseFloat(((amt / reserveIn) * 100).toFixed(2));

    var tierKeys = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
    var tiers = [TIERS.LOW, TIERS.MEDIUM, TIERS.HIGH, TIERS.CRITICAL];
    for (var i = 0; i < tiers.length; i++) {
      if (impact <= tiers[i].max) {
        result.tier = tierKeys[i];
        result.tierLabel = tiers[i].label;
        result.tierColor = tiers[i].color;
        break;
      }
    }
    if (!result.tier) {
      result.tier = 'CRITICAL';
      result.tierLabel = TIERS.CRITICAL.label;
      result.tierColor = TIERS.CRITICAL.color;
    }

    result.requiresWarning = impact > WARN_THRESHOLD;
    result.requiresConfirmation = impact > CONFIRM_THRESHOLD;
    result.blocksSwap = impact > BLOCK_THRESHOLD;

    if (impact > 15) {
      result.recommendations.push('Swap blocked: price impact exceeds ' + BLOCK_THRESHOLD + '% threshold.');
    } else if (impact > 10) {
      result.recommendations.push('High price impact detected (' + impact.toFixed(1) + '%). Additional confirmation required.');
    } else if (impact > 5) {
      result.recommendations.push('Elevated price impact (' + impact.toFixed(1) + '%). Consider reducing swap size.');
    }

    result.valid = true;
    return result;
  }

  function calculateFromReserves(amountIn, reserveA, reserveB, reserveADecimals, reserveBDecimals) {
    var decA = reserveADecimals || 6;
    var decB = reserveBDecimals || 6;
    var scaledA = Number(reserveA) / Math.pow(10, decA);
    var scaledB = Number(reserveB) / Math.pow(10, decB);
    var scaledAmt = Number(amountIn) / Math.pow(10, decA);
    return calculate(scaledAmt, scaledA, scaledB);
  }

  function formatPriceImpact(impact) {
    if (impact == null || isNaN(impact)) return 'N/A';
    return impact.toFixed(2) + '%';
  }

  function configure(thresholds) {
    if (thresholds) {
      WARN_THRESHOLD = thresholds.warn || WARN_THRESHOLD;
      CONFIRM_THRESHOLD = thresholds.confirm || CONFIRM_THRESHOLD;
      BLOCK_THRESHOLD = thresholds.block || BLOCK_THRESHOLD;
    }
  }

  function getConfig() {
    return {
      warnThreshold: WARN_THRESHOLD,
      confirmThreshold: CONFIRM_THRESHOLD,
      blockThreshold: BLOCK_THRESHOLD,
      tiers: TIERS
    };
  }

  window.PriceImpactEngine = {
    calculate: calculate,
    calculateFromReserves: calculateFromReserves,
    formatPriceImpact: formatPriceImpact,
    configure: configure,
    getConfig: getConfig,
    TIERS: TIERS,
    WARN_THRESHOLD: WARN_THRESHOLD,
    CONFIRM_THRESHOLD: CONFIRM_THRESHOLD,
    BLOCK_THRESHOLD: BLOCK_THRESHOLD
  };
})();
