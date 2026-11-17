/**
 * Cloudflare Pages Function — /api/x402/intent (and /api/x402/intent/*)
 * ═══════════════════════════════════════════════════════════════════════
 * Phase X402-2.1B — persistent payment-intent API (durable, idempotent,
 * replay-resistant). This is an ADDITIVE, independently-gated surface: it does
 * NOT change /api/x402/prepare or any existing endpoint.
 *
 * The entire surface is gated behind X402_INTENT_PERSISTENCE (off by default).
 * When off — or when the X402_INTENT_LOCK Durable Object binding is absent —
 * every route fails closed with HTTP 503. No real payment, signing, settlement
 * or broadcast is performed here.
 *
 * Routes:
 *   POST /api/x402/intent            → createIntent (atomic create-or-return)
 *   GET  /api/x402/intent/:id        → getIntent / getIntentStatus
 *   POST /api/x402/intent/:id/prepare→ prepareIntent (CREATED → PREPARED)
 *   POST /api/x402/intent/:id/cancel → cancelIntent (→ CANCELLED)
 *
 * reserveAuthorizationNonce is a service-layer operation only (not a public
 * route) — reserved for the future server-side signing flow.
 *
 * SECURITY:
 *   - Identity and wallet are resolved from the authenticated server session
 *     (AUTH_KV), never from the request body.
 *   - Every read/mutation is ownership-checked: intents live in a per-user
 *     Durable Object, so cross-user access is structurally impossible.
 *   - Amounts are canonical decimal strings; BigInt is never serialized.
 */

import { resolveUserWallet } from './index.js';
import {
  intentPersistenceEnabled,
  canonicalizeRequirement,
  resourceFingerprintOf,
  requirementDigestOf,
  createRequestDigestOf,
  buildIntentRecord,
  doCreateIntent,
  doGetIntent,
  doTransition,
  redactIntent,
  intentTtlSeconds,
  IDEMPOTENCY_KEY_RE,
} from './intent-service.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function err(msg, status = 400, extra = {}) {
  return json(Object.assign({ ok: false, error: msg }, extra), status);
}

function disabledResponse() {
  return err('x402 intent persistence is disabled (X402_INTENT_PERSISTENCE=false)', 503, {
    code: 'x402_intent_persistence_disabled',
  });
}

/* ── Handlers ────────────────────────────────────────────────────────── */

async function handleCreate(env, request) {
  const auth = await resolveUserWallet(env, request);
  if (!auth.authed) return err('Unauthorized: ' + auth.reason, auth.status || 401);
  if (auth.needsProvision || !auth.walletAddress) {
    return err('Circle AI Smart Wallet not provisioned for this session', 400, { code: 'wallet_not_provisioned' });
  }

  let body;
  try { body = await request.json(); } catch (_) { return err('Invalid JSON body', 400); }

  const resourceUrl = body && typeof body.resourceUrl === 'string' ? body.resourceUrl.trim().slice(0, 2048) : '';
  const requirement = body && body.requirement ? body.requirement : null;
  const idempotencyKey = body && typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
  const serviceName = body && body.resource && typeof body.resource.serviceName === 'string'
    ? body.resource.serviceName.trim().slice(0, 64) : '';

  if (!resourceUrl) return err('resourceUrl is required', 400);
  if (!requirement || typeof requirement !== 'object') return err('requirement is required', 400);
  if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    return err('idempotencyKey must be 8–128 chars of [A-Za-z0-9._-]', 400, { code: 'invalid_idempotency_key' });
  }

  // Re-validate + canonicalize the requirement server-side (exact BigInt, 2.1A).
  const canon = canonicalizeRequirement(requirement, env);
  if (!canon.ok) return err('Invalid requirement: ' + canon.detail, 400, { code: canon.error, detail: canon.detail });

  canon.canonical.resourceUrl = resourceUrl;

  const resourceFingerprint = await resourceFingerprintOf(resourceUrl, serviceName);
  const requirementDigest = await requirementDigestOf(canon.canonical);
  const requestDigest = await createRequestDigestOf(requirementDigest, resourceFingerprint, auth.walletAddress);

  const record = buildIntentRecord({
    intentId: crypto.randomUUID(),
    userId: auth.userId,
    walletAddress: auth.walletAddress,
    walletProvider: 'circle',
    resourceUrl,
    resourceFingerprint,
    requirementDigest,
    canonical: canon.canonical,
    chainId: canon.chainId,
    tokenDecimals: canon.tokenDecimals,
    idempotencyKey,
    ttlSeconds: intentTtlSeconds(env),
  });

  const res = await doCreateIntent(env, auth.walletAddress, record, requestDigest);
  if (!res.ok) {
    if (res.status === 409 && res.detail && res.detail.existingIntentId) {
      return err('idempotencyKey already used for a different payment request', 409, { code: 'idempotency_conflict' });
    }
    if (res.status === 429) return err('too many intents for this account', 429, { code: 'too_many_intents' });
    return err(res.error || 'intent persistence unavailable', res.status || 503, { code: res.error });
  }

  return json({ ok: true, idempotent: !res.body.created, intent: redactIntent(res.body.intent) });
}

