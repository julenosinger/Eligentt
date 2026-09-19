/**
 * Elligentt Economic Risk Engine (FASE 2.8)
 * ═══════════════════════════════════════
 * Combined economic risk analysis factoring: slippage, price impact,
 * liquidity, pool health, and volatility.
 * Attached to window.EconomicRiskEngine
 */
(function(){
  'use strict';

  function analyze(config) {
    var result = {
      valid: false,
      level: 'LOW',
      levelColor: '#22c55e',
      score: 0,
      maxScore: 100,
      factors: [],
      recommendation: '',
      requiresConfirmation: false,
      blocksSwap: false
    };

    var swapAmount = Number(config.amount || 0);
    if (!swapAmount || swapAmount <= 0) {
      result.error = 'Invalid swap amount';
      return result;
    }

    var score = 0;
    var maxScore = 100;

    // Factor 1: Price Impact (0-35 points)
    if (config.priceImpact != null) {
      var impact = Number(config.priceImpact);
      var impactScore = 0;
      if (impact <= 1) impactScore = 0;
      else if (impact <= 5) impactScore = 10;
      else if (impact <= 10) impactScore = 20;
      else if (impact <= 15) impactScore = 30;
      else impactScore = 35;
      score += impactScore;
      result.factors.push({
        name: 'Price Impact',
        value: impact.toFixed(2) + '%',
        score: impactScore,
        max: 35,
        tier: impact > 10 ? 'HIGH' : impact > 5 ? 'MEDIUM' : 'LOW'
      });
    }

    // Factor 2: Slippage (0-20 points)
    if (config.slippageBps != null) {
      var slipPct = Number(config.slippageBps) / 100;
      var slipScore = 0;
      if (slipPct <= 0.5) slipScore = 0;
      else if (slipPct <= 1) slipScore = 5;
      else if (slipPct <= 2) slipScore = 10;
      else slipScore = 20;
      score += slipScore;
      result.factors.push({
        name: 'Slippage',
        value: slipPct.toFixed(2) + '%',
        score: slipScore,
        max: 20,
        tier: slipPct > 2 ? 'HIGH' : slipPct > 1 ? 'MEDIUM' : 'LOW'
      });
    }

    // Factor 3: Liquidity Utilization (0-25 points)
    if (config.poolUtilizationPct != null) {
      var utilPct = Number(config.poolUtilizationPct);
      var utilScore = 0;
      if (utilPct <= 5) utilScore = 0;
      else if (utilPct <= 10) utilScore = 8;
      else if (utilPct <= 20) utilScore = 16;
      else utilScore = 25;
      score += utilScore;
      result.factors.push({
        name: 'Liquidity Utilization',
        value: utilPct.toFixed(1) + '% of pool',
        score: utilScore,
        max: 25,
        tier: utilPct > 20 ? 'CRITICAL' : utilPct > 10 ? 'HIGH' : utilPct > 5 ? 'MEDIUM' : 'LOW'
      });

      if (utilPct > 20) {
        result.blocksSwap = true;
      }
    }

    // Factor 4: Pool Health (0-20 points)
    if (config.healthScore != null) {
      var healthScoreRaw = Number(config.healthScore);
      var healthScore = 0;
      if (healthScoreRaw >= 8) healthScore = 0;
      else if (healthScoreRaw >= 6) healthScore = 5;
      else if (healthScoreRaw >= 4) healthScore = 10;
      else if (healthScoreRaw >= 2) healthScore = 15;
      else healthScore = 20;
      score += healthScore;
      result.factors.push({
        name: 'Pool Health',
        value: healthScoreRaw + '/10',
        score: healthScore,
        max: 20,
        tier: healthScoreRaw < 4 ? 'HIGH' : healthScoreRaw < 6 ? 'MEDIUM' : 'LOW'
      });
    }

    result.score = Math.min(maxScore, score);

    if (result.score <= 20) {
      result.level = 'LOW';
      result.levelColor = '#22c55e';
      result.recommendation = 'Standard swap conditions. Safe to execute.';
    } else if (result.score <= 45) {
      result.level = 'MEDIUM';
      result.levelColor = '#f59e0b';
      result.recommendation = 'Moderate economic risk. Review details before proceeding.';
      result.requiresConfirmation = true;
    } else if (result.score <= 70) {
      result.level = 'HIGH';
      result.levelColor = '#f97316';
      result.recommendation = 'High economic risk. Explicit confirmation required.';
      result.requiresConfirmation = true;
    } else {
      result.level = 'CRITICAL';
      result.levelColor = '#ef4444';
      result.recommendation = 'Critical economic risk. Swap not recommended.';
      result.requiresConfirmation = true;
      if (result.score > 85) {
        result.blocksSwap = true;
      }
    }

    result.valid = true;
    return result;
  }

  function quickAnalyze(amount, priceImpact, poolUtilization, healthScore) {
    return analyze({
      amount: amount,
      priceImpact: priceImpact,
      slippageBps: 100,
      poolUtilizationPct: poolUtilization,
      healthScore: healthScore
    });
  }

  function formatReport(result) {
    if (!result || !result.valid) return 'Economic risk analysis not performed.';
    var lines = [];
    lines.push('=== Economic Risk Report ===');
    lines.push('Level: ' + result.level + ' (' + result.score + '/' + result.maxScore + ')');
    for (var i = 0; i < result.factors.length; i++) {
      var f = result.factors[i];
      lines.push('  ' + f.name + ': ' + f.value + ' [' + f.tier + '] (' + f.score + '/' + f.max + ' pts)');
    }
    lines.push('Recommendation: ' + result.recommendation);
    if (result.requiresConfirmation) lines.push('CONFIRMATION REQUIRED');
    if (result.blocksSwap) lines.push('SWAP BLOCKED');
    return lines.join('\n');
  }

  window.EconomicRiskEngine = {
    analyze: analyze,
    quickAnalyze: quickAnalyze,
    formatReport: formatReport
  };
})();
