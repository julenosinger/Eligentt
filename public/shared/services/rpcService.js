/**
 * Elligentt RPCService — Centralized JSON RPC Provider (Phase 1 Architecture)
 *
 * Wraps ethers.JsonRpcProvider with retry, timeout, latency tracking,
 * health checks, automatic fallback, and error normalization.
 *
 * Does NOT change blockchain behavior. Only centralizes and hardens RPC access.
 * Falls back to existing RPCManager when available. Never signs transactions.
 *
 * Attached to: window.RPCService
 *
 * @module rpcService
 * @version 1.0.0
 */
(function () {
  'use strict';

  var DEFAULT_TIMEOUT = 12000;
  var MAX_RETRIES = 3;
  var RETRY_BACKOFF_BASE = 1000;

  /** @type {Record<string, { provider: any, chainId: number, healthy: boolean, lastCheck: number, latency: number, errors: number }>} */
  var _providers = {};

  /** @type {{ uri: string, healthy: boolean }[]} */
  var _fallbackUrls = [];

  /** @type {number} */
  var _requestCount = 0;

  /* ════════════════════════════════════════════
     PROVIDER MANAGEMENT
  ════════════════════════════════════════════ */

  /**
   * Get or create a cached JsonRpcProvider for a given RPC URL.
   * @param {string} rpcUrl
   * @param {number} [chainId]
   * @returns {any|null} ethers.JsonRpcProvider or null if ethers unavailable
   */
  function getProvider(rpcUrl, chainId) {
    if (typeof ethers === 'undefined') return null;
    if (!rpcUrl) return null;

    var key = String(rpcUrl).toLowerCase();
    if (_providers[key]) return _providers[key].provider;

    try {
      var prov = new ethers.JsonRpcProvider(rpcUrl);
      _providers[key] = {
        provider: prov,
        chainId: chainId || 0,
        healthy: true,
        lastCheck: Date.now(),
        latency: 0,
        errors: 0
      };
      return prov;
    } catch (_e) {
      console.warn('[RPCService] Failed to create provider for:', rpcUrl);
      return null;
    }
  }

  /**
   * Get the best available provider for a given chainId.
   * Delegates to RPCManager if available, otherwise uses direct connection.
   *
   * @param {number} chainId
   * @returns {any|null}
   */
  function getBestProvider(chainId) {
    // Delegate to existing RPCManager when available
    try {
      if (typeof RPCManager !== 'undefined') {
        if (typeof RPCManager.getHealthyRPC === 'function') {
          var rpc = RPCManager.getHealthyRPC(chainId);
          if (rpc) return getProvider(rpc, chainId);
        }
        if (typeof RPCManager.getCurrentProvider === 'function') {
          var cp = RPCManager.getCurrentProvider();
          if (cp) return cp;
        }
      }
    } catch (_e) { /* fall through */ }

    // Fallback: try to find a cached provider
    var keys = Object.keys(_providers);
    for (var i = 0; i < keys.length; i++) {
      var p = _providers[keys[i]];
      if (p.chainId === chainId && p.healthy) return p.provider;
    }
    return null;
  }

  /* ════════════════════════════════════════════
     RPC CALL with retry, timeout, and error normalization
  ════════════════════════════════════════════ */

  /**
   * Execute a JSON RPC call with retry, timeout, and latency tracking.
   *
   * @param {string} method - e.g. 'eth_call', 'eth_getBalance', 'eth_getTransactionReceipt'
   * @param {Array} params - RPC params array
   * @param {Object} [opts]
   * @param {string} [opts.rpcUrl] - Target RPC URL
   * @param {number} [opts.chainId] - Target chain ID
   * @param {number} [opts.timeout] - Timeout in ms (default 12000)
   * @param {number} [opts.retries] - Max retry count (default 3)
   * @returns {Promise<any>} RPC result
   * @throws {Error} Normalized error on all retries exhausted
   */
  async function call(method, params, opts) {
    var o = opts || {};
    var timeout = o.timeout || DEFAULT_TIMEOUT;
    var maxRetries = o.retries !== undefined ? o.retries : MAX_RETRIES;
    var rpcUrl = o.rpcUrl;
    var chainId = o.chainId || 5042002;

    if (typeof ethers === 'undefined') {
      return Promise.reject(new Error('RPC_NOT_AVAILABLE: ethers library not loaded'));
    }

    // Resolve provider
    var provider = null;
    if (rpcUrl) {
      provider = getProvider(rpcUrl, chainId);
    } else {
      provider = getBestProvider(chainId);
    }
    if (!provider) {
      return Promise.reject(new Error('RPC_NOT_AVAILABLE: no provider for chain ' + chainId));
    }

    _requestCount += 1;
    var startTime = Date.now();
    var lastError = null;

    for (var attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Build a timeout promise
        var timeoutPromise = new Promise(function (_, reject) {
          setTimeout(function () {
            reject(new Error('RPC_TIMEOUT: ' + method + ' exceeded ' + timeout + 'ms'));
          }, timeout);
        });

        var result = await Promise.race([
          provider.send(method, params),
          timeoutPromise
        ]);

        // Track latency
        var elapsed = Date.now() - startTime;
        _trackLatency(rpcUrl || method, elapsed);

        return result;
      } catch (e) {
        lastError = e;
        var key = rpcUrl || '';
        var provEntry = _providers[key];
        if (provEntry) provEntry.errors += 1;

        // Only retry on timeout or network errors
        var isRetryable = e.message && (
          e.message.indexOf('TIMEOUT') !== -1 ||
          e.message.indexOf('NETWORK_ERROR') !== -1 ||
          e.message.indexOf('network') !== -1 ||
          e.message.indexOf('fetch') !== -1 ||
          e.message.indexOf('timeout') !== -1
        );

        if (!isRetryable || attempt >= maxRetries) break;

        // Exponential backoff
        var delay = RETRY_BACKOFF_BASE * Math.pow(2, attempt);
        await new Promise(function (r) { setTimeout(r, delay); });
      }
    }

    // All retries exhausted — normalize error
    var errMsg = (lastError && lastError.message) ? String(lastError.message) : 'RPC_ERROR';
    var normalized = new Error('RPC_FAILED: ' + method + ' [' + (rpcUrl || 'chain-' + chainId) + '] — ' + errMsg);
    normalized.originalError = lastError;
    normalized.rpcMethod = method;
    normalized.retriesUsed = maxRetries;
    throw normalized;
  }

  /* ════════════════════════════════════════════
     HEALTH CHECK
  ════════════════════════════════════════════ */

  /**
   * Check if a specific RPC endpoint is healthy.
   * @param {string} rpcUrl
   * @param {number} [timeout=5000]
   * @returns {Promise<boolean>}
   */
  async function healthCheck(rpcUrl, timeout) {
    if (!rpcUrl) return false;
    timeout = timeout || 5000;
    try {
      var prov = getProvider(rpcUrl);
      if (!prov) return false;
      var start = Date.now();
      var block = await Promise.race([
        prov.getBlockNumber(),
        new Promise(function (_, reject) { setTimeout(function () { reject(new Error('timeout')); }, timeout); })
      ]);
      var elapsed = Date.now() - start;
      var key = String(rpcUrl).toLowerCase();
      if (_providers[key]) {
        _providers[key].healthy = true;
        _providers[key].lastCheck = Date.now();
        _providers[key].latency = elapsed;
      }
      return typeof block === 'number' && block > 0;
    } catch (_e) {
      var k = String(rpcUrl).toLowerCase();
      if (_providers[k]) {
        _providers[k].healthy = false;
        _providers[k].errors += 1;
      }
      return false;
    }
  }

  /**
   * Run health checks on all configured fallback URLs.
   * @returns {Promise<{ healthy: number, unhealthy: number, total: number }>}
   */
  async function healthCheckAll() {
    var healthy = 0;
    var unhealthy = 0;
    for (var i = 0; i < _fallbackUrls.length; i++) {
      var ok = await healthCheck(_fallbackUrls[i].uri);
      _fallbackUrls[i].healthy = ok;
      if (ok) healthy++; else unhealthy++;
    }
    return { healthy: healthy, unhealthy: unhealthy, total: _fallbackUrls.length };
  }

  /* ════════════════════════════════════════════
     FALLBACKS
  ════════════════════════════════════════════ */

  /**
   * Register fallback RPC URLs.
   * @param {{ uri: string }[]} urls
   */
  function setFallbacks(urls) {
    _fallbackUrls = urls.map(function (u) {
      return { uri: u.uri || u, healthy: true };
    });
  }

  /* ════════════════════════════════════════════
     METRICS
  ════════════════════════════════════════════ */

  function _trackLatency(key, ms) {
    if (_providers[key]) {
      _providers[key].latency = ms;
      _providers[key].lastCheck = Date.now();
    }
  }

  /**
   * @returns {{ requests: number, providers: number, latencies: Record<string,number> }}
   */
  function getMetrics() {
    var latencies = {};
    var keys = Object.keys(_providers);
    for (var i = 0; i < keys.length; i++) {
      latencies[keys[i]] = _providers[keys[i]].latency;
    }
    return {
      requests: _requestCount,
      providers: keys.length,
      latencies: latencies
    };
  }

  /**
   * Reset all caches. Use for network changes or testing.
   */
  function reset() {
    _providers = {};
    _fallbackUrls = [];
    _requestCount = 0;
  }

  /** @public */
  window.RPCService = {
    VERSION: '1.0.0',
    call: call,
    getProvider: getProvider,
    getBestProvider: getBestProvider,
    healthCheck: healthCheck,
    healthCheckAll: healthCheckAll,
    setFallbacks: setFallbacks,
    getMetrics: getMetrics,
    reset: reset,
    DEFAULT_TIMEOUT: DEFAULT_TIMEOUT,
    MAX_RETRIES: MAX_RETRIES
  };
})();
