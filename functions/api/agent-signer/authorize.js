/**
 * AUTONOMA-6C — POST /api/agent-signer/authorize
 * ═══════════════════════════════════════════════════════════════════════
 * Issues a short-lived, single-use, request-bound authorization proof that
 * /api/agent-signer/broadcast requires before it will touch the Circle wallet.
 *
 * Per-user wallet: reads the session from AUTH_KV and uses the user's own
 * circleWalletId/circleWalletAddress if present; falls back to global env
 * secrets (CIRCLE_WALLET_ID / CIRCLE_WALLET_ADDRESS) for users without a
 * per-user wallet yet.
 *
 * FAIL-CLOSED: no valid session → 401; misconfigured → 503.
 */
import { isConfigured, getCredentials, getUserCredentials, json, err, mapStructuredRequest, CHAIN_RPC } from './_circle.js';
import { issueProof, proofAvailable } from './_proof.mjs';
import { verifySession } from './_session.mjs';
import { hmacSha256Hex, timingSafeEqualHex } from '../core/application-secret.mjs';

// Resolve the effective Circle credentials for an authenticated session.
// When user has a personal Circle wallet, ALWAYS use it — never fall back
// to platform wallet for a user who has their own wallet provisioned.
async function resolveCredentials(env, session) {
  const KV = env && env.AUTH_KV;
  if (!KV || !session || !session.email) return getCredentials(env);

  try {
    const raw = await KV.get('user:' + session.email);
    if (!raw) return getCredentials(env);
    const user = JSON.parse(raw);
    const userCreds = getUserCredentials(env, user);
    // Use per-user wallet when provisioned; fail-closed (return null) when
    // the user exists in KV but has no personal wallet yet (needsProvision).
    if (userCreds && userCreds.walletAddress && userCreds.isPerUser !== false) {
      return userCreds;
    }
    // User in KV but no personal wallet — return null so caller returns 403/needsProvision
    if (user && (user.circleNeedsProvision || !user.circleWalletAddress)) {
      return null;
    }
    return getCredentials(env);
  } catch (_) {
    return getCredentials(env);
  }
}

// ── OTP execToken verification (AUTONOMA-6C) ────────────────────────────────
// The execToken is issued by /api/agent/exec-otp after a successful email OTP.
// It is an HMAC-SHA256 (AUTH_SECRET), base64-encoded claim binding the user,
// Circle wallet, operation, amount, asset and destination. It is re-verified
// server-side here so a confirmation cannot be forged, tampered with, or replayed
// against a different operation. Absence of an execToken is permitted (scheduled
// execution and other non-OTP flows rely on the session only).
const ADDR_TO_ASSET = {
  '0x3600000000000000000000000000000000000000': 'USDC',
  '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1': 'EURC',
  '0x171a4217b86a807a64eb94757db6849fb4bdbaa0': 'CIRBTC',
};

function amountMatches(a, b) {
  if (a == null || b == null) return false;
  const sa = String(a).trim();
  const sb = String(b).trim();
  if (sa === sb) return true;
  const na = Number(sa);
  const nb = Number(sb);
  return Number.isFinite(na) && Number.isFinite(nb) && na === nb;
}

