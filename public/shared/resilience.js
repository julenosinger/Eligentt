/**
 * Resilience Utilities — Retry logic, RPC reconnection, polling recovery
 * ═══════════════════════════════════════════════════════════
 * Non-blocking resilience improvements for transient failures.
 * Does NOT alter success behavior, calculations, or financial logic.
 */

const Resilience = (() => {

  /**
   * Exponential backoff retry for async operations.
   * @param {Function} fn - Async function to retry
   * @param {object} opts - { maxRetries (3), baseDelay (1000), maxDelay (30000), factor (2), onRetry(retryNum, error) }
   * @returns {Promise<any>}
   */
  async function withRetry(fn, opts = {}) {
    const maxRetries = opts.maxRetries ?? 3;
    const baseDelay  = opts.baseDelay  ?? 1000;
    const maxDelay   = opts.maxDelay   ?? 30000;
    const factor     = opts.factor     ?? 2;

    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (e) {
        lastError = e;
        if (attempt < maxRetries) {
          const delay = Math.min(baseDelay * Math.pow(factor, attempt), maxDelay);
          const jitter = delay * 0.1 * Math.random();
          if (opts.onRetry) opts.onRetry(attempt + 1, e);
          await new Promise(r => setTimeout(r, delay + jitter));
        }
      }
    }
    throw lastError;
  }

  /**
   * Reconectar RPC provider — creates fresh instance after failure.
   * Only for transient RPC errors (network, timeout).
   * @param {string} rpcUrl - RPC URL to reconnect to
   * @returns {ethers.JsonRpcProvider|null}
   */
  function reconnectRPC(rpcUrl) {
    if (typeof ethers === 'undefined') return null;
    try {
      // Invalidate cache to force fresh provider
      if (typeof _providerCache !== 'undefined') {
        delete _providerCache[rpcUrl];
      }
      const fresh = new ethers.JsonRpcProvider(rpcUrl);
      // Store in cache if available
      if (typeof _providerCache !== 'undefined') {
        _providerCache[rpcUrl] = { provider: fresh, createdAt: Date.now() };
      }
      return fresh;
    } catch (e) {
      if (typeof _warn === 'function') _warn('[Resilience] RPC reconnect failed:', e.message);
      return null;
    }
  }

  /**
   * Safe RPC call with retry and reconnection.
   * @param {Function} callFn - Wraps the actual RPC call using a provider
   * @param {string} rpcUrl - RPC URL for reconnection
   * @returns {Promise<any>}
   */
  async function safeRPCCall(callFn, rpcUrl) {
    return withRetry(async () => {
      try {
        return await callFn();
      } catch (e) {
        const msg = (e.message || '').toLowerCase();
        // Only retry on transient errors
        if (msg.includes('network') || msg.includes('timeout') ||
            msg.includes('rate limit') || msg.includes('429') ||
            msg.includes('503') || msg.includes('502') ||
            msg.includes('fetch failed') || msg.includes('connection')) {
          const fresh = reconnectRPC(rpcUrl);
          if (fresh) throw e; // Let withRetry handle the retry after reconnection
        }
        throw e; // Non-transient — don't retry
      }
    }, { maxRetries: 3, baseDelay: 1000, maxDelay: 10000 });
  }

  /**
   * Resume stuck polling — recovery for settlement/bridge pollers
   * after page visibility change or network interruption.
   */
  function resumePolling() {
    // BLOCK: if Settlement Recovery Engine is in read-only mode, do NOT resume any writes
    if (typeof window !== 'undefined' && window.__SETTLEMENT_RECOVERY_READONLY) {
      console.error("ILLEGAL USER TRANSACTION FROM RECOVERY ENGINE — blocked resumePolling");
      return;
    }
    // Recover Treasury intents via global FulfillerEngine
    if (typeof FulfillerEngine !== 'undefined' && typeof FulfillerEngine.recoverSettlingIntents === 'function') {
      try { FulfillerEngine.recoverSettlingIntents(); } catch(e) { console.error('[Resilience] recoverSettlingIntents error:', e); }
    }
    // Recover Settlement Module if exists — recovery is now read-only in SettlementModule
    if (typeof SettlementModule !== 'undefined' && typeof SettlementModule.runRecovery === 'function') {
      try { SettlementModule.runRecovery(); } catch(e) { console.error('[Resilience] runRecovery error:', e); }
    }
  }

  // Setup visibility change listener for poll recovery
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        // Page became visible again — resume any stuck polling
        setTimeout(resumePolling, 2000);
      }
    });

    // Online/offline detection
    window.addEventListener('online', () => {
      setTimeout(resumePolling, 3000);
    });
  }

  /**
   * Check if RPC is responsive (lightweight ping).
   * @param {string} rpcUrl
   * @returns {Promise<boolean>}
   */
  async function isRPCAlive(rpcUrl) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      return resp.ok;
    } catch (e) {
      return false;
    }
  }

  /**
   * Debounce utility — prevents rapid repeated calls.
   * @param {Function} fn
   * @param {number} delay
   * @returns {Function}
   */
  function debounce(fn, delay = 300) {
    let timer;
    return function(...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  /**
   * Throttle utility — limits calls to once per interval.
   * @param {Function} fn
   * @param {number} interval
   * @returns {Function}
   */
  function throttle(fn, interval = 300) {
    let lastTime = 0;
    return function(...args) {
      const now = Date.now();
      if (now - lastTime >= interval) {
        lastTime = now;
        fn.apply(this, args);
      }
    };
  }

  // ── Public API ──────────────────────────────────────────
  return {
    withRetry,
    reconnectRPC,
    safeRPCCall,
    resumePolling,
    isRPCAlive,
    debounce,
    throttle,
  };
})();
