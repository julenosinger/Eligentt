/**
 * Elligentt Anti-Whale Protection (FASE 3.7)
 * ═══════════════════════════════════════
 * Protects pool from excessively large swaps.
 * Thresholds: 5% warn, 10% confirm, 20% high risk, 25% block.
 * All configurable. Attached to window.AntiWhaleProtection
 */
(function(){
  'use strict';

  var THRESHOLDS = {
    WARNING:    5,
    CONFIRM:   10,
    HIGH_RISK: 20,
    BLOCK:     25
  };

  function check(swapAmount, reserveIn, config) {
    var result = {
      valid: false,
      swapAmount: Number(swapAmount),
      reserveIn: Number(reserveIn),
      utilizationPct: 0,
      tier: 'NORMAL',
      requiresWarning: false,
      requiresConfirmation: false,
      isHighRisk: false,
      blocksSwap: false,
      message: null,
      recommendations: []
    };

    if (!swapAmount || swapAmount <= 0 || !reserveIn || reserveIn <= 0) {
      result.error = 'Invalid swap or reserve data';
      return result;
    }

    var t = config || THRESHOLDS;
    var util = (swapAmount / reserveIn) * 100;
    result.utilizationPct = parseFloat(util.toFixed(2));

    if (util >= t.BLOCK) {
      result.tier = 'BLOCKED';
      result.blocksSwap = true;
      result.message = 'Swap blocked: ' + util.toFixed(1) + '% of pool liquidity exceeds max of ' + t.BLOCK + '%.';
      result.recommendations.push('Split into multiple smaller swaps.');
      result.recommendations.push('Consider using a different liquidity source.');
    } else if (util >= t.HIGH_RISK) {
      result.tier = 'HIGH_RISK';
      result.isHighRisk = true;
      result.requiresConfirmation = true;
      result.message = 'High risk: swap uses ' + util.toFixed(1) + '% of pool liquidity. Strong confirmation required.';
      result.recommendations.push('This swap may cause significant price impact.');
      result.recommendations.push('Consider reducing swap size.');
    } else if (util >= t.CONFIRM) {
      result.tier = 'CONFIRM_REQUIRED';
      result.requiresConfirmation = true;
      result.message = 'Swap uses ' + util.toFixed(1) + '% of pool liquidity. Confirmation required.';
      result.recommendations.push('Price impact may be higher than expected.');
    } else if (util >= t.WARNING) {
      result.tier = 'WARNING';
      result.requiresWarning = true;
      result.message = 'Swap uses ' + util.toFixed(1) + '% of pool liquidity.';
    } else {
      result.tier = 'NORMAL';
      result.message = 'Swap represents ' + util.toFixed(2) + '% of pool liquidity. Safe.';
    }

    result.valid = true;
    return result;
  }

  function configure(thresholds) {
    if (thresholds) {
      if (thresholds.warning != null) THRESHOLDS.WARNING = thresholds.warning;
      if (thresholds.confirm != null) THRESHOLDS.CONFIRM = thresholds.confirm;
      if (thresholds.highRisk != null) THRESHOLDS.HIGH_RISK = thresholds.highRisk;
      if (thresholds.block != null) THRESHOLDS.BLOCK = thresholds.block;
    }
    return getConfig();
  }

  function getConfig() {
    return {
      warning: THRESHOLDS.WARNING,
      confirm: THRESHOLDS.CONFIRM,
      highRisk: THRESHOLDS.HIGH_RISK,
      block: THRESHOLDS.BLOCK
    };
  }

  function getMaxSwapAmount(reserveIn, tier) {
    var pct = THRESHOLDS[tier] || THRESHOLDS.BLOCK;
    return reserveIn * pct / 100;
  }

  window.AntiWhaleProtection = {
    check: check,
    configure: configure,
    getConfig: getConfig,
    getMaxSwapAmount: getMaxSwapAmount,
    THRESHOLDS: THRESHOLDS
  };
})();
