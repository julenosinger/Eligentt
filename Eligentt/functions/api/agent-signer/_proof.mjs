/**
 * AUTONOMA-6C — Server-side Execution Authorization Proof
 * ═══════════════════════════════════════════════════════════════════════
 * A short-lived, single-use, request-bound proof that the Circle signer endpoint
 * uses to confirm an execution was authorized by the Autonoma flow.
 *
 * The proof is ISSUED server-side (never in the browser) by /api/agent-signer/authorize
 * after the existing AUTH_KV session is verified. It is an HMAC-SHA256 over the
 * canonical serialization of a bound payload, signed with AGENT_SIGNER_PROOF_SECRET
 * (a Cloudflare Secret — never in the client, git, logs or bundles).
 *
 * The proof binds: executionId, userId (session), chainId, operation, the Circle
 * wallet id/address, the exact structured request (contractAddress + abiFunctionSignature
 * + abiParameters), destination/amount, issuedAt and expiresAt. Because it is bound to
 * the exact request, tampering any field invalidates it. Because it is single-use and
 * short-lived, it cannot be replayed.
 *
 * Reuses the existing HMAC primitive (application-secret.mjs hmacSha256Hex +
 * timingSafeEqualHex) and the existing KV store (core/store.mjs coreKv).
 */

import { hmacSha256Hex, timingSafeEqualHex } from '../core/application-secret.mjs';
import { coreKv } from '../core/store.mjs';

const PROOF_SECRET_ENV = 'AGENT_SIGNER_PROOF_SECRET';
export const PROOF_TTL_MS = 120000; // 2 minutes — short-lived
export const PROOF_VERSION = 1;

const PROOF_PREFIX = 'agent:proof:';

/* ── canonical, deterministic serialization (order-independent) ── */
function canonical(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return String(value);
    return 'null';
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function utf8ToHex(str) {
  const bytes = new TextEncoder().encode(str);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

function hexToUtf8(hex) {
  const clean = String(hex).replace(/^0x/, '');
  const bytes = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  return new TextDecoder().decode(bytes);
}

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  let out = '';
  for (let i = 0; i < a.length; i++) out += a[i].toString(16).padStart(2, '0');
  return out;
}

export function getProofSecret(env) {
  return (env && env[PROOF_SECRET_ENV]) || '';
}

export function proofAvailable(env) {
  return typeof getProofSecret(env) === 'string' && getProofSecret(env).length >= 16;
}

/**
 * Sign an arbitrary record (already fully populated, incl. expiresAt) into a token.
 * Exported for tests that must craft an expired / bound proof deterministically.
 */
export async function signToken(env, record) {
  const secret = getProofSecret(env);
  if (!secret || secret.length < 16) return { ok: false, reason: 'proof_secret_unconfigured' };
  const canonicalJson = canonical(record);
  const sig = await hmacSha256Hex(secret, canonicalJson);
  return { ok: true, token: utf8ToHex(canonicalJson) + '.' + sig, canonicalJson };
}

/**
 * Issue a bound authorization proof.
 * @param {object} env Cloudflare env (must contain AGENT_SIGNER_PROOF_SECRET)
 * @param {object} payload Bound fields (executionId, userId, chainId, operation,
 *                 walletId, walletAddress, contractAddress, abiFunctionSignature,
 *                 abiParameters, destination, amount)
 * @returns {{ok:true, token, proofId, expiresAt, payload} | {ok:false, reason}}
 */
export async function issueProof(env, payload) {
  const secret = getProofSecret(env);
  if (!secret || secret.length < 16) return { ok: false, reason: 'proof_secret_unconfigured' };

  const now = Date.now();
  const proofId = randomHex(16);
  const record = Object.assign({}, payload, {
    v: PROOF_VERSION,
    proofId,
    issuedAt: now,
    expiresAt: now + PROOF_TTL_MS,
  });

  const signed = await signToken(env, record);
  if (!signed.ok) return signed;

  return { ok: true, token: signed.token, proofId, expiresAt: record.expiresAt, payload: record };
}

/**
 * Verify a proof's signature + expiry. Does NOT consume the proof.
 * @returns {{ok:true, payload, proofId} | {ok:false, reason, status}}
 */
export async function verifyProof(env, token) {
  const secret = getProofSecret(env);
  if (!secret || secret.length < 16) return { ok: false, reason: 'proof_secret_unconfigured', status: 503 };
  if (!token || typeof token !== 'string') return { ok: false, reason: 'missing_proof', status: 401 };

  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'malformed_proof', status: 401 };

  const payloadHex = token.slice(0, dot);
  const sig = token.slice(dot + 1).toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(sig)) return { ok: false, reason: 'invalid_signature', status: 401 };

  let canonicalJson;
  try {
    canonicalJson = hexToUtf8(payloadHex);
  } catch (_) {
    return { ok: false, reason: 'malformed_proof', status: 401 };
  }

  const expected = await hmacSha256Hex(secret, canonicalJson);
  if (!timingSafeEqualHex(expected, sig)) return { ok: false, reason: 'invalid_signature', status: 401 };

  let payload;
  try {
    payload = JSON.parse(canonicalJson);
  } catch (_) {
    return { ok: false, reason: 'malformed_proof', status: 401 };
  }

  const now = Date.now();
  if (!payload.expiresAt || typeof payload.expiresAt !== 'number' || now > payload.expiresAt) {
    return { ok: false, reason: 'proof_expired', status: 401 };
  }
  if (payload.issuedAt && now < payload.issuedAt - 60000) {
    return { ok: false, reason: 'proof_in_future', status: 401 };
  }

  return { ok: true, payload, proofId: payload.proofId };
}

/**
 * Single-use consumption. Returns ok the first time; replay on any repeat.
 * Best-effort (KV-optional): without KV it still fails-closed ONLY if a store is
 * absent? No — without a store we cannot guarantee single-use, so we return
 * ok:false,reason:'proof_store_unavailable' to stay fail-closed.
 */
export async function consumeProof(env, proofId) {
  if (!proofId || typeof proofId !== 'string' || proofId.length < 8) {
    return { ok: false, reason: 'missing_proof_id' };
  }
  const kv = coreKv(env);
  if (!kv || typeof kv.get !== 'function' || typeof kv.put !== 'function') {
    return { ok: false, reason: 'proof_store_unavailable', status: 503 };
  }
  const key = PROOF_PREFIX + proofId;
  try {
    const seen = await kv.get(key);
    if (seen) return { ok: false, reason: 'proof_already_consumed', status: 403 };
    await kv.put(key, '1', { expirationTtl: Math.ceil(PROOF_TTL_MS / 1000) + 60 });
    return { ok: true };
  } catch (_) {
    return { ok: false, reason: 'proof_store_error', status: 503 };
  }
}
