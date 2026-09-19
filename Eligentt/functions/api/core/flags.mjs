/**
 * Treasury Core API — Feature Flags (Phase 4)
 * ════════════════════════════════════════════
 * Environment-configurable switches that let production hardening features be
 * rolled out safely. Defaults are chosen to be SAFE and BACKWARD COMPATIBLE:
 *
 *   AUTH_MODE        internal | strict            (default: internal)
 *   RATE_LIMIT_MODE  off | record | enforce       (default: enforce)
 *   CIRCUIT_BREAKER  on | off                      (default: on)
 *   OBSERVABILITY    on | off                      (default: on)
 *   AUDIT            on | off                      (default: on)
 *
 * - internal: same-origin/no-credential traffic is allowed (as today) AND valid
 *   HMAC requests are accepted. strict: a valid HMAC signature is REQUIRED.
 * - Rate limiting defaults to enforce, but the Core API has no legacy consumers
 *   and limits are generous, so authorized traffic is never affected.
 */

function norm(v, def) {
  return (v == null || v === '') ? def : String(v).toLowerCase();
}

export function getFlags(env) {
  const e = env || {};
  return {
    authMode: norm(e.AUTH_MODE, 'internal'),              // internal | strict
    rateLimitMode: norm(e.RATE_LIMIT_MODE, 'enforce'),    // off | record | enforce
    circuitBreaker: norm(e.CIRCUIT_BREAKER, 'on') !== 'off',
    observability: norm(e.OBSERVABILITY, 'on') !== 'off',
    audit: norm(e.AUDIT, 'on') !== 'off',
  };
}

export function isStrictAuth(env) {
  return getFlags(env).authMode === 'strict';
}
