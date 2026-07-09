/**
 * Treasury Core API — Service-to-Service Authentication (Phase 4)
 * ═══════════════════════════════════════════════════════════════
 * Strong HMAC-SHA256 request signing between applications, replacing "internal
 * only" while remaining BACKWARD COMPATIBLE (internal traffic still works unless
 * AUTH_MODE=strict).
 *
 * A signed request carries:
 *   X-Application-Id, X-Timestamp, X-Nonce, X-Signature   (+ Correlation-ID)
 *
 * The signature is HMAC-SHA256 over:
 *   METHOD \n PATH \n TIMESTAMP \n NONCE \n BODY
 *
 * The shared secret is stored SEALED (AES-GCM) in the registry and opened only in
 * memory to verify. Rotation is supported (current + previous within grace).
 * Replay is prevented (timestamp window + single-use nonce). Origin/IP binding is
 * enforced when configured on the application.
 */
import { getFlags } from './flags.mjs';
import { getApplication } from './registry.mjs';
import { openSecret, hmacSha256Hex, timingSafeEqualHex } from './application-secret.mjs';
import { timestampValid, consumeNonce } from './replay.mjs';
import { resolveApplicationContext } from '../application-context.mjs';

export function hasHmacCredentials(request) {
  try {
    const h = request.headers;
    return !!(h.get('X-Signature') && h.get('X-Application-Id') && h.get('X-Timestamp') && h.get('X-Nonce'));
  } catch (_) { return false; }
}

function detectExternalScheme(request) {
  const h = request.headers;
  if (h.get('X-Api-Key') || h.get('X-Application-Token')) return 'apikey';
  const authz = h.get('Authorization') || '';
  if (/^Bearer\s+/i.test(authz)) {
    return authz.replace(/^Bearer\s+/i, '').split('.').length === 3 ? 'jwt' : 'bearer';
  }
  if (h.get('X-Client-Cert') || h.get('X-Client-Cert-Verified')) return 'mtls';
  return null;
}

export function signingString(method, path, timestamp, nonce, body) {
  return [String(method).toUpperCase(), path, String(timestamp), String(nonce), body || ''].join('\n');
}

/**
 * Verify a signed (HMAC) request.
 * @returns {Promise<{ok, method, application, appRecord?, context?, code?, reason?, status?}>}
 */
export async function verifyHmac(request, env, rawBody) {
  const h = request.headers;
  const appId = h.get('X-Application-Id');
  const ts = h.get('X-Timestamp');
  const nonce = h.get('X-Nonce');
  const sig = (h.get('X-Signature') || '').toLowerCase().replace(/^0x/, '');
  const path = new URL(request.url).pathname;

  const tsCheck = timestampValid(ts);
  if (!tsCheck.valid) {
    return { ok: false, code: 'AUTH_TIMESTAMP', reason: tsCheck.reason, status: 401, application: appId };
  }

  const appRecord = await getApplication(env, appId);
  const appName = appRecord ? appRecord.applicationId : appId;

  // Origin binding (when the application declares allowedOrigins).
  const origin = h.get('Origin');
  if (origin && Array.isArray(appRecord.allowedOrigins) && appRecord.allowedOrigins.length && !appRecord.allowedOrigins.includes(origin)) {
    return { ok: false, code: 'AUTH_ORIGIN', reason: 'origin_not_allowed', status: 403, application: appName };
  }
  // IP binding (when the application declares allowedIps).
  const ip = h.get('CF-Connecting-IP') || h.get('X-Forwarded-For');
  if (ip && Array.isArray(appRecord.allowedIps) && appRecord.allowedIps.length && !appRecord.allowedIps.includes(ip)) {
    return { ok: false, code: 'AUTH_IP', reason: 'ip_not_allowed', status: 403, application: appName };
  }

  // ── Resolve candidate shared secrets (current + previous for rotation grace) ──
  // PREFERRED: the plaintext secret lives ONLY as a Cloudflare Secret env var
  //   <APPID>_APP_SECRET (and optional <APPID>_APP_SECRET_PREVIOUS during rotation).
  //   It is never stored in KV, git, logs, HTML or bundles.
  // FALLBACK: a secret sealed at rest (AES-GCM) in the registry, opened with the
  //   CORE_SECRET_KEY master key.
  const candidates = [];
  const envName = String(appName).toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_APP_SECRET';
  if (env[envName]) candidates.push(env[envName]);
  if (env[envName + '_PREVIOUS']) candidates.push(env[envName + '_PREVIOUS']);

  const master = env.CORE_SECRET_KEY;
  const secretRec = appRecord && appRecord.secret;
  if (secretRec && secretRec.ciphertext && master) {
    const cur = await openSecret(secretRec, master);
    if (cur) candidates.push(cur);
    if (secretRec.previous && (!secretRec.previous.expiresAt || secretRec.previous.expiresAt > Date.now())) {
      const prev = await openSecret(secretRec.previous, master);
      if (prev) candidates.push(prev);
    }
  }

  if (!candidates.length) {
    return { ok: false, code: 'AUTH_NO_SECRET', reason: 'no_secret_configured', status: 401, application: appName };
  }

  const msg = signingString(request.method, path, ts, nonce, rawBody);

  let matched = false;
  for (const s of candidates) {
    const expected = await hmacSha256Hex(s, msg);
    if (timingSafeEqualHex(expected, sig)) { matched = true; break; }
  }
  if (!matched) {
    return { ok: false, code: 'AUTH_SIGNATURE', reason: 'invalid_signature', status: 401, application: appRecord.applicationId };
  }

  // Replay guard — consume nonce only AFTER a valid signature.
  const nonceCheck = await consumeNonce(env, appRecord.applicationId, nonce);
  if (!nonceCheck.ok) {
    return { ok: false, code: 'AUTH_REPLAY', reason: nonceCheck.reason, status: 401, application: appRecord.applicationId };
  }

  const context = resolveApplicationContext({ applicationId: appRecord.applicationId }, env, request);
  return { ok: true, method: 'hmac', application: appRecord.applicationId, appRecord, context, timestampSkew: tsCheck.skew };
}

/**
 * Unified access verification used by the pipeline.
 * @param {Request} request
 * @param {object} env
 * @param {{ rawBody:string, body:object }} payload
 */
export async function verifyAccess(request, env, payload) {
  const flags = getFlags(env);
  const body = (payload && payload.body) || {};
  const rawBody = (payload && payload.rawBody) || '';
  const context = resolveApplicationContext(body, env, request);

  if (hasHmacCredentials(request)) {
    return await verifyHmac(request, env, rawBody);
  }

  if (flags.authMode === 'strict') {
    return { ok: false, code: 'AUTH_SIGNATURE_REQUIRED', reason: 'signature_required', status: 401, application: context.application, context };
  }

  const external = detectExternalScheme(request);
  if (external) {
    return { ok: false, code: 'AUTH_NOT_ENABLED', reason: 'not_enabled', method: external, status: 401, application: context.application, context };
  }

  return { ok: true, method: 'internal', application: context.application, context };
}
