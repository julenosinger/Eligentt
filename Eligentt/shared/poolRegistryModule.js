/**
 * Elligentt Pool Registry (FASE 2.6)
 * ═══════════════════════════════════════
 * Central registry for pool metadata: chain, addresses, tokens, fee, ABI version.
 * All data from on-chain discovery.
 * Attached to window.PoolRegistry
 */
(function(){
  'use strict';

  var REGISTRY_KEY = 'elligentt_pool_registry_v1';

  // Primary pool — ElligentPool AMM on Arc Testnet
  var POOLS = {
    arc_testnet_usdc_cirbtc: {
      id: 'arc_testnet_usdc_cirbtc',
      chainId: 5042002,
      chainName: 'Arc Testnet',
      poolType: 'Custom LP Token',
      abiVersion: 'custom_v1',
      poolAddress: '0x18076d992005186AeB13AC5270CaD6E27DB95247',
      poolName: 'Elligente LP Token',
      poolSymbol: 'ELP',
      poolDecimals: 18,
      routerAddress: null,
      factoryAddress: null,
      lpAddress: '0x18076d992005186AeB13AC5270CaD6E27DB95247',
      feeBps: 30,
      feePct: 0.3,
      tokens: [
        { symbol: 'USDC', address: '0x3600000000000000000000000000000000000000', decimals: 6 },
        { symbol: 'cirBTC', address: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF', decimals: 8 }
      ],
      supportedFunctions: [
        'name', 'symbol', 'decimals', 'totalSupply',
        'balanceOf', 'allowance', 'transfer', 'approve', 'transferFrom',
        'getReserves'
      ],
      unsupportedFunctions: [
        'token0', 'token1', 'tokenA', 'tokenB',
        'fee', 'factory', 'getAmountOut', 'swap'
      ],
      healthStatus: 'pending',
      lastHealthCheck: null,
      lastDiscoveryAt: null
    }
  };

  var customPools = {};

  function loadCustom() {
    try {
      var raw = localStorage.getItem(REGISTRY_KEY);
      if (raw) customPools = JSON.parse(raw);
    } catch(e) { customPools = {}; }
  }

  function saveCustom() {
    try { localStorage.setItem(REGISTRY_KEY, JSON.stringify(customPools)); } catch(e) {}
  }

  function getAllPools() {
    var all = Object.assign({}, POOLS, customPools);
    return all;
  }

  function getPool(poolId) {
    var all = getAllPools();
    return all[poolId] || null;
  }

  function getPoolByAddress(address) {
    if (!address) return null;
    var all = getAllPools();
    var keys = Object.keys(all);
    for (var i = 0; i < keys.length; i++) {
      var p = all[keys[i]];
      if (p.poolAddress && p.poolAddress.toLowerCase() === address.toLowerCase()) {
        return p;
      }
    }
    return null;
  }

  function getDefaultPool() {
    return POOLS.arc_testnet_usdc_cirbtc;
  }

  function registerPool(poolId, poolData) {
    customPools[poolId] = {
      id: poolId,
      chainId: poolData.chainId || 5042002,
      chainName: poolData.chainName || 'Arc Testnet',
      poolType: poolData.poolType || 'Custom',
      abiVersion: poolData.abiVersion || 'custom_v1',
      poolAddress: poolData.poolAddress,
      poolName: poolData.poolName || '',
      poolSymbol: poolData.poolSymbol || '',
      poolDecimals: poolData.poolDecimals || 18,
      routerAddress: poolData.routerAddress || null,
      factoryAddress: poolData.factoryAddress || null,
      lpAddress: poolData.lpAddress || poolData.poolAddress,
      feeBps: poolData.feeBps || 30,
      feePct: poolData.feePct || 0.3,
      tokens: poolData.tokens || [],
      supportedFunctions: poolData.supportedFunctions || [],
      unsupportedFunctions: poolData.unsupportedFunctions || [],
      healthStatus: 'pending',
      lastHealthCheck: null,
      lastDiscoveryAt: poolData.lastDiscoveryAt || Date.now()
    };
    saveCustom();
    return customPools[poolId];
  }

  function updatePoolHealth(poolId, healthResult) {
    if (POOLS[poolId]) {
      POOLS[poolId].healthStatus = healthResult.healthy ? 'healthy' : 'unhealthy';
      POOLS[poolId].lastHealthCheck = Date.now();
    } else if (customPools[poolId]) {
      customPools[poolId].healthStatus = healthResult.healthy ? 'healthy' : 'unhealthy';
      customPools[poolId].lastHealthCheck = Date.now();
      saveCustom();
    }
  }

  function updateDiscoveryResult(poolId, discoveryResult) {
    if (POOLS[poolId] && discoveryResult) {
      POOLS[poolId].supportedFunctions = discoveryResult.supportedFunctions.map(function(f) { return f.name; }) || [];
      POOLS[poolId].unsupportedFunctions = discoveryResult.unsupportedFunctions.map(function(f) { return f.name; }) || [];
      POOLS[poolId].lastDiscoveryAt = discoveryResult.discoveredAt;
    }
  }

  function getPoolCount() {
    return Object.keys(getAllPools()).length;
  }

  function exportRegistry() {
    return JSON.parse(JSON.stringify(getAllPools()));
  }

  loadCustom();

  window.PoolRegistry = {
    getAllPools: getAllPools,
    getPool: getPool,
    getPoolByAddress: getPoolByAddress,
    getDefaultPool: getDefaultPool,
    registerPool: registerPool,
    updatePoolHealth: updatePoolHealth,
    updateDiscoveryResult: updateDiscoveryResult,
    getPoolCount: getPoolCount,
    exportRegistry: exportRegistry,
    POOLS: POOLS
  };
})();
