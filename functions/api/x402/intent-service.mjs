/**
 * x402 Intent Service — server-side persistence orchestration (Phase X402-2.1B)
 * ═══════════════════════════════════════════════════════════════════════════
 * Bridges the authenticated HTTP boundary to the X402IntentStore Durable Object.
 *
 * Responsibilities (pure + IO split):
 *   - Canonicalize a validated payment requirement into an unambiguous,
 *     deterministic representation (for fingerprinting).
 *   - Compute SHA-256 requirement fingerprint / resource fingerprint / request
 *     digest (domain-separated, order-stable).
 *   - Build the canonical persistent intent record.
 *   - Gate the whole persistence layer behind X402_INTENT_PERSISTENCE (off by
 *     default) and fail closed when the X402_INTENT_LOCK DO binding is absent.
 *
 * Financial precision: this module NEVER reimplements amount parsing. It uses
 * parseAtomicUnits / parseDecimalUnits / validateRequirement from _x402.mjs as
 * the single authoritative financial contract (Phase X402-2.1A).
 *
 * SECURITY: no secrets, keys, or raw session tokens are stored in intents.
 * Amounts are canonical decimal strings; BigInt is never serialized to JSON.
 */

import {
  validateRequirement,
  parseAtomicUnits,
  readFlags,
  X402_NETWORKS,
  TRUSTED_ASSETS,
  SCHEME_EXACT,
  USDC_DECIMALS,
} from './_x402.mjs';

export const SCHEMA_VERSION = 1;

// Domain separation prefixes for fingerprint/digest (avoid cross-context reuse).
const RESOURCE_DOMAIN   = 'elligentt:x402:resource:v1';
const REQUIREMENT_DOMAIN = 'elligentt:x402:requirement:v1';
const CREATE_DOMAIN     = 'elligentt:x402:create:v1';

export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._-]{8,128}$/;
export const NONCE_RE = /^\d{1,78}$/;

const DEFAULT_INTENT_TTL_SECONDS = 3600; // 1 hour (server policy, ≠ requirement timeout)
const DEFAULT_MAX_INTENTS_PER_USER = 200;

/* ── Hashing (Web Crypto — available in Workers and Node ≥ 18) ──────── */

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Deterministic SHA-256 of a canonical, order-stable object. The object is
 * JSON.stringify'd with a fixed key order (insertion order) so identical
 * semantic inputs always produce identical digests.
 */
async function canonicalDigest(domain, canonicalObj) {
  return sha256Hex(domain + ':' + JSON.stringify(canonicalObj));
}

/* ── Configuration / gates ───────────────────────────────────────────── */

export function intentPersistenceEnabled(env) {
  return String((env && env.X402_INTENT_PERSISTENCE) || 'false').toLowerCase() === 'true';
}

export function intentTtlSeconds(env) {
  const n = Number(env && env.X402_INTENT_TTL_SECONDS);
  return Number.isInteger(n) && n > 0 && n <= 86400 ? n : DEFAULT_INTENT_TTL_SECONDS;
}

export function intentMaxPerUser(env) {
  const n = Number(env && env.X402_INTENT_MAX_PER_USER);
  return Number.isInteger(n) && n > 0 && n <= 10000 ? n : DEFAULT_MAX_INTENTS_PER_USER;
}

function intentBinding(env) {
  return (env && env.X402_INTENT_LOCK) || null;
}

export function internalSecret(env) {
  return (env && env.DO_INTERNAL_SECRET) || '';
}

/* ── Canonicalization ────────────────────────────────────────────────── */

/**
 * Validate + canonicalize a raw requirement into the exact fields used for
 * fingerprinting and persistence. Returns `{ ok:false, error }` or
 * `{ ok:true, canonical, validation, trusted, chainId }`.
 *
 * The requirement is re-validated server-side (never trusted from the client).
 */
export function canonicalizeRequirement(rawReq, env) {
  const flags = readFlags(env);
  const req = rawReq && typeof rawReq === 'object' ? rawReq : {};

  const normalized = {
    scheme: String(req.scheme || SCHEME_EXACT),
    network: String(req.network || ''),
    networkRaw: String(req.network || ''),
    amount: req.amount != null ? String(req.amount) : '',
    asset: String(req.asset || ''),
    payTo: String(req.payTo || ''),
    maxTimeoutSeconds: req.maxTimeoutSeconds,
    extra: (req.extra && typeof req.extra === 'object') ? Object.assign({}, req.extra) : {},
  };

  const validation = validateRequirement(normalized, { maxUsd: flags.maxUsd });
  if (!validation.ok) {
    const firstFail = validation.checks.find((c) => !c.passed);
    return { ok: false, error: 'invalid_requirement', detail: firstFail ? firstFail.name : 'validation_failed', checks: validation.checks };
  }

  const trusted = TRUSTED_ASSETS[normalized.network];
  const net = X402_NETWORKS[normalized.network];
  if (!trusted || !net) {
    return { ok: false, error: 'unsupported_network' };
  }

  const amountAtomic = parseAtomicUnits(normalized.amount);
  if (amountAtomic === null || amountAtomic <= 0n) {
    return { ok: false, error: 'invalid_amount' };
  }

  const extraName = String((normalized.extra && normalized.extra.name) || trusted.domainName).toUpperCase();
  const extraVersion = String((normalized.extra && normalized.extra.version) || trusted.domainVersion);
  const transferMethod = String((normalized.extra && normalized.extra.assetTransferMethod) || 'eip3009');

  const canonical = {
    resourceUrl: '',
    scheme: normalized.scheme,
    network: normalized.network,
    assetAddress: trusted.address.toLowerCase(),
    amountAtomic: amountAtomic.toString(),   // canonical decimal string
    payTo: normalized.payTo.toLowerCase(),
    maxTimeoutSeconds: Number(normalized.maxTimeoutSeconds),
    domainName: extraName,
    domainVersion: extraVersion,
    assetTransferMethod: transferMethod,
  };

  return {
    ok: true,
    canonical,
    validation,
    trusted,
    chainId: net.chainId,
    tokenDecimals: trusted.decimals,
  };
}

