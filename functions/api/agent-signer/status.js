/**
 * ARC-STUDIO — POST /api/agent-signer/status
 * ═══════════════════════════════════════════════════════════════════════
 * Reconciles a Circle operation to its EVM transaction hash + on-chain receipt.
 *
 * The Circle contractExecution response may carry an operation UUID (`id`)
 * BEFORE the EVM txHash is available. This endpoint is the ONLY place the
 * client may poll for the eventual txHash — it never returns the Circle UUID
 * as a transaction hash.
 *
 * Status values:
 *   pending   — Circle operation accepted, EVM hash not yet available
 *   submitted — EVM hash available, receipt not yet mined
 *   confirmed — receipt present with status 1 (on-chain success)
 *   failed    — receipt status 0 (on-chain revert) OR Circle state FAILED
 *   unknown   — no execution record for the given executionId
 *
 * FAIL-CLOSED: no valid session → 401; wallet mismatch → 404.
 */
import { json, err, getTransaction, getReceipt, getCredentials, getUserCredentials } from './_circle.js';
import { verifySession } from './_session.mjs';
import { getExecution, recordExecution } from './_execution.mjs';

function isEVMHash(s) {
  return typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s);
}

async function resolveWallet(env, session) {
  const base = getCredentials(env);
  const KV = env && env.AUTH_KV;
  if (KV && session && session.email) {
    try {
      const raw = await KV.get('user:' + session.email);
      if (raw) {
        const user = JSON.parse(raw);
        const uc = getUserCredentials(env, user);
        if (uc && uc.walletAddress) return String(uc.walletAddress).toLowerCase();
      }
    } catch (_) { /* fall through */ }
  }
  return base.walletAddress ? String(base.walletAddress).toLowerCase() : '';
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const session = await verifySession(env, request);
  if (!session.ok) return err('Unauthorized', session.status || 401, env, request);

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return err('Invalid JSON body', 400, env, request);
  }
  const executionId = body && typeof body.executionId === 'string' ? body.executionId : '';
  if (!executionId) return err('executionId is required', 400, env, request);

  const prior = await getExecution(env, executionId);
  if (!prior) {
    return json({ ok: true, status: 'unknown', txHash: null, circleOperationId: null, state: null }, 200, env, request);
  }

  // Read-only surface still enforces per-user ownership: the execution record
  // must belong to the authenticated wallet.
  const userWallet = await resolveWallet(env, session);
  if (userWallet && prior.walletAddress && String(prior.walletAddress).toLowerCase() !== userWallet) {
    return err('Not found', 404, env, request);
  }

  let txHash = isEVMHash(prior.txHash) ? prior.txHash : null;
  const circleId = prior.circleId || null;
  let circleState = prior.circleState || null;
  const chainId = Number(prior.chainId) || 5042;

  // Reconcile with Circle when we only have an operation id (no EVM hash yet).
  if (!txHash && circleId) {
    try {
      const t = await getTransaction(env, circleId);
      const d = (t && t.data) || t || {};
      circleState = d.state || circleState;
      if (isEVMHash(d.txHash)) {
        txHash = d.txHash;
        await recordExecution(env, Object.assign({}, prior, { txHash, circleState, circleId, status: 'submitted' }));
      }
    } catch (_) { /* transient Circle error — keep current state */ }
  }

  if (!txHash) {
    const failed = circleState && String(circleState).toUpperCase().indexOf('FAIL') !== -1;
    return json({
      ok: true,
      status: failed ? 'failed' : 'pending',
      txHash: null,
      circleOperationId: circleId,
      state: circleState,
    }, 200, env, request);
  }

  let receipt = null;
  try { receipt = await getReceipt(chainId, txHash); } catch (_) { /* RPC transient — treat as not-yet-mined */ }

  if (receipt) {
    const ok = receipt.status === '0x1' || receipt.status === 1;
    return json({
      ok: true,
      status: ok ? 'confirmed' : 'failed',
      txHash,
      circleOperationId: circleId,
      state: circleState,
      blockNumber: receipt.blockNumber || null,
    }, 200, env, request);
  }

  return json({
    ok: true,
    status: 'submitted',
    txHash,
    circleOperationId: circleId,
    state: circleState,
  }, 200, env, request);
}
