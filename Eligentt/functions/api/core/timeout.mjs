/**
 * Treasury Core API — Timeouts & Safe Retry (Phase 4)
 * ═════════════════════════════════════════════════════
 * Standardized timeouts per operation class and an EXPONENTIAL retry helper that
 * is ONLY ever applied to idempotent, read-only work (quote/history/health/
 * metrics dependency reads). Financial operations (execute) are NEVER retried
 * automatically — a failed on-chain action must not be silently repeated.
 */

export const TIMEOUTS = Object.freeze({
  quote: 5000,
  execute: 30000,   // long — on-chain; NO auto-retry
  history: 8000,
  health: 6000,
  metrics: 8000,
  rpc: 5000,
  default: 8000,
});

export function timeoutFor(kind) {
  return TIMEOUTS[kind] || TIMEOUTS.default;
}

/** Run a promise-returning fn with an abort-style timeout. */
export async function withTimeout(fn, ms, label) {
  const timeout = ms || TIMEOUTS.default;
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('TIMEOUT' + (label ? ':' + label : '') + ' after ' + timeout + 'ms')), timeout);
  });
  try {
    return await Promise.race([Promise.resolve().then(fn), guard]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Exponential-backoff retry for SAFE, idempotent reads only.
 * @param {Function} fn - async () => result
 * @param {object} opts - { retries=2, baseMs=150, factor=2, onRetry }
 */
export async function withRetry(fn, opts) {
  const o = opts || {};
  const retries = o.retries == null ? 2 : o.retries;
  const base = o.baseMs || 150;
  const factor = o.factor || 2;
  let attempt = 0;
  let lastErr;
  while (attempt <= retries) {
    try {
      return { ok: true, value: await fn(), attempts: attempt + 1 };
    } catch (e) {
      lastErr = e;
      if (attempt === retries) break;
      const delay = base * Math.pow(factor, attempt);
      if (typeof o.onRetry === 'function') { try { o.onRetry(attempt + 1, e); } catch (_) {} }
      await new Promise(r => setTimeout(r, delay));
      attempt++;
    }
  }
  return { ok: false, error: lastErr, attempts: attempt + 1 };
}
