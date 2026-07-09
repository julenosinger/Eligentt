/**
 * Treasury Core API — Authentication Layer (Phase 2)
 * ═══════════════════════════════════════════════════
 * Modular, pluggable authentication. In THIS phase only "internal" is ENABLED;
 * apikey / jwt / hmac / mtls / bearer are PREPARED (detected + routed) but return
 * { ok:false, reason:'not_enabled' } — they are not activated until Phase 3.
 *
 *   Internal  → same-origin / no external credential → allowed as the resolved
 *               application (ELLIGENT by default). This is what keeps the current
 *               platform working with zero auth changes.
 *   External  → any presented credential is recognized but refused (fail-closed),
 *               so nothing can accidentally authenticate before Phase 3.
 *
 * SECURITY: never logs/returns credentials. Reuses the Phase 1 context resolver.
 */
import { resolveApplicationContext } from '../application-context.mjs';

export const CORE_AUTH_METHODS = Object.freeze(['internal', 'apikey', 'jwt', 'hmac', 'mtls', 'bearer']);
export const ENABLED_METHODS = Object.freeze(['internal']);

export function isMethodEnabled(method) {
  return ENABLED_METHODS.includes(String(method || '').toLowerCase());
}

// Detect which scheme a request presents (header inspection only).
export function detectAuthMethod(request) {
  if (!request || typeof request.headers?.get !== 'function') return 'internal';
  const h = request.headers;
  if (h.get('X-Api-Key') || h.get('X-Application-Token')) return 'apikey';
  if (h.get('X-Signature') || h.get('X-Hmac')) return 'hmac';
  if (h.get('X-Client-Cert') || h.get('X-Client-Cert-Verified')) return 'mtls';
  const authz = h.get('Authorization') || '';
  if (/^Bearer\s+/i.test(authz)) {
    // A JWT is a bearer token with two dots; otherwise treat as opaque bearer.
    const token = authz.replace(/^Bearer\s+/i, '');
    return token.split('.').length === 3 ? 'jwt' : 'bearer';
  }
  return 'internal';
}

/**
 * Authenticate a request.
 * @returns {Promise<{ok:boolean, method:string, application:string, context:object, reason?:string}>}
 */
export async function authenticate(request, env, body) {
  const context = resolveApplicationContext(body, env, request);
  const method = detectAuthMethod(request);

  if (method === 'internal') {
    return { ok: true, method: 'internal', application: context.application, context };
  }

  // External scheme presented → recognized but NOT enabled in this phase.
  return {
    ok: false,
    method,
    application: context.application,
    context,
    reason: 'not_enabled',
  };
}
