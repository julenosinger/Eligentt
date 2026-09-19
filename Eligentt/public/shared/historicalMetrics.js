/**
 * Elligentt Historical Metrics Engine (FASE 3.5)
 * ═══════════════════════════════════════
 * Stores: liquidity, reserves, prices, health, price impact, volume, risk.
 * Windows: 1h, 24h, 7d, 30d.
 * Attached to window.HistoricalMetrics
 */
(function(){
  'use strict';

  var STORE_KEY = 'elligentt_historical_metrics_v1';
  var METRICS_VERSION = 1;
  var SNAPSHOT_LIMIT = 5000;

  var metrics = {
    version: METRICS_VERSION,
    snapshots: [],
    lastSnapshotAt: 0,
    poolAddress: '0x18076d992005186AeB13AC5270CaD6E27DB95247'
  };

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.version === METRICS_VERSION) {
          metrics = parsed;
        }
      }
    } catch(e) {}
    _prune();
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(metrics)); } catch(e) {}
  }

  function _prune() {
    var cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30d
    metrics.snapshots = metrics.snapshots.filter(function(s) { return s.timestamp > cutoff; });
    if (metrics.snapshots.length > SNAPSHOT_LIMIT) {
      metrics.snapshots = metrics.snapshots.slice(metrics.snapshots.length - SNAPSHOT_LIMIT);
    }
  }

  function record(data) {
    load();
    var snapshot = {
      timestamp: Date.now(),
      poolAddress: data.poolAddress || metrics.poolAddress,
      reserveA: data.reserveA || null,
      reserveB: data.reserveB || null,
      lpSupply: data.lpSupply || null,
      healthScore: data.healthScore != null ? data.healthScore : null,
      healthTier: data.healthTier || null,
      priceImpact: data.priceImpact != null ? data.priceImpact : null,
      volume: data.volume || 0,
      riskScore: data.riskScore != null ? data.riskScore : null,
      riskLevel: data.riskLevel || null,
      oraclePrice: data.oraclePrice != null ? data.oraclePrice : null,
      twapPrice: data.twapPrice != null ? data.twapPrice : null,
      alerts: data.alerts ? data.alerts.length : 0
    };

    if (data.reserveA > 0 && data.reserveB > 0) {
      snapshot.priceAB = data.reserveA / data.reserveB;
    }

    metrics.snapshots.push(snapshot);
    metrics.lastSnapshotAt = snapshot.timestamp;
    _prune();
    save();
    return snapshot;
  }

  function _inWindow(hours) {
    load();
    var cutoff = Date.now() - hours * 60 * 60 * 1000;
    return metrics.snapshots.filter(function(s) { return s.timestamp >= cutoff; });
  }

  function getHistory(hours) {
    var data = _inWindow(hours);
    if (data.length === 0) return null;

    var reserves = [];
    var healthScores = [];
    var prices = [];
    var volumes = [];

    for (var i = 0; i < data.length; i++) {
      var d = data[i];
      if (d.reserveA != null) reserves.push({ t: d.timestamp, v: d.reserveA });
      if (d.healthScore != null) healthScores.push({ t: d.timestamp, v: d.healthScore });
      if (d.priceAB != null) prices.push({ t: d.timestamp, v: d.priceAB });
      if (d.volume != null) volumes.push({ t: d.timestamp, v: d.volume });
    }

    var avgHealth = healthScores.length > 0
      ? healthScores.reduce(function(a,b) { return a + b.v; }, 0) / healthScores.length
      : null;
    var avgPrice = prices.length > 0
      ? prices.reduce(function(a,b) { return a + b.v; }, 0) / prices.length
      : null;
    var totalVolume = volumes.reduce(function(a,b) { return a + (b.v || 0); }, 0);
    var minReserve = reserves.length > 0
      ? Math.min.apply(null, reserves.map(function(r) { return r.v; }))
      : null;
    var maxReserve = reserves.length > 0
      ? Math.max.apply(null, reserves.map(function(r) { return r.v; }))
      : null;

    var first = data[0];
    var last = data[data.length - 1];

    return {
      windowHours: hours,
      snapshots: data.length,
      start: first.timestamp,
      end: last.timestamp,
      avgHealthScore: avgHealth ? parseFloat(avgHealth.toFixed(2)) : null,
      avgPrice: avgPrice ? parseFloat(avgPrice.toFixed(6)) : null,
      totalVolume: parseFloat(totalVolume.toFixed(2)),
      minReserveA: minReserve ? parseFloat(minReserve.toFixed(2)) : null,
      maxReserveA: maxReserve ? parseFloat(maxReserve.toFixed(2)) : null,
      startReserveA: first.reserveA,
      endReserveA: last.reserveA,
      reserveAChange: last.reserveA != null && first.reserveA != null
        ? parseFloat(((last.reserveA - first.reserveA) / first.reserveA * 100).toFixed(2))
        : 0,
      reserveA: reserves,
      healthScores: healthScores.slice(-50),
      prices: prices.slice(-50)
    };
  }

  function getSummary() {
    return {
      _1h: getHistory(1),
      _24h: getHistory(24),
      _7d: getHistory(168),
      _30d: getHistory(720)
    };
  }

  function getAverage(metric, hours) {
    var data = _inWindow(hours);
    if (data.length === 0) return null;
    var values = data.filter(function(d) { return d[metric] != null; }).map(function(d) { return d[metric]; });
    if (values.length === 0) return null;
    return values.reduce(function(a,b) { return a + b; }, 0) / values.length;
  }

  function getTrend(metric, hours) {
    var data = _inWindow(hours);
    if (data.length < 2) return 'stable';

    var firstHalf = data.slice(0, Math.floor(data.length / 2));
    var secondHalf = data.slice(Math.floor(data.length / 2));

    var firstVals = firstHalf.filter(function(d) { return d[metric] != null; }).map(function(d) { return d[metric]; });
    var secondVals = secondHalf.filter(function(d) { return d[metric] != null; }).map(function(d) { return d[metric]; });

    if (firstVals.length === 0 || secondVals.length === 0) return 'stable';

    var avgFirst = firstVals.reduce(function(a,b) { return a + b; }, 0) / firstVals.length;
    var avgSecond = secondVals.reduce(function(a,b) { return a + b; }, 0) / secondVals.length;

    var change = ((avgSecond - avgFirst) / avgFirst) * 100;
    if (change > 10) return 'up_strong';
    if (change > 3) return 'up';
    if (change < -10) return 'down_strong';
    if (change < -3) return 'down';
    return 'stable';
  }

  function getSnapshotCount() {
    load();
    return metrics.snapshots.length;
  }

  function clear() {
    metrics.snapshots = [];
    metrics.lastSnapshotAt = 0;
    save();
  }

  load();

  window.HistoricalMetrics = {
    record: record,
    getHistory: getHistory,
    getSummary: getSummary,
    getAverage: getAverage,
    getTrend: getTrend,
    getSnapshotCount: getSnapshotCount,
    clear: clear,
    SNAPSHOT_LIMIT: SNAPSHOT_LIMIT
  };
})();
