/**
 * Elligentt Pool State Manager — Cache & Persistence (FIX EURC POOL)
 * ═══════════════════════════════════════
 * Maintains last valid state for every pool. Prevents pool cards from disappearing
 * during RPC failures, re-renders, or temporary loading states.
 * Once a pool is VALID, it stays valid until proven otherwise on-chain.
 * Attached to window.PoolStateManager
 */
(function(){
  'use strict';

  var STORE_KEY = 'elligentt_pool_state_v1';
  var CACHE_TTL = 120000;       // 2 min — how long stale data is acceptable
  var REFRESH_GRACE = 15000;    // 15s — don't mark stale during normal refresh

  var poolStates = {};

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) poolStates = JSON.parse(raw);
    } catch(e) { poolStates = {}; }
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(poolStates)); } catch(e) {}
  }

  function _now() { return Date.now(); }

  /**
   * Get the best available state for a pool.
   * Priority: current → cached valid → empty.
   */
  function getState(poolId) {
    var cached = poolStates[poolId];
    if (!cached) {
      return { poolId: poolId, status: 'LOADING', hasData: false, age: 0 };
    }
    var age = _now() - cached.updatedAt;
    var staleThreshold = cached.status === 'VALID' ? CACHE_TTL : REFRESH_GRACE;

    if (age < REFRESH_GRACE) {
      return { poolId: poolId, status: 'VALID', hasData: cached.reserveA != null && cached.reserveA > 0, age: age, data: cached };
    }
    if (age < CACHE_TTL && cached.status === 'VALID') {
      return { poolId: poolId, status: 'REFRESHING', hasData: true, age: age, data: cached };
    }
    if (age >= CACHE_TTL && cached.status === 'VALID') {
      return { poolId: poolId, status: 'STALE', hasData: true, age: age, data: cached };
    }
    return { poolId: poolId, status: 'LOADING', hasData: cached.reserveA != null && cached.reserveA > 0, age: age, data: cached.reserveA > 0 ? cached : null };
  }

  /**
   * Save a valid pool state snapshot.
   */
  function saveState(poolId, data) {
    var now = _now();
    poolStates[poolId] = {
      poolId: poolId,
      status: 'VALID',
      reserveA: data.reserveA != null ? Number(data.reserveA) : null,
      reserveB: data.reserveB != null ? Number(data.reserveB) : null,
      tvl: data.tvl != null ? Number(data.tvl) : null,
      healthScore: data.healthScore != null ? Number(data.healthScore) : null,
      liquidityStatus: data.liquidityStatus || 'valid',
      feePct: data.feePct != null ? Number(data.feePct) : null,
      tokenAReserve: data.tokenAReserve != null ? Number(data.tokenAReserve) : null,
      tokenBReserve: data.tokenBReserve != null ? Number(data.tokenBReserve) : null,
      updatedAt: now,
      firstSeenAt: (poolStates[poolId] && poolStates[poolId].firstSeenAt) || now,
      refreshCount: ((poolStates[poolId] && poolStates[poolId].refreshCount) || 0) + 1,
      errorCount: 0
    };
    save();
  }

  /**
   * Record a load error. After N consecutive errors, mark as ERROR.
   */
  function recordError(poolId, errorMsg) {
    var cached = poolStates[poolId];
    var errors = (cached ? cached.errorCount : 0) + 1;
    poolStates[poolId] = {
      poolId: poolId,
      status: errors >= 5 ? 'ERROR' : 'REFRESHING',
      reserveA: cached ? cached.reserveA : null,
      reserveB: cached ? cached.reserveB : null,
      tvl: cached ? cached.tvl : null,
      healthScore: cached ? cached.healthScore : null,
      updatedAt: _now(),
      firstSeenAt: (cached && cached.firstSeenAt) || _now(),
      refreshCount: (cached ? cached.refreshCount : 0),
      errorCount: errors,
      lastError: errorMsg
    };
    save();
    return poolStates[poolId];
  }

  /**
   * Mark pool as actively refreshing (prevents display removal).
   */
  function markRefreshing(poolId) {
    if (poolStates[poolId]) {
      poolStates[poolId].status = 'REFRESHING';
      poolStates[poolId].updatedAt = _now();
    }
  }

  /**
   * Returns true if we have valid data (even if stale) that should keep the card visible.
   */
  function hasValidData(poolId) {
    var state = getState(poolId);
    return state.hasData && state.data != null;
  }

  /**
   * Returns true if the pool should be shown as "Loading..." (first load, no cache).
   */
  function isFirstLoad(poolId) {
    var state = poolStates[poolId];
    return !state || !state.reserveA || state.reserveA === 0;
  }

  /**
   * Get display status for UI consumption.
   */
  function getDisplayStatus(poolId) {
    var state = getState(poolId);
    if (state.status === 'VALID') {
      return { ready: true, status: 'VALID', message: null };
    }
    if (state.status === 'REFRESHING') {
      return { ready: true, status: 'REFRESHING', message: 'Refreshing pool data...' };
    }
    if (state.status === 'STALE') {
      return { ready: true, status: 'STALE', message: 'Data may be outdated' };
    }
    if (state.status === 'ERROR' && state.hasData) {
      return { ready: true, status: 'ERROR', message: 'Using cached data' };
    }
    if (state.status === 'ERROR') {
      return { ready: false, status: 'ERROR', message: 'Pool data unavailable' };
    }
    if (state.status === 'LOADING' && state.hasData) {
      return { ready: true, status: 'LOADING', message: 'Loading pool data...' };
    }
    return { ready: false, status: 'LOADING', message: 'Loading pool data...' };
  }

  /**
   * Invalidate pool state (only if truly broken — use sparingly).
   */
  function invalidate(poolId) {
    delete poolStates[poolId];
    save();
  }

  /**
   * Get all pool states.
   */
  function getAllStates() {
    var result = {};
    var keys = Object.keys(poolStates);
    for (var i = 0; i < keys.length; i++) {
      result[keys[i]] = getState(keys[i]);
    }
    return result;
  }

  load();

  window.PoolStateManager = {
    getState: getState,
    saveState: saveState,
    recordError: recordError,
    markRefreshing: markRefreshing,
    hasValidData: hasValidData,
    isFirstLoad: isFirstLoad,
    getDisplayStatus: getDisplayStatus,
    invalidate: invalidate,
    getAllStates: getAllStates,
    CACHE_TTL: CACHE_TTL,
    REFRESH_GRACE: REFRESH_GRACE,
    _poolStates: poolStates
  };
})();
