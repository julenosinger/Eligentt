/**
 * Elligentt TWAP Engine (FASE 3.2)
 * ═══════════════════════════════════════
 * Time-Weighted Average Price using on-chain reserve snapshots.
 * Intervals: 5min, 15min, 30min, 60min.
 * Attached to window.TwapEngine
 */
(function(){
  'use strict';

  var INTERVALS = [5, 15, 30, 60]; // minutes
  var STORAGE_KEY = 'elligentt_twap_v1';
  var MAX_SNAPSHOTS = 240; // 60min at 15s intervals
  var SNAPSHOT_INTERVAL = 15000; // 15s

  var snapshots = [];
  var loaded = false;

  function load() {
    if (loaded) return;
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) snapshots = JSON.parse(raw);
    } catch(e) { snapshots = []; }
    loaded = true;
    _prune();
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshots)); } catch(e) {}
  }

  function _prune() {
    var cutoff = Date.now() - (Math.max.apply(null, INTERVALS) * 60 * 1000) - 60000;
    snapshots = snapshots.filter(function(s) { return s.timestamp > cutoff; });
    if (snapshots.length > MAX_SNAPSHOTS) {
      snapshots = snapshots.slice(snapshots.length - MAX_SNAPSHOTS);
    }
  }

  function addSnapshot(reserveA, reserveB, reserveADec, reserveBDec) {
    load();
    var s = {
      timestamp: Date.now(),
      reserveA: Number(reserveA || 0),
      reserveB: Number(reserveB || 0),
      reserveADec: reserveADec || 6,
      reserveBDec: reserveBDec || 8
    };
    s.priceAB = s.reserveB > 0 ? s.reserveA / s.reserveB : 0;
    s.priceBA = s.reserveA > 0 ? s.reserveB / s.reserveA : 0;
    snapshots.push(s);
    _prune();
    save();
    return s;
  }

  function _getSnapshotsInWindow(minutes) {
    load();
    var cutoff = Date.now() - minutes * 60 * 1000;
    return snapshots.filter(function(s) { return s.timestamp >= cutoff; });
  }

  function calculateTWAP(minutes) {
    var window = _getSnapshotsInWindow(minutes || 5);
    if (window.length === 0) return null;

    var totalPriceAB = 0, totalPriceBA = 0, totalWeight = 0;
    var totalReserveA = 0, totalReserveB = 0;

    for (var i = 1; i < window.length; i++) {
      var curr = window[i];
      var prev = window[i - 1];
      var timeWeight = (curr.timestamp - prev.timestamp) / 1000;
      if (timeWeight <= 0) continue;

      var priceAB = curr.reserveB > 0 ? curr.reserveA / curr.reserveB : 0;
      var priceBA = curr.reserveA > 0 ? curr.reserveB / curr.reserveA : 0;

      totalPriceAB += priceAB * timeWeight;
      totalPriceBA += priceBA * timeWeight;
      totalReserveA += curr.reserveA * timeWeight;
      totalReserveB += curr.reserveB * timeWeight;
      totalWeight += timeWeight;
    }

    if (totalWeight <= 0) return null;

    return {
      twapAB: parseFloat((totalPriceAB / totalWeight).toFixed(6)),
      twapBA: parseFloat((totalPriceBA / totalWeight).toFixed(8)),
      avgReserveA: parseFloat((totalReserveA / totalWeight).toFixed(2)),
      avgReserveB: parseFloat((totalReserveB / totalWeight).toFixed(8)),
      snapshots: window.length,
      windowMinutes: minutes,
      windowStart: window[0].timestamp,
      windowEnd: window[window.length - 1].timestamp,
      computedAt: Date.now()
    };
  }

  function calculateAllTWAPs() {
    var result = { intervals: {}, snapshots: snapshots.length };
    for (var i = 0; i < INTERVALS.length; i++) {
      var m = INTERVALS[i];
      result.intervals[m] = calculateTWAP(m);
    }
    return result;
  }

  function getSpotPrice(reserveA, reserveB) {
    if (!reserveB || reserveB <= 0) return null;
    return {
      priceAB: parseFloat((reserveA / reserveB).toFixed(6)),
      priceBA: parseFloat((reserveB / reserveA).toFixed(8)),
      computedAt: Date.now()
    };
  }

  function getTWAPDeviation(minutes, currentPrice) {
    var twap = calculateTWAP(minutes || 15);
    if (!twap || !currentPrice) return null;
    var deviation = Math.abs(currentPrice - twap.twapAB) / twap.twapAB * 100;
    return {
      twap: twap.twapAB,
      spot: currentPrice,
      deviationPct: parseFloat(deviation.toFixed(3)),
      windowMinutes: minutes || 15,
      threshold: deviation > 5 ? 'HIGH' : deviation > 2 ? 'MEDIUM' : 'LOW'
    };
  }

  function getSnapshotCount() {
    load();
    return snapshots.length;
  }

  function clearSnapshots() {
    snapshots = [];
    save();
  }

  load();

  window.TwapEngine = {
    addSnapshot: addSnapshot,
    calculateTWAP: calculateTWAP,
    calculateAllTWAPs: calculateAllTWAPs,
    getSpotPrice: getSpotPrice,
    getTWAPDeviation: getTWAPDeviation,
    getSnapshotCount: getSnapshotCount,
    clearSnapshots: clearSnapshots,
    INTERVALS: INTERVALS,
    SNAPSHOT_INTERVAL: SNAPSHOT_INTERVAL
  };
})();
