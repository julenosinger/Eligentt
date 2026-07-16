/**
 * Elligentt Pool Monitor (FASE 3.3)
 * ═══════════════════════════════════════
 * Real-time pool monitoring: reserves, liquidity, health, price impact, volume.
 * Detects: liquidity drain, reserve changes, spikes, price anomalies.
 * Attached to window.PoolMonitor
 */
(function(){
  'use strict';

  var MONITOR_KEY = 'elligentt_pool_monitor_v1';
  var INTERVALS = [15, 30, 60]; // seconds
  var DEFAULT_INTERVAL = 30000; // 30s default
  var monitorTimer = null;
  var listeners = [];
  var lastState = null;
  var monitorActive = false;
  var poolConfig = null;

  function getPoolConfig() {
    if (poolConfig) return poolConfig;
    if (typeof PoolRegistry !== 'undefined') {
      poolConfig = PoolRegistry.getDefaultPool();
    }
    if (!poolConfig) {
      poolConfig = {
        poolAddress: '0x18076d992005186AeB13AC5270CaD6E27DB95247',
        chainId: 5042002,
        tokens: [
          { symbol: 'USDC', address: '0x3600000000000000000000000000000000000000', decimals: 6 },
          { symbol: 'cirBTC', address: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF', decimals: 8 }
        ]
      };
    }
    return poolConfig;
  }

  async function fetchPoolState() {
    var config = getPoolConfig();
    var state = {
      timestamp: Date.now(),
      poolAddress: config.poolAddress,
      reserves: null,
      lpSupply: null,
      healthScore: null,
      priceImpact: null,
      oraclePrice: null,
      twap: null,
      anomalies: []
    };

    try {
      if (typeof ChainSimulator !== 'undefined') {
        var reserves = await ChainSimulator.getPoolReserves();
        if (reserves) state.reserves = reserves;
      }
    } catch(e) {}

    try {
      if (typeof LiquidityHealthEngine !== 'undefined' && state.reserves) {
        state.healthScore = LiquidityHealthEngine.analyze({
          reserveA: state.reserves.reserveA,
          reserveB: state.reserves.reserveB,
          tokens: ['USDC', 'cirBTC']
        });
      }
    } catch(e) {}

    try {
      if (typeof PriceOracleEngine !== 'undefined' && state.reserves) {
        state.oraclePrice = PriceOracleEngine.getBestPrice(
          state.reserves.reserveA,
          state.reserves.reserveB
        );
      }
    } catch(e) {}

    try {
      if (typeof TwapEngine !== 'undefined' && state.reserves) {
        TwapEngine.addSnapshot(
          state.reserves.reserveA,
          state.reserves.reserveB,
          6, 8
        );
        state.twap = TwapEngine.calculateTWAP(15);
      }
    } catch(e) {}

    try {
      if (lastState && state.reserves && typeof AnomalyDetection !== 'undefined') {
        state.anomalies = AnomalyDetection.check({
          current: state.reserves,
          previous: lastState.reserves,
          healthScore: state.healthScore ? state.healthScore.score : null,
          twap: state.twap
        });
      }
    } catch(e) {}

    state.estimatedVolume = lastState && state.reserves
      ? Math.abs(state.reserves.reserveA - lastState.reserves.reserveA || 0)
      : 0;

    lastState = state;

    _notifyListeners(state);

    if (!state.monitoringStarted) {
      state.monitoringStarted = true;
    }

    return state;
  }

  function _notifyListeners(state) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](state); } catch(e) {}
    }
  }

  function start(intervalMs) {
    if (monitorActive) return;
    var ms = intervalMs || DEFAULT_INTERVAL;
    monitorActive = true;
    fetchPoolState();
    monitorTimer = setInterval(fetchPoolState, ms);
  }

  function stop() {
    monitorActive = false;
    if (monitorTimer) {
      clearInterval(monitorTimer);
      monitorTimer = null;
    }
  }

  function isActive() { return monitorActive; }

  function addListener(callback) {
    if (typeof callback === 'function') {
      listeners.push(callback);
      return listeners.length - 1;
    }
    return -1;
  }

  function removeListener(index) {
    if (index >= 0 && index < listeners.length) {
      listeners.splice(index, 1);
    }
  }

  function getLastState() { return lastState; }

  function getPoolConfig() { return poolConfig; }

  function getMonitorStatus() {
    return {
      active: monitorActive,
      intervals: INTERVALS,
      currentInterval: DEFAULT_INTERVAL,
      listeners: listeners.length,
      lastState: lastState ? lastState.timestamp : null,
      snapshotCount: typeof TwapEngine !== 'undefined' ? TwapEngine.getSnapshotCount() : 0
    };
  }

  window.PoolMonitor = {
    start: start,
    stop: stop,
    isActive: isActive,
    fetchPoolState: fetchPoolState,
    addListener: addListener,
    removeListener: removeListener,
    getLastState: getLastState,
    getPoolConfig: getPoolConfig,
    getMonitorStatus: getMonitorStatus,
    INTERVALS: INTERVALS,
    DEFAULT_INTERVAL: DEFAULT_INTERVAL
  };
})();
