/**
 * Elligentt Pool Alert System (FASE 3.8)
 * ═══════════════════════════════════════
 * Alert types: low liquidity, critical liquidity, price anomaly, TWAP deviation,
 * oracle deviation, high price impact, whale swap, pool health critical,
 * liquidity removal, unhealthy pool.
 * Attached to window.PoolAlertSystem
 */
(function(){
  'use strict';

  var ALERT_KEY = 'elligentt_pool_alerts_v1';
  var MAX_ALERTS = 200;

  var alerts = [];

  function load() {
    try {
      var raw = localStorage.getItem(ALERT_KEY);
      if (raw) alerts = JSON.parse(raw);
    } catch(e) { alerts = []; }
    _prune();
  }

  function save() {
    try { localStorage.setItem(ALERT_KEY, JSON.stringify(alerts)); } catch(e) {}
  }

  function _prune() {
    var cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7d
    alerts = alerts.filter(function(a) { return a.timestamp > cutoff; });
    if (alerts.length > MAX_ALERTS) {
      alerts = alerts.slice(alerts.length - MAX_ALERTS);
    }
  }

  function _add(type, severity, detail, action, data) {
    var alert = {
      id: 'alert_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      type: type,
      severity: severity,
      detail: detail,
      action: action || 'Monitor situation.',
      timestamp: Date.now(),
      data: data || {},
      acknowledged: false
    };
    alerts.push(alert);
    _prune();
    save();
    return alert;
  }

  function triggerLowLiquidity(reserveA, threshold) { return _add('Low Liquidity', 'MEDIUM', 'Pool liquidity below ' + (threshold || 'threshold') + ': ' + reserveA + ' USDC', 'Consider adding liquidity.'); }
  function triggerCriticalLiquidity(reserveA) { return _add('Critical Liquidity', 'HIGH', 'Pool liquidity critically low: ' + reserveA + ' USDC', 'Urgent: add liquidity or pause operations.'); }
  function triggerPriceAnomaly(deviationPct) { return _add('Price Anomaly', 'HIGH', 'Price deviation of ' + deviationPct.toFixed(2) + '% detected', 'Verify price sources. Check for manipulation.'); }
  function triggerTWAPDeviation(deviationPct) { return _add('TWAP Deviation', 'MEDIUM', 'Spot/TWAP deviation: ' + deviationPct.toFixed(2) + '%', 'Monitor price stability.'); }
  function triggerOracleDeviation(source, deviationPct) { return _add('Oracle Deviation', 'MEDIUM', 'Price deviation between oracles: ' + deviationPct.toFixed(2) + '% (' + source + ')', 'Cross-check price feeds.'); }
  function triggerHighPriceImpact(impact) { return _add('High Price Impact', 'HIGH', 'Price impact of ' + impact.toFixed(1) + '% on recent swap', 'Verify swap size relative to liquidity.'); }
  function triggerWhaleSwap(utilizationPct) { return _add('Whale Swap Detection', 'HIGH', 'Large swap detected: ' + utilizationPct.toFixed(1) + '% of pool liquidity', 'Review swap parameters.'); }
  function triggerPoolHealthCritical(score) { return _add('Pool Health Critical', 'CRITICAL', 'Pool health dropped to ' + score + '/10', 'Immediate investigation required.'); }
  function triggerLiquidityRemoval(amount, pct) { return _add('Liquidity Removal', 'HIGH', 'Liquidity removal: ' + amount + ' (' + pct + '% of pool)', 'Monitor remaining liquidity.'); }
  function triggerUnhealthyPool(reason) { return _add('Unhealthy Pool', 'HIGH', 'Pool is unhealthy: ' + (reason || 'Unknown reason'), 'Run health check diagnostics.'); }
  function triggerReserveDrain(reserve, pct) { return _add('Reserve Drain', 'CRITICAL', reserve + ' dropped ' + pct.toFixed(1) + '%', 'URGENT: investigate possible attack.'); }
  function triggerEconomicRisk(level, score) { return _add('Economic Risk - ' + level, level === 'CRITICAL' ? 'CRITICAL' : 'HIGH', 'Economic risk level ' + level + ' (score: ' + score + ')', 'Review all economic parameters.'); }

  var alertDefinitions = {
    lowLiquidity: triggerLowLiquidity,
    criticalLiquidity: triggerCriticalLiquidity,
    priceAnomaly: triggerPriceAnomaly,
    twapDeviation: triggerTWAPDeviation,
    oracleDeviation: triggerOracleDeviation,
    highPriceImpact: triggerHighPriceImpact,
    whaleSwap: triggerWhaleSwap,
    poolHealthCritical: triggerPoolHealthCritical,
    liquidityRemoval: triggerLiquidityRemoval,
    unhealthyPool: triggerUnhealthyPool,
    reserveDrain: triggerReserveDrain,
    economicRisk: triggerEconomicRisk
  };

  function getAlerts(hours, severity) {
    load();
    var cutoff = Date.now() - (hours || 24) * 60 * 60 * 1000;
    var filtered = alerts.filter(function(a) { return a.timestamp > cutoff; });
    if (severity) {
      filtered = filtered.filter(function(a) { return a.severity === severity; });
    }
    return filtered;
  }

  function getUnacknowledged() {
    load();
    return alerts.filter(function(a) { return !a.acknowledged; });
  }

  function acknowledge(alertId) {
    for (var i = 0; i < alerts.length; i++) {
      if (alerts[i].id === alertId) {
        alerts[i].acknowledged = true;
        save();
        return true;
      }
    }
    return false;
  }

  function acknowledgeAll() {
    for (var i = 0; i < alerts.length; i++) {
      alerts[i].acknowledged = true;
    }
    save();
    return alerts.length;
  }

  function getActiveAlertCount() {
    load();
    return alerts.filter(function(a) { return !a.acknowledged; }).length;
  }

  function getSeverityCounts() {
    load();
    var critical = alerts.filter(function(a) { return a.severity === 'CRITICAL'; }).length;
    var high = alerts.filter(function(a) { return a.severity === 'HIGH'; }).length;
    var medium = alerts.filter(function(a) { return a.severity === 'MEDIUM'; }).length;
    var low = alerts.filter(function(a) { return a.severity === 'LOW'; }).length;
    return { CRITICAL: critical, HIGH: high, MEDIUM: medium, LOW: low };
  }

  function clearAll() {
    alerts = [];
    save();
  }

  load();

  window.PoolAlertSystem = {
    triggerLowLiquidity: triggerLowLiquidity,
    triggerCriticalLiquidity: triggerCriticalLiquidity,
    triggerPriceAnomaly: triggerPriceAnomaly,
    triggerTWAPDeviation: triggerTWAPDeviation,
    triggerOracleDeviation: triggerOracleDeviation,
    triggerHighPriceImpact: triggerHighPriceImpact,
    triggerWhaleSwap: triggerWhaleSwap,
    triggerPoolHealthCritical: triggerPoolHealthCritical,
    triggerLiquidityRemoval: triggerLiquidityRemoval,
    triggerUnhealthyPool: triggerUnhealthyPool,
    triggerReserveDrain: triggerReserveDrain,
    triggerEconomicRisk: triggerEconomicRisk,
    getAlerts: getAlerts,
    getUnacknowledged: getUnacknowledged,
    acknowledge: acknowledge,
    acknowledgeAll: acknowledgeAll,
    getActiveAlertCount: getActiveAlertCount,
    getSeverityCounts: getSeverityCounts,
    clearAll: clearAll
  };
})();
