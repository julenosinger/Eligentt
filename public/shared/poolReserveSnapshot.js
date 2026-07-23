/**
 * Elligentt Pool Reserve Snapshot (FIX EURC POOL)
 * ═══════════════════════════════════════
 * Saves last valid reserve snapshot. Feeds PoolStateManager during refresh.
 * Never lets UI go blank during RPC calls.
 * Attached to window.PoolReserveSnapshot
 */
(function(){
  'use strict';

  var SNAPSHOT_KEY = 'elligentt_reserve_snapshots_v1';
  var MAX_SNAPSHOTS_PER_POOL = 10;

  var snapshots = {};

  function load() {
    try {
      var raw = localStorage.getItem(SNAPSHOT_KEY);
      if (raw) snapshots = JSON.parse(raw);
    } catch(e) { snapshots = {}; }
  }

  function save() {
    try { localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshots)); } catch(e) {}
  }

  function saveSnapshot(poolId, data) {
    if (!poolId || !data) return null;

    var snap = {
      timestamp: Date.now(),
      reserveA: data.reserveA != null ? Number(data.reserveA) : null,
      reserveB: data.reserveB != null ? Number(data.reserveB) : null,
      tvl: data.tvl != null ? Number(data.tvl) : null,
      lpSupply: data.lpSupply != null ? Number(data.lpSupply) : null,
      healthScore: data.healthScore != null ? Number(data.healthScore) : null,
      priceImpact: data.priceImpact != null ? Number(data.priceImpact) : null,
      priceAB: data.reserveA > 0 && data.reserveB > 0 ? Number(data.reserveA) / Number(data.reserveB) : null,
      source: data.source || 'snapshot'
    };

    if (!snapshots[poolId]) snapshots[poolId] = [];
    snapshots[poolId].push(snap);

    if (snapshots[poolId].length > MAX_SNAPSHOTS_PER_POOL) {
      snapshots[poolId] = snapshots[poolId].slice(snapshots[poolId].length - MAX_SNAPSHOTS_PER_POOL);
    }

    save();
    return snap;
  }

  function getLatestSnapshot(poolId) {
    var list = snapshots[poolId];
    if (!list || list.length === 0) return null;
    return list[list.length - 1];
  }

  function getSnapshots(poolId, count) {
    var list = snapshots[poolId] || [];
    if (!count) return list;
    return list.slice(-count);
  }

  function getSnapshotAge(poolId) {
    var latest = getLatestSnapshot(poolId);
    if (!latest) return Infinity;
    return Date.now() - latest.timestamp;
  }

  function hasRecentSnapshot(poolId, maxAgeMs) {
    var age = getSnapshotAge(poolId);
    return age < (maxAgeMs || 60000);
  }

  function isEmpty(poolId) {
    var latest = getLatestSnapshot(poolId);
    return !latest || !latest.reserveA || latest.reserveA <= 0;
  }

  function clearSnapshots(poolId) {
    if (poolId) {
      delete snapshots[poolId];
    } else {
      snapshots = {};
    }
    save();
  }

  function getSnapshotCount(poolId) {
    return (snapshots[poolId] || []).length;
  }

  load();

  window.PoolReserveSnapshot = {
    saveSnapshot: saveSnapshot,
    getLatestSnapshot: getLatestSnapshot,
    getSnapshots: getSnapshots,
    getSnapshotAge: getSnapshotAge,
    hasRecentSnapshot: hasRecentSnapshot,
    isEmpty: isEmpty,
    clearSnapshots: clearSnapshots,
    getSnapshotCount: getSnapshotCount,
    _snapshots: snapshots
  };
})();
