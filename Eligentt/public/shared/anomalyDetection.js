/**
 * Elligentt Anomaly Detection Engine (FASE 3.4)
 * ═══════════════════════════════════════
 * Detects: price manipulation, liquidity manipulation, reserve manipulation,
 * suspicious swaps, liquidity removal, economic attacks.
 * Attached to window.AnomalyDetection
 */
(function(){
  'use strict';

  function check(config) {
    var anomalies = [];
    var current = config.current;
    var previous = config.previous;

    // 1. Reserve change detection
    if (current && previous) {
      var reserveAChange = Math.abs((current.reserveA || 0) - (previous.reserveA || 0));
      var reserveBChange = Math.abs((current.reserveB || 0) - (previous.reserveB || 0));
      var reserveAPct = previous.reserveA > 0 ? (reserveAChange / previous.reserveA) * 100 : 0;
      var reserveBPct = previous.reserveB > 0 ? (reserveBChange / previous.reserveB) * 100 : 0;

      if (reserveAPct > 50) {
        anomalies.push({
          type: 'Reserve Drain',
          severity: 'CRITICAL',
          category: 'liquidity',
          detail: 'Reserve A dropped ' + reserveAPct.toFixed(1) + '% in one interval',
          reserveAChange: reserveAChange,
          reserveAPct: parseFloat(reserveAPct.toFixed(2))
        });
      } else if (reserveAPct > 20) {
        anomalies.push({
          type: 'Reserve Change',
          severity: 'HIGH',
          category: 'liquidity',
          detail: 'Reserve A changed ' + reserveAPct.toFixed(1) + '%',
          reserveAChange: reserveAChange,
          reserveAPct: parseFloat(reserveAPct.toFixed(2))
        });
      } else if (reserveAPct > 10) {
        anomalies.push({
          type: 'Reserve Fluctuation',
          severity: 'MEDIUM',
          category: 'liquidity',
          detail: 'Reserve A moved ' + reserveAPct.toFixed(1) + '%',
          reserveAPct: parseFloat(reserveAPct.toFixed(2))
        });
      }

      if (reserveBPct > 50) {
        anomalies.push({
          type: 'Reserve Drain',
          severity: 'CRITICAL',
          category: 'liquidity',
          detail: 'Reserve B dropped ' + reserveBPct.toFixed(1) + '% in one interval',
          reserveBChange: reserveBChange,
          reserveBPct: parseFloat(reserveBPct.toFixed(2))
        });
      }
    }

    // 2. TWAP deviation
    if (config.twap && config.twap.twapAB && current) {
      var spotPrice = current.reserveB > 0 ? current.reserveA / current.reserveB : 0;
      var twapDeviation = Math.abs(spotPrice - config.twap.twapAB) / config.twap.twapAB * 100;

      if (twapDeviation > 10) {
        anomalies.push({
          type: 'TWAP Deviation',
          severity: 'CRITICAL',
          category: 'price',
          detail: 'Spot price deviates ' + twapDeviation.toFixed(2) + '% from TWAP-15m — possible manipulation',
          deviationPct: parseFloat(twapDeviation.toFixed(2)),
          spotPrice: parseFloat(spotPrice.toFixed(6)),
          twapPrice: config.twap.twapAB
        });
      } else if (twapDeviation > 5) {
        anomalies.push({
          type: 'TWAP Deviation',
          severity: 'HIGH',
          category: 'price',
          detail: 'Price deviates ' + twapDeviation.toFixed(2) + '% from TWAP-15m',
          deviationPct: parseFloat(twapDeviation.toFixed(2))
        });
      } else if (twapDeviation > 2) {
        anomalies.push({
          type: 'Price Drift',
          severity: 'MEDIUM',
          category: 'price',
          detail: 'Minor price drift: ' + twapDeviation.toFixed(2) + '%',
          deviationPct: parseFloat(twapDeviation.toFixed(2))
        });
      }
    }

    // 3. Health score degradation
    if (config.healthScore != null) {
      var prevHealth = config.previousHealthScore;
      if (typeof prevHealth === 'number' && prevHealth > 4 && config.healthScore <= 2) {
        anomalies.push({
          type: 'Health Collapse',
          severity: 'CRITICAL',
          category: 'health',
          detail: 'Pool health dropped from ' + prevHealth + ' to ' + config.healthScore,
          previousScore: prevHealth,
          currentScore: config.healthScore
        });
      } else if (config.healthScore <= 2) {
        anomalies.push({
          type: 'Unhealthy Pool',
          severity: 'HIGH',
          category: 'health',
          detail: 'Pool health is critical: ' + config.healthScore + '/10',
          healthScore: config.healthScore
        });
      }
    }

    // 4. Extreme price impact detection
    if (config.priceImpact != null && config.priceImpact > 15) {
      anomalies.push({
        type: 'Extreme Price Impact',
        severity: 'HIGH',
        category: 'price',
        detail: 'Price impact of ' + config.priceImpact.toFixed(1) + '% detected',
        priceImpact: config.priceImpact
      });
    }

    // 5. Liquidity Spike (positive direction)
    if (current && previous) {
      if (reserveAPct > 30 && reserveAChange > 1000) {
        anomalies.push({
          type: 'Liquidity Spike',
          severity: 'MEDIUM',
          category: 'liquidity',
          detail: 'Large liquidity inflow: +' + reserveAPct.toFixed(1) + '% on Reserve A',
          changePct: parseFloat(reserveAPct.toFixed(2))
        });
      }
    }

    return anomalies;
  }

  function severityLevel(anomalies) {
    if (!anomalies || anomalies.length === 0) return 'LOW';
    var hasCritical = anomalies.some(function(a) { return a.severity === 'CRITICAL'; });
    var hasHigh = anomalies.some(function(a) { return a.severity === 'HIGH'; });
    var hasMedium = anomalies.some(function(a) { return a.severity === 'MEDIUM'; });
    if (hasCritical) return 'CRITICAL';
    if (hasHigh) return 'HIGH';
    if (hasMedium) return 'MEDIUM';
    return 'LOW';
  }

  function formatReport(anomalies) {
    if (!anomalies || anomalies.length === 0) return 'No anomalies detected.';
    var lines = [];
    for (var i = 0; i < anomalies.length; i++) {
      var a = anomalies[i];
      lines.push('[' + a.severity + '] [' + a.category + '] ' + a.type + ': ' + a.detail);
    }
    return lines.join('\n');
  }

  window.AnomalyDetection = {
    check: check,
    severityLevel: severityLevel,
    formatReport: formatReport
  };
})();
