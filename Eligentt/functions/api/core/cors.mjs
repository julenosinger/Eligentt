/**
 * Treasury Core API — Restricted CORS (Phase 4)
 * ═══════════════════════════════════════════════
 * Replaces any wildcard CORS with a strict allowlist. Origins are drawn from:
 *   - env.ALLOWED_ORIGINS         (comma list — existing config)
 *   - env.CORE_ALLOWED_ORIGINS    (comma list — additional registered domains)
 *   - a static set of first-party production domains
 * Never emits "*". Per-application origin binding is additionally enforced in the
 * HMAC auth layer (registry.allowedOrigins).
 */

const STATIC_ALLOWED = [
  'https://execdaat.xyz',
  'https://elligentt.xyz',
  'https://elligente.pages.dev',
];

const ALLOWED_METHODS = 'GET, POST, OPTIONS';
const ALLOWED_HEADERS = 'Content-Type, Authorization, X-Api-Key, X-Application-Token, X-Application-Id, X-Timestamp, X-Nonce, X-Signature, X-Correlation-ID, Correlation-ID, X-Application-Version, X-Client-Version';

export function allowedOrigins(env) {
  const e = env || {};
  const fromEnv = [(e.ALLOWED_ORIGINS || ''), (e.CORE_ALLOWED_ORIGINS || '')]
    .join(',')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return Array.from(new Set([...fromEnv, ...STATIC_ALLOWED]));
}

export function isOriginAllowed(origin, env) {
  if (!origin) return true; // server-to-server / same-origin (no Origin header)
  return allowedOrigins(env).includes(origin);
}

/**
 * Build CORS headers for a request. The echoed origin is ONLY ever an allowlisted
 * value — never "*", never an arbitrary caller origin.
 */
export function resolveCors(request, env) {
  const list = allowedOrigins(env);
  let origin = '';
  try { origin = (request && request.headers.get('Origin')) || ''; } catch (_) {}
  const echo = list.includes(origin) ? origin : (list[0] || 'https://elligente.pages.dev');
  return {
    'Access-Control-Allow-Origin': echo,
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Expose-Headers': 'X-Correlation-ID, X-Request-ID, Retry-After',
    'Vary': 'Origin',
    'Content-Type': 'application/json',
  };
}
