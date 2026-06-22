import { ethers } from 'ethers';
import { RELAYER_CONFIG } from './shared-config.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// AUTHORIZATION FLOW MATRIX (both coexist; legacy is NOT removed in this commit)
//
//   LEGACY (personal_sign):
//     signMessage(prefix+ts+nonce) -> relayer/mint
//     - proves wallet ownership + timestamp window + per-user nonce replay guard
//     - binding to userAddress is enforced by the callers (recovered === userAddress)
//     - NO cryptographic binding of intentId/amounts to the signature
//
//   EIP-712 (signTypedData, opt-in via auth.scheme='eip712' or RELAYER_EIP712_ENABLED):
//     signTypedData(Authorization{user,intentId,grossAmount,feeAmount,nonce,deadline})
//     - full binding: signature covers user + intent + amounts + nonce + deadline
//     - deadline window + per-user nonce replay guard
//
//   MIXED MODE: a request is verified as EIP-712 only when it opts in; otherwise it
//   is verified as legacy. The allowlist (RELAYER_ALLOWED_USERS) and replay guard
//   apply to both. Default production posture is legacy unless EIP-712 is enabled.
// ─────────────────────────────────────────────────────────────────────────────

const AUTH_WINDOW_MS = 300000;
const NONCE_TTL_SECONDS = 600;

// SECURITY: EIP-712 authorization scheme (additive / opt-in).
// It binds the signature to user + intent + amounts + nonce + deadline.
// It is used ONLY when the request explicitly opts in (auth.scheme === 'eip712')
// or env.RELAYER_EIP712_ENABLED === 'true' AND the auth carries EIP-712 fields.
// The legacy personal_sign scheme remains the default so the current frontend
// (which signs a prefixed message via signMessage) keeps working unchanged.
const EIP712_DOMAIN = {
  name: 'Elligentt',
  version: '1',
  chainId: RELAYER_CONFIG.ARC_CHAIN_ID,
};

