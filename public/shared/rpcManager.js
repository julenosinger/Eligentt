/**
 * Elligentt RPC Manager — Multi-provider failover (FASE 1 - A3)
 * ═══════════════════════════════════════════════
 * Manages RPC health checks and automatic failover between providers.
 * Never depends on a single public RPC.
 * Attached to window.RPCManager
 */
(function(){
  'use strict';

  var RPC_LIST = [
    { url: 'https://arc-testnet.drpc.org',           name: 'dRPC',           priority: 0 },
    { url: 'https://rpc.testnet.arc.network',         name: 'Arc Network',   priority: 1 },
    { url: 'https://testnet.arcscan.app/rpc',         name: 'ArcScan',       priority: 2 },
    { url: 'https://arc-testnet.rpc.anomalyco.dev',   name: 'Anomaly RPC',  priority: 3 }
  ];

  var HEALTH_CACHE_TTL = 30000;
  var activeProviderIndex = 0;
  var healthCache = {};
  var readProvider = null;
  var fallbackCount = 0;
  var lastHealthCheck = 0;

  function _sortByPriority(list) {
    return list.slice().sort(function(a, b) { return a.priority - b.priority; });
  }

  async function _checkProvider(rpcEntry) {
    var cache = healthCache[rpcEntry.url];
    if (cache && (Date.now() - cache.checkedAt) < HEALTH_CACHE_TTL) {
      return cache.healthy;
    }
    try {
      var resp = await fetch(rpcEntry.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_blockNumber',
          params: [],
          id: 1
        }),
        signal: AbortSignal.timeout(5000)
      });
      if (!resp.ok) {
        healthCache[rpcEntry.url] = { healthy: false, checkedAt: Date.now() };
        return false;
      }
      var data = await resp.json();
      var healthy = !!(data && data.result);
      healthCache[rpcEntry.url] = { healthy: healthy, checkedAt: Date.now() };
      return healthy;
    } catch(e) {
      healthCache[rpcEntry.url] = { healthy: false, checkedAt: Date.now() };
      return false;
    }
  }

  async function _findHealthyRPC() {
    var sorted = _sortByPriority(RPC_LIST);
    for (var i = 0; i < sorted.length; i++) {
      var healthy = await _checkProvider(sorted[i]);
      if (healthy) {
        return sorted[i];
      }
    }
    return null;
  }

  function _createProvider(url) {
    if (typeof ethers === 'undefined') return null;
    try {
      return new ethers.JsonRpcProvider(url);
    } catch(e) { return null; }
  }

  async function getHealthyRPC() {
    if (readProvider) {
      var currentUrl = RPC_LIST[activeProviderIndex] ? RPC_LIST[activeProviderIndex].url : null;
      if (currentUrl) {
        var isHealthy = await _checkProvider(RPC_LIST[activeProviderIndex]);
        if (isHealthy) {
          return { provider: readProvider, url: currentUrl, name: RPC_LIST[activeProviderIndex].name, fallbackCount: fallbackCount };
        }
      }
    }

    var healthy = await _findHealthyRPC();
    if (!healthy) {
      // All RPCs offline — return last known provider if any
      if (readProvider) {
        return { provider: readProvider, url: (RPC_LIST[activeProviderIndex] || RPC_LIST[0]).url, name: (RPC_LIST[activeProviderIndex] || RPC_LIST[0]).name, fallbackCount: fallbackCount, degraded: true };
      }
      return { provider: null, url: null, name: null, fallbackCount: fallbackCount, error: 'No healthy RPC available' };
    }

    var provider = _createProvider(healthy.url);
    if (!provider) {
      return { provider: null, url: null, name: null, fallbackCount: fallbackCount, error: 'Failed to create provider' };
    }

    if (readProvider && healthy.url !== (RPC_LIST[activeProviderIndex] ? RPC_LIST[activeProviderIndex].url : '')) {
      fallbackCount++;
    }

    readProvider = provider;
    activeProviderIndex = RPC_LIST.findIndex(function(r) { return r.url === healthy.url; });
    if (activeProviderIndex < 0) activeProviderIndex = 0;

    lastHealthCheck = Date.now();

    return { provider: readProvider, url: healthy.url, name: healthy.name, fallbackCount: fallbackCount };
  }

  function getCurrentProvider() {
    return readProvider;
  }

  function getCurrentRPCUrl() {
    return RPC_LIST[activeProviderIndex] ? RPC_LIST[activeProviderIndex].url : RPC_LIST[0].url;
  }

  function getRPCStatus() {
    var statuses = RPC_LIST.map(function(r) {
      var hc = healthCache[r.url];
      var isActive = RPC_LIST[activeProviderIndex] && r.url === RPC_LIST[activeProviderIndex].url;
      return {
        url: r.url,
        name: r.name,
        priority: r.priority,
        active: isActive,
        healthy: hc ? hc.healthy : null,
        lastCheck: hc ? hc.checkedAt : null
      };
    });
    return {
      activeRPC: RPC_LIST[activeProviderIndex] ? RPC_LIST[activeProviderIndex].name : 'unknown',
      activeURL: RPC_LIST[activeProviderIndex] ? RPC_LIST[activeProviderIndex].url : null,
      fallbackCount: fallbackCount,
      lastHealthCheck: lastHealthCheck,
      providers: statuses
    };
  }

  async function runHealthCheck() {
    var sorted = _sortByPriority(RPC_LIST);
    for (var i = 0; i < sorted.length; i++) {
      await _checkProvider(sorted[i]);
    }
    lastHealthCheck = Date.now();
    return getRPCStatus();
  }

  function resetFallbackCount() {
    fallbackCount = 0;
  }

  function addRPC(url, name, priority) {
    if (!url) return;
    if (RPC_LIST.some(function(r) { return r.url === url; })) return;
    RPC_LIST.push({
      url: url,
      name: name || ('RPC ' + RPC_LIST.length),
      priority: priority != null ? priority : RPC_LIST.length
    });
  }

  // Initialize — non-blocking health check
  setTimeout(function() {
    runHealthCheck().catch(function(){});
  }, 100);

  window.RPCManager = {
    getHealthyRPC: getHealthyRPC,
    getCurrentProvider: getCurrentProvider,
    getCurrentRPCUrl: getCurrentRPCUrl,
    getRPCStatus: getRPCStatus,
    runHealthCheck: runHealthCheck,
    resetFallbackCount: resetFallbackCount,
    addRPC: addRPC,
    RPC_LIST: RPC_LIST,
    get fallbackCount() { return fallbackCount; }
  };
})();
