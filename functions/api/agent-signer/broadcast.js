/**
 * AUTONOMA-6C — POST /api/agent-signer/broadcast (HARDENED)
 * ═══════════════════════════════════════════════════════════════════════
 * The Circle signer no longer accepts a bare structured request. It requires a
 * server-issued, single-use, short-lived, request-bound authorization proof
 * (see /api/agent-signer/authorize + _proof.mjs). This endpoint CANNOT be used as
 * a public API that turns any HTTP request into a Circle wallet operation.
 *
 * Request body:
 *   {
 *     authorizationProof,   // required — HMAC proof issued by /authorize
 *     executionId,          // must match the proof
 *     chainId,              // must match the proof
 *     operation,            // must match the proof
 *     request               // structured request; must map to the exact
 *                           // contract+ABI+params bound in the proof
 *   }
 *
 * Enforcement order (all fail-closed):
 *   1. Circle configured            → else 503
 *   2. proof secret configured      → else 503
 *   3. proof present + signature    → else 401
 *   4. proof not expired            → else 401
 *   5. circuit breaker (circle)     → open → 503
 *   6. emergency pause              → paused → 503
 *   7. binding (executionId, chainId, operation, wallet, descriptor) → else 403
 *   8. proof single-use             → replay → 403
 *   9. rate limit                   → exceeded → 429
 *  10. idempotency (executionId)    → already submitted → idempotent response
 *  11. nonce lock                   → conflict → 409
 *  12. Circle sign+broadcast        → guarded by circuit breaker
 *
 * No secret ever leaves the server.
 */
import {
  isConfigured, getCredentials, json, err,
  mapStructuredRequest, createContractExecution, fetchNonce,
} from './_circle.js';
import { verifyProof, consumeProof, proofAvailable } from './_proof.mjs';
import { isPaused, getExecution, reserveNonce, recordExecution, audit, hashRequest } from './_execution.mjs';
import { check as breakerCheck, guard as breakerGuard } from '../core/circuit-breaker.mjs';
import { applyRateLimit } from '../core/rate-limit.mjs';
import { getFlags } from '../core/flags.mjs';