async function handleGet(env, request, intentId) {
  const auth = await resolveUserWallet(env, request);
  if (!auth.authed) return err('Unauthorized: ' + auth.reason, auth.status || 401);

  const res = await doGetIntent(env, auth.walletAddress, auth.userId, intentId);
  if (!res.ok) {
    if (res.status === 404) return err('intent not found', 404, { code: 'not_found' });
    return err(res.error || 'intent persistence unavailable', res.status || 503, { code: res.error });
  }
  return json({ ok: true, intent: redactIntent(res.body.intent) });
}

async function handlePrepare(env, request, intentId) {
  const auth = await resolveUserWallet(env, request);
  if (!auth.authed) return err('Unauthorized: ' + auth.reason, auth.status || 401);

  let body;
  try { body = await request.json(); } catch (_) { body = {}; }
  const expectedVersion = Number(body && body.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return err('expectedVersion (integer ≥ 1) is required', 400, { code: 'invalid_version' });
  }

  const res = await doTransition(env, auth.walletAddress, auth.userId, intentId, 'PREPARED', expectedVersion);
  return mapTransitionResult(res);
}

async function handleCancel(env, request, intentId) {
  const auth = await resolveUserWallet(env, request);
  if (!auth.authed) return err('Unauthorized: ' + auth.reason, auth.status || 401);

  let body;
  try { body = await request.json(); } catch (_) { body = {}; }
  const expectedVersion = Number(body && body.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return err('expectedVersion (integer ≥ 1) is required', 400, { code: 'invalid_version' });
  }

  const res = await doTransition(env, auth.walletAddress, auth.userId, intentId, 'CANCELLED', expectedVersion);
  return mapTransitionResult(res);
}

function mapTransitionResult(res) {
  if (!res.ok) {
    if (res.status === 404) return err('intent not found', 404, { code: 'not_found' });
    if (res.status === 409 && res.error === 'stale_version') {
      return err('intent was modified concurrently — refresh and retry', 409, {
        code: 'stale_version',
        current: res.detail && res.detail.current,
      });
    }
    if (res.status === 409 && res.error === 'intent_expired') return err('intent expired', 409, { code: 'intent_expired' });
    if (res.status === 400 && res.error === 'invalid_transition') {
      return err('invalid state transition', 400, { code: 'invalid_transition', from: res.detail && res.detail.from, to: res.detail && res.detail.to });
    }
    return err(res.error || 'intent persistence unavailable', res.status || 503, { code: res.error });
  }
  return json({ ok: true, idempotent: !!res.body.idempotent, intent: redactIntent(res.body.intent) });
}

/* ── Main handler ────────────────────────────────────────────────────── */

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  // Fail-closed gate: persistence is disabled until explicitly enabled AND the
  // Durable Object binding is provisioned.
  if (!intentPersistenceEnabled(env)) {
    return disabledResponse();
  }

  const url = new URL(request.url);
  const parts = url.pathname.replace(/\/$/, '').split('/');
  // /api/x402/intent            → ['','api','x402','intent']
  // /api/x402/intent/<id>       → ['','api','x402','intent','<id>']
  // /api/x402/intent/<id>/<sub> → ['','api','x402','intent','<id>','<sub>']
  const intentId = parts[4] || '';
  const sub = parts[5] || '';

  try {
    if (request.method === 'POST' && !intentId) {
      return await handleCreate(env, request);
    }
    if (request.method === 'GET' && intentId && !sub) {
      return await handleGet(env, request, intentId);
    }
    if (request.method === 'POST' && intentId && sub === 'prepare') {
      return await handlePrepare(env, request, intentId);
    }
    if (request.method === 'POST' && intentId && sub === 'cancel') {
      return await handleCancel(env, request, intentId);
    }
    return err('Not found', 404);
  } catch (e) {
    console.error('[x402:intent] unhandled error:', e && e.message);
    return err((e && e.message) || 'Internal error', 500);
  }
}