const EIP712_TYPES = {
  Authorization: [
    { name: 'user', type: 'address' },
    { name: 'intentId', type: 'bytes32' },
    { name: 'grossAmount', type: 'uint256' },
    { name: 'feeAmount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

// SECURITY: real allowlist of authorized signers.
// Enforced ONLY when env.RELAYER_ALLOWED_USERS is configured (comma-separated
// addresses). When empty/unset the gate is skipped to preserve current behavior.
function parseAllowlist(env) {
  const raw = (env && env.RELAYER_ALLOWED_USERS) || '';
  return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

// SECURITY: production must define RELAYER_ALLOWED_USERS. Returns an error
// message when misconfigured (NODE_ENV=production + empty allowlist), else null.
// Dev/test (no NODE_ENV or != production) keep the current permissive behavior.
export function relayerConfigError(env) {
  const isProd = env && env.NODE_ENV === 'production';
  if (!isProd) return null;
  if (parseAllowlist(env).length === 0) return 'Relayer authorization configuration missing';
  return null;
}

// SECURITY: per-user anti-replay. Key format relayer_nonce:{user}:{nonce}.
// Stored value records { used:true, timestamp } with a short TTL.
async function checkAndStoreNonce(kv, recovered, nonce) {
  if (!kv || typeof nonce !== 'string' || nonce.length === 0) return { ok: true };
  const nonceKey = 'relayer_nonce:' + recovered.toLowerCase() + ':' + nonce;
  try {
    const used = await kv.get(nonceKey);
    if (used) return { ok: false };
    await kv.put(nonceKey, JSON.stringify({ used: true, timestamp: Date.now() }), { expirationTtl: NONCE_TTL_SECONDS });
  } catch (_) {}
  return { ok: true };
}

async function verifyEip712(body, kv, allowlist) {
  const { auth } = body;
  const { user, intentId, grossAmount, feeAmount, nonce, deadline, signature } = auth;

  if (!user || typeof user !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(user)) {
    return { valid: false, error: 'Invalid user address', reason: 'invalid_user' };
  }
  if (typeof intentId !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(intentId)) {
    return { valid: false, error: 'Invalid intentId', reason: 'invalid_intent' };
  }
  if (!signature || typeof signature !== 'string') {
    return { valid: false, error: 'Missing signature', reason: 'missing_signature' };
  }
  if (typeof deadline !== 'number' || !Number.isFinite(deadline)) {
    return { valid: false, error: 'Invalid deadline', reason: 'invalid_deadline' };
  }

  // SECURITY: deadline must be in the future and at most AUTH_WINDOW_MS ahead.
  const now = Date.now();
  if (deadline <= now) return { valid: false, error: 'Authorization expired (deadline passed)', reason: 'deadline_expired' };
  if (deadline > now + AUTH_WINDOW_MS) return { valid: false, error: 'Deadline too far in the future', reason: 'deadline_too_far' };

  let value;
  try {
    value = {
      user,
      intentId,
      grossAmount: BigInt(grossAmount ?? 0),
      feeAmount: BigInt(feeAmount ?? 0),
      nonce: BigInt(nonce ?? 0),
      deadline: BigInt(deadline),
    };
  } catch (_) {
    return { valid: false, error: 'Invalid numeric fields', reason: 'invalid_fields' };
  }

  let recovered;
  try {
    recovered = ethers.verifyTypedData(EIP712_DOMAIN, EIP712_TYPES, value, signature);
  } catch (e) {
    return { valid: false, error: 'Signature verification failed: ' + (e.message || ''), reason: 'invalid_signature' };
  }
  if (recovered.toLowerCase() !== user.toLowerCase()) {
    return { valid: false, error: 'Signature does not match user', reason: 'address_mismatch' };
  }

  // SECURITY: bind the signed intentId to the request body when present.
  if (body.intentBytes32 && String(body.intentBytes32).toLowerCase() !== intentId.toLowerCase()) {
    return { valid: false, error: 'intentId does not match request', reason: 'intent_mismatch' };
  }

  if (allowlist.length > 0 && !allowlist.includes(recovered.toLowerCase())) {
    return { valid: false, error: 'User not authorized', reason: 'not_authorized' };
  }

  const replay = await checkAndStoreNonce(kv, recovered, String(nonce));
  if (!replay.ok) return { valid: false, error: 'Nonce already used (replay attack)', reason: 'invalid_nonce' };

  return { valid: true, address: recovered, scheme: 'eip712' };
}

// Legacy personal_sign scheme — preserved for backward compatibility with the
// current frontend. Behavior is unchanged except for the added (opt-in) allowlist
// gate and the per-user replay key.
async function verifyLegacy(body, kv, allowlist) {
  const { auth } = body;
  const { address, message, signature, timestamp, nonce } = auth;

  if (!address || !message || !signature || !timestamp || !nonce) {
    return { valid: false, error: 'Incomplete auth: address, message, signature, timestamp, nonce required', reason: 'incomplete_auth' };
  }

  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return { valid: false, error: 'Invalid address format', reason: 'invalid_address' };
  }

  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return { valid: false, error: 'Invalid timestamp', reason: 'invalid_timestamp' };
  }

  const now = Date.now();
  const diff = Math.abs(now - timestamp);
  if (diff > AUTH_WINDOW_MS) {
    return { valid: false, error: 'Timestamp expired (max ' + (AUTH_WINDOW_MS / 1000) + 's)', reason: 'expired' };
  }

  const expectedPrefix = 'Elligentt Relayer Authorization';
  if (typeof message !== 'string' || !message.startsWith(expectedPrefix)) {
    return { valid: false, error: 'Invalid message format', reason: 'invalid_message' };
  }

  let recovered;
  try {
    recovered = ethers.verifyMessage(message, signature);
  } catch (e) {
    return { valid: false, error: 'Signature verification failed: ' + (e.message || ''), reason: 'invalid_signature' };
  }

  if (recovered.toLowerCase() !== address.toLowerCase()) {
    return { valid: false, error: 'Signature does not match address', reason: 'address_mismatch' };
  }

  // SECURITY: optional allowlist gate (no-op unless RELAYER_ALLOWED_USERS is set).
  if (allowlist.length > 0 && !allowlist.includes(recovered.toLowerCase())) {
    return { valid: false, error: 'User not authorized', reason: 'not_authorized' };
  }

  // SECURITY: per-user anti-replay.
  if (kv && typeof nonce === 'string' && nonce.length > 0) {
    const replay = await checkAndStoreNonce(kv, recovered, nonce);
    if (!replay.ok) {
      return { valid: false, error: 'Nonce already used (replay attack)', reason: 'invalid_nonce' };
    }
  }

  return { valid: true, address: recovered, scheme: 'legacy' };
}

export async function verifyRelayerAuth(body, kv, env) {
  const { auth } = body || {};
  if (!auth || typeof auth !== 'object') {
    return { valid: false, error: 'Missing auth object', reason: 'missing_auth' };
  }

  const allowlist = parseAllowlist(env);

  // Route to EIP-712 only when explicitly opted in — never auto-upgrade a
  // legacy (personal_sign) request, so existing clients are unaffected.
  const optInEip712 = auth.scheme === 'eip712'
    || (env && env.RELAYER_EIP712_ENABLED === 'true' && auth.user && auth.signature && auth.deadline != null);

  if (optInEip712) {
    return verifyEip712(body, kv, allowlist);
  }

  return verifyLegacy(body, kv, allowlist);
}
