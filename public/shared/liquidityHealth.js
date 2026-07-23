/**
 * Elligentt Liquidity Health Engine (FASE 2.4)
 * ═══════════════════════════════════════
 * Scores pool liquidity health on a 0-10 scale.
 * Analyzes: total liquidity, LP supply, fee, reserves, volume.
 * Attached to window.LiquidityHealthEngine
 */
(function(){
  'use strict';

  var HEALTH_TIERS = {
    EXCELLENT:  { min: 8,  max: 10, label: 'Excellent', color: '#22c55e' },
    GOOD:       { min: 6,  max: 8,  label: 'Good',      color: '#4ade80' },
    MODERATE:   { min: 4,  max: 6,  label: 'Moderate',  color: '#f59e0b' },
    LOW:        { min: 2,  max: 4,  label: 'Low',       color: '#f97316' },
    CRITICAL:   { min: 0,  max: 2,  label: 'Critical',  color: '#ef4444' }
  };

  function _scoreLiquidity(totalValueUsd) {
    if (totalValueUsd >= 100000) return 5;
    if (totalValueUsd >= 50000) return 4;
    if (totalValueUsd >= 20000) return 3;
    if (totalValueUsd >= 10000) return 2;
    if (totalValueUsd >= 5000) return 1;
    return 0;
  }

  function _scoreDiversity(tokenCount) {
    if (tokenCount >= 5) return 3;
    if (tokenCount >= 3) return 2;
    if (tokenCount >= 2) return 1;
    return 0;
  }

  function _scoreStability(supply, reserveA, reserveB) {
    if (!supply || supply <= 0) return 0;
    if (!reserveA || !reserveB) return 0;
    var ratio = reserveA > 0 && reserveB > 0 ? Math.min(reserveA, reserveB) / Math.max(reserveA, reserveB) : 0;
    if (ratio > 0.8) return 2;
    if (ratio > 0.5) return 1;
    return 0;
  }

  function analyze(poolData) {
    var result = {
      score: 0,
      tier: 'Critical',
      tierColor: '#ef4444',
      tierLabel: 'Critical',
      factors: [],
      valid: false
    };

    if (!poolData) {
      result.error = 'No pool data provided';
      return result;
    }

    var totalScore = 0;
    var maxScore = 10;

    var reserveA = Number(poolData.reserveA || 0);
    var reserveB = Number(poolData.reserveB || 0);
    var lpSupply = Number(poolData.lpSupply || 0);
    var tokens = poolData.tokens || ['USDC', 'cirBTC'];
    var totalValueUsd = reserveA + (Number(poolData.reserveBValueUsd) || 0);

    var liqScore = _scoreLiquidity(totalValueUsd);
    totalScore += liqScore;
    result.factors.push({ factor: 'Liquidity', score: liqScore, max: 5, detail: '$' + totalValueUsd.toFixed(0) + ' TVL' });

    var diversityScore = _scoreDiversity(tokens.length);
    totalScore += diversityScore;
    result.factors.push({ factor: 'Diversity', score: diversityScore, max: 3, detail: tokens.length + ' tokens' });

    var stabilityScore = _scoreStability(lpSupply, reserveA, reserveB);
    totalScore += stabilityScore;
    result.factors.push({ factor: 'Stability', score: stabilityScore, max: 2, detail: 'Reserve balance ratio' });

    result.score = Math.min(10, Math.max(0, totalScore));

    var tierKeys = ['CRITICAL', 'LOW', 'MODERATE', 'GOOD', 'EXCELLENT'];
    var tiers = [HEALTH_TIERS.CRITICAL, HEALTH_TIERS.LOW, HEALTH_TIERS.MODERATE, HEALTH_TIERS.GOOD, HEALTH_TIERS.EXCELLENT];
    for (var i = tiers.length - 1; i >= 0; i--) {
      if (result.score >= tiers[i].min && result.score <= tiers[i].max) {
        result.tier = tierKeys[i];
        result.tierLabel = tiers[i].label;
        result.tierColor = tiers[i].color;
        break;
      }
    }

    result.reserveA = reserveA;
    result.reserveB = reserveB;
    result.lpSupply = lpSupply;
    result.totalValueUsd = totalValueUsd;
    result.maxScore = maxScore;
    result.valid = true;

    return result;
  }

  function quickScore(totalLiquidityUsd, tokenCount) {
    var liqScore = _scoreLiquidity(totalLiquidityUsd);
    var divScore = _scoreDiversity(tokenCount || 2);
    var total = liqScore + divScore;
    var score = Math.min(10, Math.max(0, total));

    var tiers = [HEALTH_TIERS.CRITICAL, HEALTH_TIERS.LOW, HEALTH_TIERS.MODERATE, HEALTH_TIERS.GOOD, HEALTH_TIERS.EXCELLENT];
    for (var i = tiers.length - 1; i >= 0; i--) {
      if (score >= tiers[i].min && score <= tiers[i].max) {
        return { score: score, label: tiers[i].label, color: tiers[i].color };
      }
    }
    return { score: 0, label: 'Critical', color: '#ef4444' };
  }

  function formatHealthScore(analysis) {
    if (!analysis || !analysis.valid) return 'N/A';
    return analysis.score + '/10 (' + analysis.tierLabel + ')';
  }

  window.LiquidityHealthEngine = {
    analyze: analyze,
    quickScore: quickScore,
    formatHealthScore: formatHealthScore,
    HEALTH_TIERS: HEALTH_TIERS,
    _scoreLiquidity: _scoreLiquidity,
    _scoreDiversity: _scoreDiversity,
    _scoreStability: _scoreStability
  };
})();
