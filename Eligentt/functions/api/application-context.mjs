/**
 * Multi-Application Context Resolver — Phase 1 (Core Infrastructure)
 * ═════════════════════════════════════════════════════════════════
 * The Elligentt Treasury is a shared Liquidity Core consumed by multiple
 * applications (ELLIGENT today, EXECDAAT next, more later). Every Treasury
 * operation is attributed to an Application + Client so the ledger, memos and
 * dashboard can be segregated per consumer — WITHOUT duplicating liquidity,
 * keys or Treasury logic.
 *
 * BACKWARD COMPATIBILITY: every field is OPTIONAL on the wire. When a caller
 * omits them the defaults are applied:
 *     Application = ELLIGENT
 *     Client      = default
 *     Version     = 1
 * so no existing integration is affected.
 *
 * This module is pure (no I/O, no keys) and safe to unit test.
 */
import { RELAYER_CONFIG } from './shared-config.mjs';

const APP_CFG = RELAYER_CONFIG.APPLICATION || {};

export const APPLICATION_DEFAULTS = Object.freeze({
  application: APP_CFG.DEFAULT_APP || 'ELLIGENT',
  client:      APP_CFG.DEFAULT_CLIENT || 'default',
  version:     APP_CFG.DEFAULT_VERSION || '1',
  environment: APP_CFG.DEFAULT_ENVIRONMENT || 'production',
});

export const KNOWN_APPLICATIONS = Object.freeze(
  Array.isArray(APP_CFG.KNOWN_APPS) ? [...APP_CFG.KNOWN_APPS] : ['ELLIGENT', 'EXECDAAT', 'FUTURE_APP']
);

const MAX_LEN = Number(APP_CFG.MAX_FIELD_LEN) || 32;

// Return true when the Elligentt core runs as shared infrastructure. Env can
// override the compiled default (APPLICATION_MODE=CORE).
export function applicationMode(env) {
  const m = (env && env.APPLICATION_MODE) || APP_CFG.MODE || 'CORE';
  return String(m).toUpperCase();
}

// SECURITY / SAFETY: tokens flow into on-chain memos and ledger keys. Strip the
// memo delimiter ('|'), control chars and whitespace, and cap the length so a
// hostile or malformed value can never corrupt the memo grammar or ledger keys.
export function sanitizeToken(value, fallback) {
  if (value === undefined || value === null) return fallback;
  let s = String(value).trim();
  if (!s) return fallback;
  // remove pipe (memo delimiter), any ASCII control chars, and collapse spaces
  s = s.replace(/\|/g, '').replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, '_');
  if (!s) return fallback;
  if (s.length > MAX_LEN) s = s.slice(0, MAX_LEN);
  return s;
}

function firstDefined(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
}

/**
 * Resolve the multi-application context for a Treasury operation.
 *
 * @param {object} body     - parsed request body (may be null/undefined)
 * @param {object} [env]    - Cloudflare env (optional)
 * @param {Request} [request] - the incoming Request (optional, for Origin)
 * @returns {{application:string, client:string, version:string, environment:string, origin:(string|null), mode:string, known:boolean}}
 */
export function resolveApplicationContext(body, env, request) {
  const b = (body && typeof body === 'object') ? body : {};
  const nested = (b.application && typeof b.application === 'object') ? b.application : {};

  const application = sanitizeToken(
    firstDefined(b.applicationId, b.appId, typeof b.application === 'string' ? b.application : undefined, nested.id, env && env.APPLICATION_ID),
    APPLICATION_DEFAULTS.application
  ).toUpperCase();

  const client = sanitizeToken(
    firstDefined(b.clientId, typeof b.client === 'string' ? b.client : undefined, nested.client, env && env.CLIENT_ID),
    APPLICATION_DEFAULTS.client
  );

  const version = sanitizeToken(
    firstDefined(b.version, b.apiVersion, nested.version, env && env.APPLICATION_VERSION),
    APPLICATION_DEFAULTS.version
  );

  const environment = sanitizeToken(
    firstDefined(b.environment, b.env, nested.environment, env && env.APPLICATION_ENVIRONMENT, env && env.NODE_ENV),
    APPLICATION_DEFAULTS.environment
  );

  let origin = firstDefined(b.origin, nested.origin);
  if (!origin && request && typeof request.headers?.get === 'function') {
    origin = request.headers.get('Origin') || request.headers.get('Referer') || null;
  }
  origin = origin ? String(origin).slice(0, 256) : null;

  return {
    application,
    client,
    version,
    environment,
    origin,
    mode: applicationMode(env),
    known: KNOWN_APPLICATIONS.includes(application),
  };
}

// Convenience: expose only the identity triple (used for telemetry / ledger).
export function applicationIdentity(ctx) {
  return { application: ctx.application, client: ctx.client, version: ctx.version };
}