/* ── Fingerprints / digests ──────────────────────────────────────────── */

export async function resourceFingerprintOf(resourceUrl, serviceName) {
  return canonicalDigest(RESOURCE_DOMAIN, {
    url: String(resourceUrl || ''),
    serviceName: String(serviceName || ''),
  });
}

export async function requirementDigestOf(canonical) {
  return canonicalDigest(REQUIREMENT_DOMAIN, {
    resourceUrl: canonical.resourceUrl,
    scheme: canonical.scheme,
    network: canonical.network,
    assetAddress: canonical.assetAddress,
    amountAtomic: canonical.amountAtomic,
    payTo: canonical.payTo,
    maxTimeoutSeconds: String(canonical.maxTimeoutSeconds),
    domainName: canonical.domainName,
    domainVersion: canonical.domainVersion,
    assetTransferMethod: canonical.assetTransferMethod,
  });
}

export async function createRequestDigestOf(requirementDigest, resourceFingerprint, walletAddress) {
  return canonicalDigest(CREATE_DOMAIN, {
    requirementDigest,
    resourceFingerprint,
    walletAddress: String(walletAddress || '').toLowerCase(),
  });
}

/* ── Intent record construction ──────────────────────────────────────── */

export function buildIntentRecord(opts) {
  const now = Date.now();
  return {
    schemaVersion: SCHEMA_VERSION,
    intentId: opts.intentId,
    userId: opts.userId,
    walletAddress: opts.walletAddress.toLowerCase(),
    walletProvider: opts.walletProvider || 'circle',
    resourceUrl: opts.resourceUrl,
    resourceFingerprint: opts.resourceFingerprint,
    requirementDigest: opts.requirementDigest,
    scheme: opts.canonical.scheme,
    network: opts.canonical.network,
    chainId: opts.chainId,
    assetAddress: opts.canonical.assetAddress,
    tokenDecimals: opts.tokenDecimals,
    amountAtomic: opts.canonical.amountAtomic,       // canonical decimal string
    payTo: opts.canonical.payTo,
    maxTimeoutSeconds: opts.canonical.maxTimeoutSeconds,
    authorizationNonce: null,
    idempotencyKey: opts.idempotencyKey,
    state: 'CREATED',
    stateVersion: 1,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (opts.ttlSeconds * 1000)).toISOString(),
    authorizedAt: null,
    settlementAttemptId: null,
    settlementStatus: null,
    transactionHash: null,
    settlementEvidence: null,
    lastErrorCode: null,
  };
}

/* ── Durable Object invocation ───────────────────────────────────────── */

function doHeaders(env) {
  const h = { 'Content-Type': 'application/json' };
  const secret = internalSecret(env);
  if (secret) h['X-DO-Internal-Secret'] = secret;
  return h;
}

async function doFetch(env, userId, path, body) {
  const binding = intentBinding(env);
  if (!binding) return { ok: false, status: 503, error: 'x402_intent_lock_not_configured' };
  let res;
  try {
    const doId = binding.idFromName(String(userId));
    const stub = binding.get(doId);
    res = await stub.fetch('https://x402-intent-do/' + path, {
      method: body ? 'POST' : 'GET',
      headers: doHeaders(env),
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (_) {
    return { ok: false, status: 503, error: 'x402_intent_unavailable' };
  }
  let json;
  try { json = await res.json(); } catch (_) { json = null; }
  if (res.status === 401) return { ok: false, status: 503, error: 'x402_intent_do_auth_failed' };
  if (!res.ok) {
    return { ok: false, status: res.status, error: (json && json.error) || 'x402_intent_do_error', detail: json };
  }
  return { ok: true, status: res.status, body: json };
}

export function doCreateIntent(env, userId, record, requestDigest) {
  return doFetch(env, userId, 'create', { intent: record, requestDigest });
}

export function doGetIntent(env, userId, intentId) {
  return doFetch(env, userId, 'intent?id=' + encodeURIComponent(intentId), null);
}

export function doTransition(env, userId, intentId, to, expectedVersion) {
  return doFetch(env, userId, 'transition', { intentId, to, expectedVersion });
}

export function doReserveNonce(env, userId, intentId, nonce, expectedVersion) {
  return doFetch(env, userId, 'reserve-nonce', { intentId, nonce, expectedVersion });
}