function sameAbiParams(a, b) {
  const aa = Array.isArray(a) ? a : [];
  const bb = Array.isArray(b) ? b : [];
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i++) {
    if (String(aa[i]) !== String(bb[i])) return false;
  }
  return true;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!isConfigured(env)) return err('Circle signer not configured', 503, env, request);
  if (!proofAvailable(env)) return err('Authorization proof secret not configured', 503, env, request);

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return err('Invalid JSON body', 400, env, request);
  }
  body = body || {};

  // ── 3/4. Proof signature + expiry ──
  const proofToken = body.authorizationProof;
  if (!proofToken || typeof proofToken !== 'string') {
    return err('Authorization proof required', 401, env, request);
  }
  const proof = await verifyProof(env, proofToken);
  if (!proof.ok) return err('Authorization proof invalid: ' + proof.reason, proof.status || 401, env, request);

  // ── 5. Circuit breaker (fail-closed BEFORE any work) ──
  if (getFlags(env).circuitBreaker !== false) {
    const cb = await breakerCheck(env, 'circle');
    if (!cb.allowed) return err('Circle execution blocked: circuit breaker open', 503, env, request);
  }

  // ── 6. Emergency pause ──
  const pause = await isPaused(env);
  if (pause.paused) return err('Circle execution paused', 503, env, request);

  // ── 7. Binding checks (proof ↔ request) ──
  const p = proof.payload;
  const chainId = body.chainId != null ? Number(body.chainId) : 5042002;
  const operation = (typeof body.operation === 'string') ? body.operation : '';
  const executionId = (typeof body.executionId === 'string') ? body.executionId : '';

  if (!executionId || executionId !== p.executionId) {
    return err('Authorization proof does not match this executionId', 403, env, request);
  }
  if (chainId !== Number(p.chainId)) {
    return err('Authorization proof does not match this chainId', 403, env, request);
  }
  if (operation !== p.operation) {
    return err('Authorization proof does not match this operation', 403, env, request);
  }

  const creds = getCredentials(env);
  const serverWallet = String(creds.walletAddress || '').toLowerCase();
  if (!serverWallet || p.walletAddress !== serverWallet) {
    return err('Authorization proof wallet does not match the Circle wallet', 403, env, request);
  }

  let descriptor;
  try {
    descriptor = mapStructuredRequest(body.request);
  } catch (e) {
    return err('Invalid structured request: ' + (e.message || e), 400, env, request);
  }
  if (descriptor.contractAddress !== p.contractAddress) {
    return err('Authorization proof contractAddress mismatch', 403, env, request);
  }
  if (descriptor.abiFunctionSignature !== p.abiFunctionSignature) {
    return err('Authorization proof abiFunctionSignature mismatch', 403, env, request);
  }
  if (!sameAbiParams(descriptor.abiParameters, p.abiParameters)) {
    return err('Authorization proof abiParameters mismatch', 403, env, request);
  }

  // ── 8. Single-use (replay protection) ──
  const consumed = await consumeProof(env, proof.proofId);
  if (!consumed.ok) return err('Authorization proof ' + consumed.reason, consumed.status || 403, env, request);

  // ── 9. Rate limit ──
  const flags = getFlags(env);
  const ip = (request.headers && request.headers.get && request.headers.get('CF-Connecting-IP')) || 'unknown';
  const rl = await applyRateLimit(env, {
    mode: flags.rateLimitMode,
    kind: 'execute',
    application: 'ELLIGENT',
    client: executionId,
    ip,
  });
  if (rl.blocked) return err('Rate limit exceeded', 429, env, request);

  // ── 10. Idempotency (executionId) ──
  const prior = await getExecution(env, executionId);
  if (prior && (prior.status === 'submitted' || prior.status === 'pending' || prior.status === 'succeeded')) {
    return json({
      ok: true,
      idempotent: true,
      txHash: prior.txHash || null,
      state: prior.circleState || null,
      id: prior.circleId || null,
      address: serverWallet,
    }, 200, env, request);
  }

  // ── 11. Nonce lock (server-side) ──
  let nonceHex;
  try {
    nonceHex = await fetchNonce(env, chainId, serverWallet);
  } catch (e) {
    return err('Nonce unavailable: ' + (e.message || e), 502, env, request);
  }
  const nonce = parseInt(nonceHex, 16);
  const lock = await reserveNonce(env, { walletAddress: serverWallet, chainId, nonce, executionId });
  if (!lock.ok) return err('Nonce conflict: ' + lock.reason, lock.status || 409, env, request);

  // ── 12. Circle sign + broadcast (guarded) ──
  const idempotencyKey = 'autonoma_' + executionId;
  const requestHash = await hashRequest(descriptor);
  let circleRes;
  try {
    circleRes = await breakerGuard(env, 'circle', () => createContractExecution(env, {
      idempotencyKey,
      contractAddress: descriptor.contractAddress,
      abiFunctionSignature: descriptor.abiFunctionSignature,
      abiParameters: descriptor.abiParameters,
      value: descriptor.value || null,
    }));
  } catch (e) {
    await recordExecution(env, {
      executionId, operation, chainId, walletAddress: serverWallet,
      contractAddress: descriptor.contractAddress, abiFunctionSignature: descriptor.abiFunctionSignature,
      destination: p.destination || null, amount: p.amount || null,
      nonce, idempotencyKey, status: 'failed', requestHash,
      error: (e && e.message ? e.message : String(e)).slice(0, 200),
    });
    await audit(env, {
      executionId, operation, chainId, walletAddress: serverWallet,
      contractAddress: descriptor.contractAddress, abiFunctionSignature: descriptor.abiFunctionSignature,
      destination: p.destination || null, amount: p.amount || null,
      nonce, idempotencyKey, requestHash, authorizationResult: 'ok', policyResult: 'n/a',
      circleStatus: 'error', finalStatus: 'failed', error: (e && e.message ? e.message : String(e)).slice(0, 200),
    });
    const isOpen = e && (e.circuitOpen || (e.message && String(e.message).indexOf('CIRCUIT_OPEN') === 0));
    return err(isOpen ? 'Circle execution blocked: circuit breaker open' : 'Broadcast failed: ' + (e.message || e), isOpen ? 503 : 502, env, request);
  }

  const tx = (circleRes && circleRes.data) ? circleRes.data : {};
  const txHash = tx.txHash || null;

  await recordExecution(env, {
    executionId, operation, chainId, walletAddress: serverWallet,
    contractAddress: descriptor.contractAddress, abiFunctionSignature: descriptor.abiFunctionSignature,
    destination: p.destination || null, amount: p.amount || null,
    nonce, idempotencyKey, status: txHash ? 'submitted' : 'pending', requestHash,
    txHash, circleState: tx.state || null, circleId: tx.id || null,
  });
  await audit(env, {
    executionId, operation, chainId, walletAddress: serverWallet,
    contractAddress: descriptor.contractAddress, abiFunctionSignature: descriptor.abiFunctionSignature,
    destination: p.destination || null, amount: p.amount || null,
    nonce, idempotencyKey, requestHash, authorizationResult: 'ok', policyResult: 'n/a',
    circleStatus: tx.state || 'submitted', txHash: txHash || null, finalStatus: 'submitted',
  });

  return json({
    ok: true,
    txHash,
    state: tx.state || null,
    id: tx.id || null,
    address: serverWallet,
  }, 200, env, request);
}
