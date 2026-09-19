/**
 * Application Authentication — Phase 1 SCAFFOLDING ONLY
 * ═════════════════════════════════════════════════════
 * Prepares the Treasury to accept authenticated calls from external consumer
 * applications (e.g. a future EXECDAAT) WITHOUT implementing any specific
 * external integration in this phase.
 *
 * DESIGN GOALS
 *   - Modular: pluggable strategies (Application Token / API Key / JWT / HMAC /
 *     mTLS) registered in a registry so future phases only add a strategy.
 *   - Non-breaking: this module is NOT wired as a gate into the existing relayer
 *     / mint flow. Elligentt's own (internal) traffic keeps working with zero
 *     auth changes. It exists so the surface is ready, and is fully unit tested.
 *   - Safe: never returns or logs secrets/keys. Unknown/unconfigured strategies
 *     fail CLOSED ("not_implemented") rather than silently allowing access.
 *
 * SECURITY: private keys (OPERATOR/TURBO_RELAYER/TREASURY/VAULT) live ONLY in
 * Elligentt and are NEVER referenced here. Client applications never hold them.
 */
import { resolveApplicationContext } from './application-context.mjs';

export const AUTH_METHODS = Object.freeze(['none', 'internal', 'apikey', 'jwt', 'hmac', 'mtls']);

// Strategy registry. Each strategy: async (request, env, ctx) => { ok, method, application?, reason? }
const _strategies = new Map();

export function registerAuthStrategy(name, fn) {
  if (typeof name !== 'string' || typeof fn !== 'function') {
    throw new Error('registerAuthStrategy requires (name, fn)');
  }
  _strategies.set(name.toLowerCase(), fn);
}

export function hasAuthStrategy(name) {
  return _strategies.has(String(name || '').toLowerCase());
}

export function listAuthStrategies() {
  return Array.from(_strategies.keys());
}

function fail(reason, method) {
  return { ok: false, method: method || 'none', reason };
}

// ── Built-in strategies ──────────────────────────────────────────────────────

// Internal Elligentt traffic (same-origin / no external credential presented).
// In CORE mode this is the ELLIGENT application itself. Always allowed because it
// is authenticated by deployment context, not by a client credential.
registerAuthStrategy('internal', async (request, env, ctx) => {
  return { ok: true, method: 'internal', application: (ctx && ctx.application) || 'ELLIGENT' };
});

// Application Token / API Key — enabled ONLY when APPLICATION_API_KEYS is
// configured as JSON (e.g. {"EXECDAAT":"<hash-or-token-ref>"}). Not implemented
// as a real credential check yet: fails closed until a future phase wires it.
registerAuthStrategy('apikey', async (request, env, _ctx) => {
  const configured = env && env.APPLICATION_API_KEYS;
  if (!configured) return fail('not_configured', 'apikey');
  // Placeholder: future phase verifies the presented token against the config.
  return fail('not_implemented', 'apikey');
});

// JWT bearer — scaffolding placeholder (fails closed).
registerAuthStrategy('jwt', async (request, env) => {
  if (!(env && env.APPLICATION_JWT_SECRET)) return fail('not_configured', 'jwt');
  return fail('not_implemented', 'jwt');
});

// HMAC signed request — scaffolding placeholder (fails closed).
registerAuthStrategy('hmac', async (request, env) => {
  if (!(env && env.APPLICATION_HMAC_SECRET)) return fail('not_configured', 'hmac');
  return fail('not_implemented', 'hmac');
});

// mTLS client cert — scaffolding placeholder (fails closed).
registerAuthStrategy('mtls', async (request, env) => {
  if (!(env && env.APPLICATION_MTLS_ENABLED)) return fail('not_configured', 'mtls');
  return fail('not_implemented', 'mtls');
});

// Detect which method a request is presenting (header inspection only).
function detectMethod(request) {
  if (!request || typeof request.headers?.get !== 'function') return 'internal';
  const h = request.headers;
  if (h.get('X-Application-Token') || h.get('X-Api-Key')) return 'apikey';
  const authz = h.get('Authorization') || '';
  if (/^Bearer\s+/i.test(authz)) return 'jwt';
  if (h.get('X-Signature') || h.get('X-Hmac')) return 'hmac';
  if (h.get('X-Client-Cert') || h.get('X-Client-Cert-Verified')) return 'mtls';
  return 'internal';
}

/**
 * Verify an application request. SCAFFOLDING: with no external credential
 * presented, internal (ELLIGENT) traffic is allowed so the existing platform is
 * unaffected. Any external method is dispatched to its strategy which fails
 * closed until a future phase enables it.
 *
 * @returns {Promise<{ok:boolean, method:string, application?:string, context?:object, reason?:string}>}
 */
export async function verifyApplicationAuth(request, env, body) {
  const ctx = resolveApplicationContext(body, env, request);
  const method = detectMethod(request);
  const strategy = _strategies.get(method) || _strategies.get('internal');
  try {
    const result = await strategy(request, env, ctx);
    return { ...result, application: result.application || ctx.application, context: ctx };
  } catch (e) {
    return { ok: false, method, reason: (e && e.message) || 'strategy_error', context: ctx };
  }
}
