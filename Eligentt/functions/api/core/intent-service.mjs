/**
 * Treasury Core API — Intent Service (Phase 2)
 * ═════════════════════════════════════════════
 * Shared helpers for the Core intent lifecycle: id generation, record shape,
 * timeline and quote attachment. This is REGISTRATION/bookkeeping only — it does
 * NOT execute the bridge (that stays in the existing Treasury Engine, invoked by
 * the execute endpoint which delegates to /api/relayer).
 */
import { ethers } from 'ethers';
import { RELAYER_CONFIG } from '../shared-config.mjs';
import { getQuote } from './quote-engine.mjs';
import { saveIntent, getStoredIntent } from './store.mjs';

export const INTENT_STATUS = Object.freeze({
  CREATED: 'Created',
  EXECUTING: 'Executing',
  FULFILLED: 'Fulfilled',
  SETTLING: 'Settling',
  SETTLED: 'Settled',
  FAILED: 'Failed',
});

export function generateIntentId() {
  let rand;
  try {
    rand = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('');
  } catch (_) {
    rand = Math.random().toString(16).slice(2, 10);
  }
  return 'INT-' + Date.now().toString(36).toUpperCase() + '-' + rand.toUpperCase();
}

export function intentBytes32(id) {
  try { return ethers.id(id); } catch (_) { return null; }
}

export function explorerTx(hash) {
  if (!hash) return null;
  const base = (RELAYER_CONFIG.CCTP_DOMAINS?.[String(RELAYER_CONFIG.ARC_CHAIN_ID)]?.explorer) || 'https://testnet.arcscan.app';
  return base.replace(/\/$/, '') + '/tx/' + hash;
}

export function addTimeline(record, event, extra) {
  if (!record.timeline) record.timeline = [];
  record.timeline.push({ event, timestamp: Date.now(), ...(extra || {}) });
  record.updatedAt = Date.now();
  return record;
}

/**
 * Build a fresh Core intent record from a validated create request + context.
 */
export function buildIntentRecord(ctx, value) {
  const id = generateIntentId();
  const quote = getQuote({ token: value.asset, amount: value.amount, sourceChain: value.sourceChain, destChain: value.destChain });
  const feeAmount = quote.fee;
  const grossAmount = value.amount;
  const now = Date.now();
  const record = {
    intentId: id,
    intentBytes32: intentBytes32(id),
    application: ctx.application,
    client: ctx.client,
    version: (ctx.appContext && ctx.appContext.version) || '1',
    environment: (ctx.appContext && ctx.appContext.environment) || 'production',
    origin: (ctx.appContext && ctx.appContext.origin) || null,
    correlationId: ctx.correlationId,
    asset: value.asset,
    amount: value.amount,
    grossAmount,
    feeAmount,
    netAmount: quote.receive,
    wallet: value.wallet,
    sourceChain: value.sourceChain,
    destChain: value.destChain,
    sourceDomain: (value.sourceDomain != null) ? value.sourceDomain : null,
    reference: value.reference || null,
    bridge: quote.bridge,
    status: INTENT_STATUS.CREATED,
    quote,
    txHashes: (value.burnTxHash ? { burn: value.burnTxHash } : {}),
    createdAt: now,
    updatedAt: now,
    fulfilledAt: null,
    settledAt: null,
    timeline: [{ event: 'intent_created', timestamp: now }],
  };
  return record;
}

export async function persistIntent(env, record) {
  await saveIntent(env, record);
  return record;
}

export async function loadIntent(env, id) {
  return getStoredIntent(env, id);
}