async function verifyExecToken(env, body, session, creds) {
  const secret = env && env.AUTH_SECRET;
  if (!secret || typeof secret !== 'string' || secret.length < 16) {
    return { ok: false, reason: 'auth_secret_unconfigured', status: 503 };
  }
  const token = body && typeof body.execToken === 'string' ? body.execToken : null;
  if (!token) return { ok: false, reason: 'missing_exec_token', status: 403 };

  let parsed;
  try {
    const jsonStr = atob(token);
    parsed = JSON.parse(jsonStr);
  } catch (_) {
    return { ok: false, reason: 'malformed_exec_token', status: 403 };
  }
  if (!parsed || typeof parsed.payload !== 'string' || typeof parsed.sig !== 'string') {
    return { ok: false, reason: 'malformed_exec_token', status: 403 };
  }

  const expected = await hmacSha256Hex(secret, parsed.payload);
  if (!timingSafeEqualHex(expected, parsed.sig)) {
    return { ok: false, reason: 'exec_token_signature_invalid', status: 403 };
  }

  const parts = parsed.payload.split(':');
  if (parts.length < 8) return { ok: false, reason: 'exec_token_payload_invalid', status: 403 };
  const claim = {
    userId: parts[0],
    intentId: parts[1],
    circleWalletId: parts[2],
    operation: parts[3],
    amount: parts[4],
    asset: parts[5],
    destination: parts[6],
    expiresAt: Number(parts[7]),
  };

  if (!Number.isFinite(claim.expiresAt) || Date.now() > claim.expiresAt) {
    return { ok: false, reason: 'exec_token_expired', status: 403 };
  }

  // Bind user: the claim must belong to the authenticated session.
  const sessionUser = session && (session.userId || session.email);
  if (!sessionUser || (claim.userId !== session.userId && claim.userId !== session.email)) {
    return { ok: false, reason: 'exec_token_user_mismatch', status: 403 };
  }

  // Bind operation.
  if (body && body.operation && claim.operation && body.operation !== claim.operation) {
    return { ok: false, reason: 'exec_token_operation_mismatch', status: 403 };
  }

  // Bind amount.
  if (body && body.amount != null && claim.amount != null && !amountMatches(body.amount, claim.amount)) {
    return { ok: false, reason: 'exec_token_amount_mismatch', status: 403 };
  }

  // Bind destination.
  if (body && body.destination != null && claim.destination != null) {
    if (String(body.destination).toLowerCase() !== String(claim.destination).toLowerCase()) {
      return { ok: false, reason: 'exec_token_destination_mismatch', status: 403 };
    }
  }

  // Bind Circle wallet (per-user). Enforced when the claim carried a wallet id.
  if (claim.circleWalletId && creds && creds.walletId) {
    if (String(claim.circleWalletId).toLowerCase() !== String(creds.walletId).toLowerCase()) {
      return { ok: false, reason: 'exec_token_wallet_mismatch', status: 403 };
    }
  }

  // Bind asset (only for direct ERC-20 transfers, where the token is unambiguous).
  const req = body && body.request;
  if (req && (req.type === 'transfer' || req.type === 'send') && claim.asset) {
    const assetFromToken = ADDR_TO_ASSET[String(req.tokenAddress || '').toLowerCase()];
    if (assetFromToken && assetFromToken !== String(claim.asset).toUpperCase()) {
      return { ok: false, reason: 'exec_token_asset_mismatch', status: 403 };
    }
  }

  return { ok: true, claim };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!isConfigured(env)) return err('Circle signer not configured', 503, env, request);
  if (!proofAvailable(env)) return err('Authorization proof secret not configured', 503, env, request);

  const session = await verifySession(env, request);
  if (!session.ok) return err('Unauthorized: ' + session.reason, session.status || 401, env, request);

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return err('Invalid JSON body', 400, env, request);
  }

  const executionId = body && typeof body.executionId === 'string' ? body.executionId : '';
  if (!executionId || executionId.length < 8) {
    return err('executionId is required (min 8 chars)', 400, env, request);
  }

  const chainId = body.chainId != null ? Number(body.chainId) : 5042;
  if (!CHAIN_RPC[chainId]) return err('Unsupported chain ' + chainId, 400, env, request);

  const operation = (body && typeof body.operation === 'string' && body.operation) ? body.operation : '';
  if (!operation) return err('operation is required', 400, env, request);

  let descriptor;
  try {
    descriptor = mapStructuredRequest(body && body.request);
  } catch (e) {
    return err('Invalid structured request: ' + (e.message || e), 400, env, request);
  }

  // Resolve per-user or global credentials
  const creds = await resolveCredentials(env, session);
  if (!creds) {
    return err('Circle wallet not provisioned for this user — create your AI wallet first', 403, env, request);
  }

  // OTP execToken verification — when present, validate + bind before issuing proof.
  if (body && typeof body.execToken === 'string' && body.execToken) {
    const otpCheck = await verifyExecToken(env, body, session, creds);
    if (!otpCheck.ok) {
      return err('OTP authorization invalid: ' + otpCheck.reason, otpCheck.status || 403, env, request);
    }
  }

  const proof = await issueProof(env, {
    executionId,
    // Store email as userId so broadcast.js can look up user:email in KV.
    // session.userId is a UUID — not a valid KV key for user records.
    userId: session.email || session.userId || null,
    chainId,
    operation,
    walletId: creds.walletId,
    walletAddress: String(creds.walletAddress || '').toLowerCase(),
    contractAddress: descriptor.contractAddress,
    abiFunctionSignature: descriptor.abiFunctionSignature,
    abiParameters: descriptor.abiParameters,
    destination: (body && typeof body.destination === 'string' && body.destination) ? body.destination.toLowerCase() : null,
    amount: (body && body.amount != null) ? String(body.amount) : null,
  });

  if (!proof.ok) return err('Could not issue authorization proof: ' + proof.reason, 503, env, request);

  return json({
    ok: true,
    authorizationProof: proof.token,
    expiresAt: proof.expiresAt,
    chainId,
    walletAddress: String(creds.walletAddress || '').toLowerCase(),
    walletId: creds.walletId,
    operation,
  }, 200, env, request);
}
