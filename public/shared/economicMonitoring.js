/**
 * Elligentt Economic Monitoring Engine (FASE 3.9)
 * ═══════════════════════════════════════
 * Unified economic score combining all engines:
 * Price Oracle, TWAP, Pool Monitor, Liquidity Protection,
 * Historical Metrics, Anti-Whale, Pool Health, Economic Risk.
 * Attached to window.EconomicMonitoring
 */
(function(){
  'use strict';

  var MONITORING_KEY = 'elligentt_economic_monitoring_v1';
  var lastScore = null;

  function load() {
    try {
      var raw = localStorage.getItem(MONITORING_KEY);
      if (raw) lastScore = JSON.parse(raw);
    } catch(e) { lastScore = null; }
  }

  function save() {
    try { localStorage.setItem(MONITORING_KEY, JSON.stringify(lastScore)); } catch(e) {}
  }

  function _scoreOracle() {
    try {
      if (typeof PriceOracleEngine === 'undefined') return 0;
      var status = PriceOracleEngine.getActiveSource();
      var sources = PriceOracleEngine.getSupportedSources();
      if (status === 'unknown') return 0;
      if (status.indexOf('twap') >= 0) return 2;
      if (status === 'pool') return 1;
      return 1;
    } catch(e) { return 0; }
  }

  function _scoreTWAP() {
    try {
      if (typeof TwapEngine === 'undefined') return 0;
      var count = TwapEngine.getSnapshotCount();
      if (count >= 20) return 3;
      if (count >= 10) return 2;
      if (count >= 5) return 1;
      return 0;
    } catch(e) { return 0; }
  }

  function _scoreReserves(reserveA, reserveB) {
    if (!reserveA || reserveA <= 0) return 0;
    var rA = Number(reserveA), rB = Number(reserveB || 0);
    var tvl = rA + rB * 67000;
    if (tvl >= 100000) return 5;
    if (tvl >= 50000) return 4;
    if (tvl >= 20000) return 3;
    if (tvl >= 10000) return 2;
    if (tvl >= 5000) return 1;
    return 0;
  }

  function _scoreHealth(healthScore) {
    if (healthScore == null) return 0;
    if (healthScore >= 8) return 4;
    if (healthScore >= 6) return 3;
    if (healthScore >= 4) return 2;
    if (healthScore >= 2) return 1;
    return 0;
  }

  function _scoreRisk(riskLevel) {
    var map = { LOW: 4, MEDIUM: 2, HIGH: 1, CRITICAL: 0 };
    return map[riskLevel] != null ? map[riskLevel] : 2;
  }

  function _scoreMonitoring() {
    try {
      if (typeof PoolMonitor !== 'undefined' && PoolMonitor.isActive()) return 2;
      return 0;
    } catch(e) { return 0; }
  }

  function _scoreHistory() {
    try {
      if (typeof HistoricalMetrics === 'undefined') return 0;
      var count = HistoricalMetrics.getSnapshotCount();
      if (count >= 100) return 2;
      if (count >= 20) return 1;
      return 0;
    } catch(e) { return 0; }
  }

  function getUnifiedScore(data) {
    var result = {
      valid: false,
      totalScore: 0,
      maxScore: 22,
      tier: 'Critical',
      tierColor: '#ef4444',
      factors: [],
      timestamp: Date.now()
    };

    var scores = {
      oracle: _scoreOracle(),
      twap: _scoreTWAP(),
      reserves: _scoreReserves(data.reserveA, data.reserveB),
      health: _scoreHealth(data.healthScore),
      risk: _scoreRisk(data.riskLevel),
      monitoring: _scoreMonitoring(),
      history: _scoreHistory()
    };

    result.factors = [
      { name: 'Oracle Coverage', score: scores.oracle, max: 3, detail: 'Price data sources available' },
      { name: 'TWAP Maturity', score: scores.twap, max: 3, detail: 'Time-weighted data points' },
      { name: 'Reserves / TVL', score: scores.reserves, max: 5, detail: '~$' + (data.reserveA + (data.reserveB || 0) * 67000).toFixed(0) + ' TVL' },
      { name: 'Pool Health', score: scores.health, max: 4, detail: (data.healthScore || 'N/A') + '/10' },
      { name: 'Risk Profile', score: scores.risk, max: 4, detail: data.riskLevel || 'Unknown' },
      { name: 'Active Monitoring', score: scores.monitoring, max: 2, detail: scores.monitoring > 0 ? 'Active' : 'Inactive' },
      { name: 'Historical Data', score: scores.history, max: 2, detail: 'Data points accumulated' }
    ];

    result.totalScore = scores.oracle + scores.twap + scores.reserves + scores.health + scores.risk + scores.monitoring + scores.history;

    var tiers = [
      { min: 19, label: 'Excellent', color: '#22c55e' },
      { min: 14, label: 'Good', color: '#4ade80' },
      { min: 9, label: 'Moderate', color: '#f59e0b' },
      { min: 4, label: 'Low', color: '#f97316' },
      { min: 0, label: 'Critical', color: '#ef4444' }
    ];

    for (var i = 0; i < tiers.length; i++) {
      if (result.totalScore >= tiers[i].min) {
        result.tier = tiers[i].label;
        result.tierColor = tiers[i].color;
        break;
      }
    }

    result.valid = true;
    lastScore = result;
    save();
    return result;
  }

  function getLastScore() {
    load();
    return lastScore;
  }

  function formatReport(result) {
    if (!result || !result.valid) return 'Economic monitoring not performed.';
    var lines = [];
    lines.push('=== Economic Monitoring Report ===');
    lines.push('Score: ' + result.totalScore + '/' + result.maxScore + ' — ' + result.tier);
    for (var i = 0; i < result.factors.length; i++) {
      var f = result.factors[i];
      lines.push('  ' + f.name + ': ' + f.score + '/' + f.max + ' — ' + f.detail);
    }
    return lines.join('\n');
  }

  load();

  window.EconomicMonitoring = {
    getUnifiedScore: getUnifiedScore,
    getLastScore: getLastScore,
    formatReport: formatReport
  };
})();
