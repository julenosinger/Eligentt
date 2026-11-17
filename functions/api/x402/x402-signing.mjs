/**
 * x402 — Circle Wallet EIP-712 signing adapter (gated, server-side only)
 * ═══════════════════════════════════════════════════════════════════════════
 * Isolated provider adapter that signs an EIP-3009 TransferWithAuthorization
 * via the Circle W3S developer-controlled wallet "Sign typed data" endpoint.
 *
 *   POST https://api.circle.com/v1/w3s/developer/sign/typedData
 *     body: { walletId, data (EIP-712 JSON string), entitySecretCiphertext, memo? }
 *     → 200 { data: { signature } }
 *
 * This module NEVER broadcasts, never settles, never transfers. A signature is
 * NOT a payment. It is gated behind X402_SIGNING_ENABLED (default off) AND
 * Circle credentials; without both, every signing call fails closed.
 *
 * SECURITY:
 *   - No Circle API key / entity secret / signature is ever returned to the
 *     browser. Only structured verification results leave the server.
 *   - The typed data is built EXCLUSIVELY from a validated persistent intent
 *     (never from client-supplied fields), so this is not a generic signing proxy.
 *   - Every signature is verified locally against the exact terms before it is
 *     persisted. Circle returning HTTP 200 is never treated as proof of validity.
 */
import {
  buildTransferWithAuthorization,
  verifyTransferWithAuthorization,
} from './x402-eip712.mjs';
import { doAuthorize } from './intent-service.mjs';
import { encryptEntitySecret, getCredentials } from '../agent-signer/_circle.js';

const W3S_BASE = 'https://api.circle.com/v1/w3s';
const DEFAULT_MAX_AUTH_WINDOW_SECONDS = 3600; // 1 hour permitted payment lifetime

const EIP712_DOMAIN_TYPE = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];

/** Signing is enabled only when explicitly turned on AND Circle credentials exist. */
export function signingEnabled(env) {
  const creds = getCredentials(env);
  return !!(env && env.X402_SIGNING_ENABLED === 'true' && creds.apiKey && creds.entitySecret);
}

export function maxAuthWindowSeconds(env) {
  const n = Number(env && env.X402_AUTH_WINDOW_SECONDS);
  return Number.isInteger(n) && n > 0 && n <= 86400 ? n : DEFAULT_MAX_AUTH_WINDOW_SECONDS;
}

/** Serialize typed data into Circle's expected `data` string (EIP-712 JSON). */
export function serializeTypedDataForCircle(typedData) {
  return JSON.stringify({
    types: {
      EIP712Domain: EIP712_DOMAIN_TYPE,
      TransferWithAuthorization: typedData.types.TransferWithAuthorization,
    },
    domain: typedData.domain,
    primaryType: 'TransferWithAuthorization',
    message: typedData.value,
  });
}

/**
 * Build the exact TransferWithAuthorization typed data for a validated intent.
 * `value` is the exact BigInt atomic-unit amount (decimal string, no Number).
 * `validAfter`/`validBefore` are trusted-server Unix seconds; `nonce` is the
 * reserved bytes32 authorization nonce.
 */
export function buildAuthorizationFromIntent(intent, nowSec, windowSeconds) {
  return buildTransferWithAuthorization({
    from: intent.walletAddress,
    to: intent.payTo,
    value: intent.amountAtomic,
    validAfter: String(nowSec),
    validBefore: String(nowSec + windowSeconds),
    nonce: intent.authorizationNonce,
  });
}

/**
 * Request a signature from Circle. Returns `{ ok, signature? , error? }`.
 * Mockable via globalThis.fetch in tests (Level 2). Fail-closed on any error.
 */
export async function signTransferWithAuthorizationViaCircle(env, walletId, typedData, memo) {
  const creds = getCredentials(env);
  if (!creds.apiKey || !creds.entitySecret) {
    return { ok: false, error: 'circle_not_configured' };
  }
  let entitySecretCiphertext;
  try {
    entitySecretCiphertext = await encryptEntitySecret(env);
  } catch (e) {
    return { ok: false, error: 'circle_ciphertext_failed', detail: (e && e.message) || 'unknown' };
  }

  let resp;
  try {
    resp = await fetch(W3S_BASE + '/developer/sign/typedData', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + creds.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletId,
        data: serializeTypedDataForCircle(typedData),
        entitySecretCiphertext,
        memo: memo || 'Elligentt x402 EIP-3009 authorization',
      }),
    });
  } catch (e) {
    return { ok: false, error: 'circle_unavailable', detail: (e && e.message) || 'network error' };
  }

  let data = null;
  try { data = await resp.json(); } catch (_) { data = null; }

  if (resp.status === 401) return { ok: false, error: 'circle_auth_failed' };
  if (resp.status === 403) return { ok: false, error: 'circle_forbidden' };
  if (resp.status === 404) return { ok: false, error: 'circle_wallet_not_found' };
  if (resp.status === 429) return { ok: false, error: 'circle_rate_limited' };
  if (resp.status >= 500) return { ok: false, error: 'circle_5xx', status: resp.status };
  if (!resp.ok) {
    return { ok: false, error: 'circle_signing_failed', detail: (data && (data.message || data.error)) || resp.status };
  }

  const signature = data && data.data && data.data.signature;
  if (typeof signature !== 'string' || !signature) {
    return { ok: false, error: 'circle_signature_missing' };
  }
  return { ok: true, signature };
}

/**
 * Full authorization orchestration: build typed data from the intent → sign via
 * Circle (if enabled) → verify locally → persist AUTHORIZED through the DO.
 *
 * Returns `{ ok, intent?, reason? }`. Never exposes the signature.
 */
export async function authorizeIntent(env, { intent, walletId, walletAddress, userId }) {
  if (intent.state !== 'AWAITING_AUTHORIZATION') {
    return { ok: false, reason: 'invalid_state', state: intent.state };
  }
  if (!intent.authorizationNonce) {
    return { ok: false, reason: 'nonce_not_reserved' };
  }
  if (String(intent.walletAddress).toLowerCase() !== String(walletAddress).toLowerCase()) {
    return { ok: false, reason: 'wallet_mismatch' };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const windowSeconds = maxAuthWindowSeconds(env);
  const typedData = buildAuthorizationFromIntent(intent, nowSec, windowSeconds);

  if (!signingEnabled(env)) {
    return { ok: false, reason: 'signing_disabled' };
  }

  const signed = await signTransferWithAuthorizationViaCircle(env, walletId, typedData);
  if (!signed.ok) {
    return { ok: false, reason: signed.error };
  }

  // Verify the returned signature locally against the EXACT terms.
  const verified = verifyTransferWithAuthorization(typedData, signed.signature, intent.walletAddress);
  if (!verified.ok) {
    return { ok: false, reason: verified.reason };
  }

  // Persist AUTHORIZED through the trusted internal DO transition.
  const res = await doAuthorize(env, walletAddress, userId, intent.intentId, intent.stateVersion, {
    from: typedData.value.from,
    to: typedData.value.to,
    value: typedData.value.value,
    validAfter: typedData.value.validAfter,
    validBefore: typedData.value.validBefore,
    nonce: typedData.value.nonce,
    signature: signed.signature,
  });

  if (!res.ok) {
    return { ok: false, reason: res.error };
  }
  return { ok: true, intent: res.body.intent };
}
