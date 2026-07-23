/**
 * Elligentt Low Liquidity Protection (FASE 2.5)
 * ═══════════════════════════════════════
 * Warns/blocks swaps when they represent a large % of pool liquidity.
 * Configurable thresholds for notification, confirmation, and blocking.
 * Attached to window.LiquidityProtection
 */
(function(){
  'use strict';

  var WARN_PCT = 5;
  var CONFIRM_PCT = 10;
  var BLOCK_PCT = 20;

  function check(swapAmount, reserveIn, config) {
    var result = {
      valid: false,
      poolUtilizationPct: 0,
      tier: 'LOW',
      requiresWarning: false,
      requiresConfirmation: false,
      blocksSwap: false,
      message: null,
      recommendations: []
    };

    if (!swapAmount || isNaN(Number(swapAmount)) || Number(swapAmount) <= 0) {
      result.error = 'Invalid swap amount';
      return result;
    }
    if (!reserveIn || Number(reserveIn) <= 0) {
      result.error = 'Invalid reserve data';
      return result;
    }

    var warnPct = (config && config.warnPct != null) ? config.warnPct : WARN_PCT;
    var confirmPct = (config && config.confirmPct != null) ? config.confirmPct : CONFIRM_PCT;
    var blockPct = (config && config.blockPct != null) ? config.blockPct : BLOCK_PCT;

    var amt = Number(swapAmount);
    var res = Number(reserveIn);
    var utilizationPct = (amt / res) * 100;

    result.poolUtilizationPct = parseFloat(utilizationPct.toFixed(2));

    if (utilizationPct >= blockPct) {
      result.tier = 'CRITICAL';
      result.blocksSwap = true;
      result.message = 'Swap uses ' + utilizationPct.toFixed(1) + '% of pool liquidity (limit: ' + blockPct + '%). Blocked for protection.';
    } else if (utilizationPct >= confirmPct) {
      result.tier = 'HIGH';
      result.requiresConfirmation = true;
      result.message = 'Swap uses ' + utilizationPct.toFixed(1) + '% of pool liquidity. Additional confirmation required.';
    } else if (utilizationPct >= warnPct) {
      result.tier = 'MEDIUM';
      result.requiresWarning = true;
      result.message = 'Swap uses ' + utilizationPct.toFixed(1) + '% of pool liquidity.';
    } else {
      result.tier = 'LOW';
      result.message = 'Swap represents ' + utilizationPct.toFixed(2) + '% of pool liquidity.';
    }

    if (utilizationPct >= confirmPct) {
      result.recommendations.push('Consider splitting into smaller transactions.');
      result.recommendations.push('Slippage may be higher than expected.');
    }

    result.valid = true;
    return result;
  }

  function configure(options) {
    if (options) {
      if (options.warnPct != null) WARN_PCT = options.warnPct;
      if (options.confirmPct != null) CONFIRM_PCT = options.confirmPct;
      if (options.blockPct != null) BLOCK_PCT = options.blockPct;
    }
    return { warnPct: WARN_PCT, confirmPct: CONFIRM_PCT, blockPct: BLOCK_PCT };
  }

  function getConfig() {
    return { warnPct: WARN_PCT, confirmPct: CONFIRM_PCT, blockPct: BLOCK_PCT };
  }

  window.LiquidityProtection = {
    check: check,
    configure: configure,
    getConfig: getConfig,
    WARN_PCT: WARN_PCT,
    CONFIRM_PCT: CONFIRM_PCT,
    BLOCK_PCT: BLOCK_PCT
  };
})();
