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

// Resolve the effective Circle credentials for an authenticated session.
// Looks up the user's per-user wallet from AUTH_KV; falls back to global env.
async function resolveCredentials(env, session) {
  const base = getCredentials(env);
  const KV = env && env.AUTH_KV;
  if (!KV || !session || !session.email) return base;

  try {
    const raw = await KV.get('user:' + session.email);
    if (!raw) return base;
    const user = JSON.parse(raw);
    return getUserCredentials(env, user);
  } catch (_) {
    return base;
  }
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

  const proof = await issueProof(env, {
    executionId,
    userId: session.userId || session.email || null,
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
