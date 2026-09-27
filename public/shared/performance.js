/**
 * Performance Optimizations — Lazy loading, caching, render optimizations
 * ═══════════════════════════════════════════════════════════
 * Does NOT alter blockchain flows, financial flows, or Treasury logic.
 * Improves UI responsiveness and reduces parse time.
 */

const Performance = (() => {

  // ── Lazy-load non-critical page sections ─────────────────
  // Pages that are not visible on load can defer their initialization
  const _initializedPages = new Set();

  function lazyInit(pageId, initFn) {
    if (_initializedPages.has(pageId)) return;
    _initializedPages.add(pageId);
    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(() => initFn(), { timeout: 3000 });
    } else {
      setTimeout(initFn, 500);
    }
  }

  // ── Debounced UI updates for Treasury metrics ────────────
  // Prevent excessive DOM writes during rapid state changes
  let _vaultUpdatePending = false;

  function debounceVaultRefresh(delay = 300) {
    if (_vaultUpdatePending) return;
    _vaultUpdatePending = true;
    setTimeout(() => {
      _vaultUpdatePending = false;
      if (typeof vaultRefreshAll === 'function') {
        vaultRefreshAll().catch(() => {});
      }
    }, delay);
  }

  // ── Memoization cache for expensive computations ─────────
  const _memoCache = new Map();
  const MEMO_TTL = 60000; // 60 seconds

  function memoize(key, computeFn, ttl = MEMO_TTL) {
    const entry = _memoCache.get(key);
    const now = Date.now();
    if (entry && (now - entry.time) < ttl) {
      return entry.value;
    }
    const value = computeFn();
    _memoCache.set(key, { value, time: now });
    return value;
  }

  function bustMemoCache() {
    _memoCache.clear();
  }

  // ── RequestAnimationFrame batching for DOM writes ────────
  let _rafQueue = [];
  let _rafScheduled = false;

  function batchDOMWrite(fn) {
    _rafQueue.push(fn);
    if (!_rafScheduled) {
      _rafScheduled = true;
      requestAnimationFrame(() => {
        const queue = _rafQueue;
        _rafQueue = [];
        _rafScheduled = false;
        queue.forEach(f => { try { f(); } catch(e) {} });
      });
    }
  }

  // ── IntersectionObserver for lazy rendering ──────────────
  function observeVisibility(el, onVisible) {
    if (typeof IntersectionObserver === 'undefined') {
      onVisible();
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          observer.disconnect();
          onVisible();
        }
      });
    }, { rootMargin: '200px' });
    observer.observe(el);
  }

  // ── Cleanup timer refs on page hide ──────────────────────
  let _visibilityTimerRefs = [];

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        // Pause expensive loops, clear memo cache
        bustMemoCache();
      } else {
        // Resume polling
        if (typeof Resilience !== 'undefined') {
          Resilience.resumePolling();
        }
      }
    });
  }

  // ── Public API ──────────────────────────────────────────
  return {
    lazyInit,
    debounceVaultRefresh,
    memoize,
    bustMemoCache,
    batchDOMWrite,
    observeVisibility,
  };
})();
