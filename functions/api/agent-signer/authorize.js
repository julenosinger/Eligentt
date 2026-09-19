/**
 * AUTONOMA-6C — POST /api/agent-signer/authorize
 * ═══════════════════════════════════════════════════════════════════════
 * Issues a short-lived, single-use, request-bound authorization proof that
 * /api/agent-signer/broadcast requires before it will touch the Circle wallet.
 *
 * This endpoint does NOT re-authorize the business operation (the Autonoma
 * AutonomaExecutionGate / AgentAuthorization / PolicyEngine chain remains the
 * authority, client-side, unchanged). It only proves, server-side, that the
 * caller is an authenticated session (reusing AUTH_KV) and binds the exact
 * structured request so the signer can only execute what was authorized.
 *
 * Body:
 *   {
 *     executionId,          // required — the Autonoma execution identity
 *     chainId,              // default 5042002
 *     operation,            // e.g. 'payment' | 'bridge' | 'swap' | 'multisend'
 *     request,              // structured request (see _circle.mapStructuredRequest)
 *     amount,               // optional (audit binding)
 *     destination           // optional (audit binding)
 *   }
 *
 * FAIL-CLOSED: no valid session → 401; misconfigured → 503.
 */
import { isConfigured, getCredentials, json, err, mapStructuredRequest, CHAIN_RPC } from './_circle.js';
import { issueProof, proofAvailable } from './_proof.mjs';
import { verifySession } from './_session.mjs';

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

  const chainId = body.chainId != null ? Number(body.chainId) : 5042002;
  if (!CHAIN_RPC[chainId]) return err('Unsupported chain ' + chainId, 400, env, request);

  const operation = (body && typeof body.operation === 'string' && body.operation) ? body.operation : '';
  if (!operation) return err('operation is required', 400, env, request);

  let descriptor;
  try {
    descriptor = mapStructuredRequest(body && body.request);
  } catch (e) {
    return err('Invalid structured request: ' + (e.message || e), 400, env, request);
  }

  const creds = getCredentials(env);

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
