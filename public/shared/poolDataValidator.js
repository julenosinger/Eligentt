/**
 * Elligentt Pool Data Validator (FIX EURC POOL)
 * ═══════════════════════════════════════
 * Central pool data lifecycle validation.
 * Integrates: PoolStateManager, PoolReserveSnapshot, PoolRetryManager, RPCManager.
 * Attached to window.PoolDataValidator
 */
(function(){
  'use strict';

  /**
   * Validates that pool data is usable for display.
   * Never returns "no data" if we have a valid snapshot.
   */
  function validate(poolId, currentData) {
    var result = {
      poolId: poolId,
      valid: false,
      status: 'LOADING',
      data: null,
      message: 'Loading pool data...',
      source: 'none'
    };

    // 1. Fresh on-chain data
    if (currentData && currentData.loaded && !currentData.error) {
      var hasReserves = currentData.reserveA > 0 || currentData.reserveB > 0;
      if (hasReserves) {
        result.valid = true;
        result.status = 'VALID';
        result.data = currentData;
        result.message = null;
        result.source = 'chain';

        // Save snapshot + state
        try {
          if (typeof PoolReserveSnapshot !== 'undefined') {
            PoolReserveSnapshot.saveSnapshot(poolId, currentData);
          }
          if (typeof PoolStateManager !== 'undefined') {
            PoolStateManager.saveState(poolId, currentData);
          }
          if (typeof PoolWatcher !== 'undefined') {
            PoolWatcher.markSeen(poolId);
          }
        } catch(e) {}
        return result;
      }
      // Chain returned empty reserves
      result.status = 'EMPTY';
      result.message = 'Pool has no liquidity';
      result.source = 'chain';
    }

    // 2. Fallback to snapshot
    try {
      if (typeof PoolReserveSnapshot !== 'undefined') {
        var snap = PoolReserveSnapshot.getLatestSnapshot(poolId);
        if (snap && snap.reserveA > 0) {
          result.valid = true;
          result.status = 'SNAPSHOT';
          result.data = snap;
          result.message = 'Refreshing pool data...';
          result.source = 'snapshot';
          return result;
        }
      }
    } catch(e) {}

    // 3. Fallback to state manager cache
    try {
      if (typeof PoolStateManager !== 'undefined') {
        var cached = PoolStateManager.getState(poolId);
        if (cached && cached.hasData && cached.data) {
          result.valid = true;
          result.status = 'CACHED';
          result.data = cached.data;
          result.message = 'Using cached data...';
          result.source = 'cache';
          return result;
        }
      }
    } catch(e) {}

    // 4. No data anywhere
    result.valid = false;
    result.status = 'LOADING';
    result.message = 'Loading pool data...';
    result.source = 'none';

    return result;
  }

  /**
   * Get a status compatible with UI rendering.
   * Returns safe defaults for every state.
   */
  function getSafeDisplayData(poolId, currentData) {
    var validation = validate(poolId, currentData);

    return {
      loaded: validation.valid || validation.status === 'LOADING',
      error: validation.status === 'ERROR' ? validation.message : null,
      reserveA: validation.data ? (validation.data.reserveA || 0) : 0,
      reserveB: validation.data ? (validation.data.reserveB || 0) : 0,
      tvl: validation.data ? (validation.data.tvl || 0) : 0,
      healthScore: validation.data ? validation.data.healthScore : null,
      feePct: validation.data ? validation.data.feePct : null,
      status: validation.status,
      message: validation.message,
      source: validation.source
    };
  }

  /**
   * Bridge function to inject safe data into global poolData object.
   * Call this after loadSinglePool completes to patch the results.
   */
  function patchPoolData(poolId) {
    try {
      if (typeof poolData === 'undefined') return;
      var current = poolData[poolId];
      var safe = getSafeDisplayData(poolId, current);

      // Never downgrade from valid data to no data
      if (current && current.loaded && current.reserveA > 0) {
        return; // Fresh data is fine
      }

      // Patch with safe fallback
      if (!current || !current.loaded) {
        poolData[poolId] = poolData[poolId] || {};
        poolData[poolId].loaded = safe.loaded;
        if (safe.reserveA > 0) poolData[poolId].reserveA = safe.reserveA;
        if (safe.reserveB > 0) poolData[poolId].reserveB = safe.reserveB;
        poolData[poolId]._status = safe.status;
        poolData[poolId]._message = safe.message;
      }
    } catch(e) {}
  }

  window.PoolDataValidator = {
    validate: validate,
    getSafeDisplayData: getSafeDisplayData,
    patchPoolData: patchPoolData
  };
})();
