/**
 * GET /api/core/v1/intents/{intentId} — Intent Status (Treasury Core API, Phase 2)
 * ════════════════════════════════════════════════════════════════════════════════
 * Returns the real, stored state of a Core intent: application/client, status,
 * timeline, settlement/reimbursement/bridge markers, vault/treasury attribution,
 * transaction hashes, explorer links and timestamps.
 */
import { runCore, corePreflight } from '../../../core/pipeline.mjs';
import { CoreError } from '../../../core/response.mjs';
import { loadIntent, explorerTx, INTENT_STATUS } from '../../../core/intent-service.mjs';
import { RELAYER_CONFIG } from '../../../shared-config.mjs';
import { scheduleSettlement } from '../../../core/settlement.mjs';

const BURN_TX_RE = /^0x[0-9a-fA-F]{64}$/;

export const onRequestOptions = corePreflight;

function buildStatusView(rec) {
  const hashes = rec.txHashes || {};
  const explorer = {};
  for (const [k, v] of Object.entries(hashes)) explorer[k] = explorerTx(v);
  return {
    intentId: rec.intentId,
    application: rec.application || 'ELLIGENT',
    client: rec.client || 'default',
    version: rec.version || '1',
    status: rec.status,
    asset: rec.asset,
    amount: rec.amount,
    bridge: {
      type: rec.bridge || null,
      sourceChain: rec.sourceChain,
      destChain: rec.destChain,
      provider: (rec.quote && rec.quote.provider) || 'Circle CCTP',
    },
    treasury: {
      vault: RELAYER_CONFIG.TREASURY_VAULT,
      grossAmount: rec.grossAmount,
      feeAmount: rec.feeAmount,
      netAmount: rec.netAmount,
    },
    vault: {
      address: RELAYER_CONFIG.TREASURY_VAULT,
      debited: !!rec.fulfilledAt,
      reimbursed: !!rec.settledAt,
    },
    settlement: {
      status: rec.settledAt ? 'settled' : (rec.fulfilledAt ? 'pending' : 'not_started'),
      settledAt: rec.settledAt || null,
      state: (rec.settlement && rec.settlement.state) || null,
      attempts: (rec.settlement && rec.settlement.attempts) || 0,
      lastCheckedAt: (rec.settlement && rec.settlement.lastCheckedAt) || null,
      attestationAt: rec.attestationAt || null,
    },
    reimbursement: {
      status: rec.settledAt ? 'reimbursed' : 'pending',
      txHash: hashes.mint || hashes.settlement || null,
    },
    transactionHashes: hashes,
    explorerLinks: explorer,
    timeline: rec.timeline || [],
    timestamps: {
      createdAt: rec.createdAt || null,
      updatedAt: rec.updatedAt || null,
      fulfilledAt: rec.fulfilledAt || null,
      settledAt: rec.settledAt || null,
    },
    correlationId: rec.correlationId || null,
  };
}

export function onRequestGet(context) {
  return runCore(context, {
    method: 'GET',
    endpoint: '/api/core/v1/intents/:intentId',
    rateKind: 'request',
    permission: 'intents:read',
  }, async (ctx) => {
    const id = ctx.params && ctx.params.intentId;
    if (!id) throw new CoreError('INVALID_INTENT', 'intentId is required', 400);
    const rec = await loadIntent(ctx.env, id);
    if (!rec) throw new CoreError('INTENT_NOT_FOUND', 'Intent not found: ' + id, 404);

    // Self-heal / resume: the settlement pipeline is single-shot per request
    // (Cloudflare terminates long waitUntil tasks). So every status poll advances
    // reimbursement one step until the Vault is reimbursed. Non-blocking and
    // non-destructive: the intent stays FULFILLED (user already paid) until the
    // reimbursement is CONFIRMED, then flips to SETTLED.
    const alreadyReimbursed = !!rec.settledAt ||
      rec.status === INTENT_STATUS.SETTLED ||
      (rec.settlement && rec.settlement.state === 'reimbursed');
    const burnTxHash = (rec.txHashes && (rec.txHashes.burn || rec.txHashes.deposit)) || rec.burnTxHash;
    const resumable = (rec.status === INTENT_STATUS.FULFILLED ||
      rec.status === INTENT_STATUS.SETTLING || rec.status === INTENT_STATUS.SETTLED) &&
      !alreadyReimbursed && BURN_TX_RE.test(String(burnTxHash || ''));
    if (resumable) {
      scheduleSettlement(ctx.execution || { env: ctx.env, waitUntil: ctx.waitUntil }, id, {});
    }

    return { data: buildStatusView(rec) };
  });
}
