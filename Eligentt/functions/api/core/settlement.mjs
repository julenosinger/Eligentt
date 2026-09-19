/**
 * Treasury Core API — Server-Side Settlement Orchestrator (Turbo Bridge)
 * ═════════════════════════════════════════════════════════════════════
 * This is the SHARED continuation of the Turbo Bridge pipeline that, until now,
 * only ran in the Elligent browser (public/index.html → FulfillerEngine +
 * _startSettlementPoller). Any application that drives the bridge purely
 * server-to-server (e.g. EXECDAAT) never executed that client JS, so its
 * operations stopped right after the Fulfill step — no attestation polling, no
 * reimbursement, no SETTLEMENT/VAULT_CREDIT ledger events.
 *
 * This module replicates that EXACT flow on the server so EVERY application —
 * Elligent, ExecDaat and future ones — shares one pipeline. It changes NOTHING in
 * the Smart Contracts, Vault, Treasury, Circle or the Reimbursement executor: it
 * only ORCHESTRATES the existing pieces:
 *
 *   1. Resolve the CCTP source domain from the intent.
 *   2. Poll the Circle Iris attestation API (same endpoint the frontend polls).
 *   3. Delegate the on-chain reimbursement to the EXISTING /api/relayer/mint
 *      endpoint (MessageTransmitter.receiveMessage → USDC minted back to Vault).
 *   4. Record the Ledger SETTLEMENT + VAULT_CREDIT stages and advance the intent
 *      to SETTLED with explorer links + timeline entries.
 *
 * It is best-effort and NEVER throws into the caller's hot path. It is meant to
 * run in the background via context.waitUntil(...) after the Fulfill succeeds.
 */
import { RELAYER_CONFIG } from '../shared-config.mjs';
import { recordLedgerEntry, LEDGER_STAGES, LEDGER_STATUS } from '../ledger.mjs';
import { ledgerKv } from './store.mjs';
import { loadIntent, persistIntent, addTimeline, INTENT_STATUS } from './intent-service.mjs';
import { onRequest as mintOnRequest } from '../relayer/mint.js';

const IRIS_BASE = 'https://iris-api-sandbox.circle.com';

// Map chainId → CCTP source domain, mirroring RELAYER_CONFIG.CCTP_DOMAINS and the
// frontend's DOMAIN_LOOKUP. Used to resolve the Iris polling domain.
const NAME_TO_DOMAIN = (() => {
  const out = {};
  for (const [chainId, meta] of Object.entries(RELAYER_CONFIG.CCTP_DOMAINS || {})) {
    if (meta && meta.domain != null) {
      out[String(chainId)] = meta.domain;
      if (meta.name) out[meta.name.toLowerCase()] = meta.domain;
    }
  }
  return out;
})();

// Same substring lookup the frontend recovery uses, so symbolic chain names still
// resolve a domain when only a human name was provided.
const DOMAIN_SUBSTRINGS = {
  ethereum_sepolia: 0, base_sepolia: 6, arbitrum_sepolia: 3, optimism_sepolia: 2,
  polygon_amoy: 7, ethereum: 0, base: 6, arbitrum: 3, optimism: 2, polygon: 7,
  amoy: 7, sepolia: 0, arc_testnet: 26, arc: 26,
};

/**
 * Resolve the CCTP source domain for an intent (record or plain object). Returns
 * a number or null when it cannot be determined.
 */
export function resolveSourceDomain(rec) {
  if (!rec) return null;
  if (rec.sourceDomain != null && Number.isFinite(Number(rec.sourceDomain))) return Number(rec.sourceDomain);
  const candidates = [rec.sourceChain, rec.srcChain, rec.route];
  for (const c of candidates) {
    if (c == null) continue;
    const key = String(c);
    if (NAME_TO_DOMAIN[key] != null) return NAME_TO_DOMAIN[key];
    const lower = key.toLowerCase();
    if (NAME_TO_DOMAIN[lower] != null) return NAME_TO_DOMAIN[lower];
    for (const [sub, dom] of Object.entries(DOMAIN_SUBSTRINGS)) {
      if (lower.includes(sub)) return dom;
    }
  }
  return null;
}

function isValidTxHash(h) {
  return typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h);
}

/**
 * Fetch the Circle attestation for a burn transaction. Mirrors the frontend Iris
 * V2 call: /v2/messages/{domain}?transactionHash={burnTx}.
 * @returns {Promise<{status:string, message?:string, attestation?:string}>}
 */
export async function fetchAttestation(domain, burnTxHash, fetchImpl) {
  const f = fetchImpl || fetch;
  const url = IRIS_BASE + '/v2/messages/' + domain + '?transactionHash=' + burnTxHash;
  let resp;
  try {
    resp = await f(url);
  } catch (e) {
    return { status: 'error', reason: (e && e.message) || 'network' };
  }
  if (!resp.ok) {
    return { status: resp.status === 404 ? 'pending' : 'error', httpStatus: resp.status };
  }
  let data;
  try { data = await resp.json(); } catch (_) { return { status: 'error', reason: 'bad_json' }; }
  const msg = data && Array.isArray(data.messages) && data.messages.length ? data.messages[0] : null;
  if (!msg) return { status: 'pending' };
  if (msg.status === 'complete' && msg.attestation && msg.attestation !== 'PENDING') {
    return { status: 'complete', message: msg.message, attestation: msg.attestation };
  }
  return { status: 'pending' };
}

// Settlement/reimbursement sub-status values. These live on rec.settlement and
// NEVER override rec.status — so an intent that has paid the user stays FULFILLED
// (accurate: the user already has funds) while reimbursement completes over the
// ~15-minute Circle attestation window. Only a CONFIRMED reimbursement advances
// the intent to SETTLED.
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export const SETTLEMENT_STATE = Object.freeze({
  AWAITING_BURN_TX: 'awaiting_burn_tx',
  AWAITING_DOMAIN: 'awaiting_domain',
  PENDING_ATTESTATION: 'pending_attestation',
  REIMBURSEMENT_FAILED: 'reimbursement_failed',
  REIMBURSED: 'reimbursed',
});

function setSettlement(rec, patch) {
  const prev = rec.settlement || {};
  rec.settlement = {
    ...prev,
    ...patch,
    attempts: (prev.attempts || 0) + 1,
    lastCheckedAt: Date.now(),
  };
  rec.updatedAt = Date.now();
  return rec;
}

/**
 * Delegate the on-chain reimbursement to the EXISTING /api/relayer/mint endpoint.
 * This is the same operator relayer the Elligent frontend calls — it runs
 * MessageTransmitter.receiveMessage() and mints USDC back into the Vault. We do
 * NOT re-implement any of that logic here.
 */
async function callMintRelayer(env, { intentId, asset, amount, message, attestation, application, client, version }) {
  const req = new Request('https://internal/api/relayer/mint', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messageBytes: message,
      attestationSignature: attestation,
      intentId,
      asset,
      amount: typeof amount === 'number' ? amount : Number(amount) || 0,
      applicationId: application,
      clientId: client,
      version: version || '1',
    }),
  });
  const res = await mintOnRequest({ request: req, env });
  let data;
  try { data = await res.json(); } catch (_) { data = { success: false, error: 'invalid_relayer_response' }; }
  return data;
}

/**
 * Advance the settlement + reimbursement for one intent by ONE step.
 *
 * IMPORTANT (Cloudflare Pages Functions constraint): background tasks scheduled
 * with waitUntil() are terminated shortly after the response is flushed, so a
 * long (~15 min) polling loop can NOT run to completion here. This function is
 * therefore SINGLE-SHOT and NON-DESTRUCTIVE:
 *
 *   • It performs at most a short bounded number of attestation checks (default
 *     ONE) and returns — it never blocks for minutes.
 *   • It NEVER overwrites rec.status. The user was already paid at Fulfill, so
 *     the intent legitimately stays FULFILLED until reimbursement is CONFIRMED;
 *     progress is tracked on rec.settlement.* instead of stranding it in SETTLING.
 *   • It is idempotent and resumable: each call to the status endpoint (or a
 *     re-execute) drives it one step further until reimbursed. This mirrors the
 *     frontend poller, which also survives reloads and keeps retrying.
 *
 * @param {object} env       Cloudflare env (bindings + secrets)
 * @param {string} intentId  Core intent id
 * @param {object} [opts]
 * @param {number} [opts.maxAttempts=1]    Iris checks per invocation (bounded)
 * @param {number} [opts.intervalMs=2000]  Delay between checks within one invocation
 * @param {function} [opts.fetchImpl]      Injectable fetch (tests)
 * @param {function} [opts.log]            Optional logger(stage, fields)
 * @returns {Promise<{ok:boolean, status:string, reason?:string, txHash?:string}>}
 */
export async function driveSettlement(env, intentId, opts) {
  const o = opts || {};
  // Bounded, short per-invocation budget — safe inside waitUntil on Pages.
  const maxAttempts = Number.isFinite(o.maxAttempts) ? Math.max(1, o.maxAttempts) : 1;
  const intervalMs = Number.isFinite(o.intervalMs) ? o.intervalMs : 2000;
  const log = typeof o.log === 'function' ? o.log : () => {};
  const lkv = ledgerKv(env);

  const rec = await loadIntent(env, intentId);
  if (!rec) return { ok: false, status: 'not_found', reason: 'intent_not_found' };

  // Idempotency: already reimbursed → nothing to do.
  if (rec.settledAt || rec.status === INTENT_STATUS.SETTLED ||
      (rec.settlement && rec.settlement.state === SETTLEMENT_STATE.REIMBURSED)) {
    return { ok: true, status: 'already_settled' };
  }

  const application = rec.application || 'ELLIGENT';
  const client = rec.client || 'default';
  const asset = rec.asset || 'usdc';
  const amount = rec.amount != null ? Number(rec.amount) : null;

  const burnTxHash = (rec.txHashes && (rec.txHashes.burn || rec.txHashes.deposit))
    || rec.burnTxHash || rec.cctpBurnTxHash || null;

  // ── No burn tx recorded server-side ──
  // The source-chain burn happens on the user's wallet; if the caller did not
  // report it we simply CANNOT poll Circle. Do NOT change rec.status — the intent
  // stays FULFILLED (user is paid) and we record a benign sub-status so the caller
  // knows to send burnTxHash to enable server-side reimbursement.
  if (!isValidTxHash(burnTxHash)) {
    setSettlement(rec, { state: SETTLEMENT_STATE.AWAITING_BURN_TX, reason: 'missing_burn_tx' });
    await persistIntent(env, rec);
    log('settlement', { intentId, stage: 'awaiting_burn_tx' });
    return { ok: false, status: 'awaiting_burn_tx', reason: 'missing_burn_tx' };
  }

  const domain = resolveSourceDomain(rec);
  if (domain == null) {
    setSettlement(rec, { state: SETTLEMENT_STATE.AWAITING_DOMAIN, reason: 'unresolved_source_domain', burnTxHash });
    await persistIntent(env, rec);
    log('settlement', { intentId, stage: 'awaiting_domain' });
    return { ok: false, status: 'awaiting_domain', reason: 'unresolved_source_domain' };
  }

  // Record the SETTLEMENT-pending ledger entry once (Circle attestation in flight).
  if (!(rec.settlement && rec.settlement.pendingRecorded)) {
    await recordLedgerEntry(lkv, {
      context: { application, client, version: rec.version },
      intentId, stage: LEDGER_STAGES.SETTLEMENT,
      amount, asset, status: LEDGER_STATUS.PENDING, bridge: 'CCTP', txHash: burnTxHash,
    });
    setSettlement(rec, { state: SETTLEMENT_STATE.PENDING_ATTESTATION, domain, burnTxHash, pendingRecorded: true });
    addTimeline(rec, 'settlement_started', { domain, burnTxHash });
    await persistIntent(env, rec);
  }

  // ── Bounded attestation check (single-shot by default) ──
  let att = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const r = await fetchAttestation(domain, burnTxHash, o.fetchImpl);
    if (r.status === 'complete') { att = r; break; }
    log('settlement', { intentId, stage: 'attestation_check', attempt: attempt + 1, status: r.status });
    if (attempt < maxAttempts - 1) await sleep(intervalMs);
  }

  if (!att) {
    // Not ready yet. Leave the intent FULFILLED with a pending_attestation
    // sub-status so the next status poll / re-execute resumes. Never fail.
    setSettlement(rec, { state: SETTLEMENT_STATE.PENDING_ATTESTATION, domain, burnTxHash });
    await persistIntent(env, rec);
    log('settlement', { intentId, stage: 'attestation_pending' });
    return { ok: false, status: 'attestation_pending', reason: 'attestation_not_ready' };
  }

  if (!rec.attestationAt) {
    addTimeline(rec, 'circle_attestation_received', { domain });
    rec.attestationAt = Date.now();
    setSettlement(rec, { state: SETTLEMENT_STATE.PENDING_ATTESTATION, attestationReceived: true });
    await persistIntent(env, rec);
  }

  // ── Delegate reimbursement to the EXISTING relayer/mint endpoint ──
  let mintData;
  try {
    mintData = await callMintRelayer(env, {
      intentId, asset, amount,
      message: att.message, attestation: att.attestation,
      application, client, version: rec.version,
    });
  } catch (e) {
    setSettlement(rec, { state: SETTLEMENT_STATE.REIMBURSEMENT_FAILED, reason: (e && e.message) || 'mint_call_failed' });
    addTimeline(rec, 'reimbursement_error', { reason: (e && e.message) || 'mint_call_failed' });
    await persistIntent(env, rec);
    log('settlement', { intentId, stage: 'reimbursement_error' });
    return { ok: false, status: 'reimbursement_error', reason: (e && e.message) || 'mint_call_failed' };
  }

  const reimbursed = !!(mintData && (mintData.success || mintData.status === 'already_processed'));
  if (!reimbursed) {
    // Transient failure — keep FULFILLED, record sub-status, allow retry on next poll.
    setSettlement(rec, { state: SETTLEMENT_STATE.REIMBURSEMENT_FAILED, reason: (mintData && mintData.error) || 'unknown' });
    addTimeline(rec, 'reimbursement_failed', { reason: (mintData && mintData.error) || 'unknown' });
    await persistIntent(env, rec);
    log('settlement', { intentId, stage: 'reimbursement_failed' });
    return { ok: false, status: 'reimbursement_failed', reason: (mintData && mintData.error) || 'unknown' };
  }

  const mintTxHash = (mintData && mintData.txHash) || null;

  // ── Finalize: SETTLED + reimbursement ledger + timeline (only on CONFIRMED reimbursement) ──
  rec.status = INTENT_STATUS.SETTLED;
  rec.settledAt = Date.now();
  rec.txHashes = { ...(rec.txHashes || {}), mint: mintTxHash || (rec.txHashes && rec.txHashes.mint) || null };
  setSettlement(rec, { state: SETTLEMENT_STATE.REIMBURSED, mintTxHash, reason: null });
  addTimeline(rec, 'treasury_settlement', { txHash: mintTxHash });
  addTimeline(rec, 'vault_reimbursed', { txHash: mintTxHash });
  await persistIntent(env, rec);

  await recordLedgerEntry(lkv, {
    context: { application, client, version: rec.version },
    intentId, stage: LEDGER_STAGES.SETTLEMENT,
    amount, asset, status: LEDGER_STATUS.SUCCESS, bridge: 'CCTP', txHash: mintTxHash,
  });
  await recordLedgerEntry(lkv, {
    context: { application, client, version: rec.version },
    intentId, stage: LEDGER_STAGES.VAULT_CREDIT,
    amount, asset, status: LEDGER_STATUS.SUCCESS, bridge: 'CCTP', txHash: mintTxHash,
  });

  log('settlement', { intentId, stage: 'settled', txHash: mintTxHash });
  return { ok: true, status: 'settled', txHash: mintTxHash };
}

/**
 * Schedule driveSettlement in the background using context.waitUntil when
 * available; otherwise run it detached. Returns immediately so the request that
 * triggered execution is not blocked. Single-shot per invocation — subsequent
 * status polls / re-executes resume it until reimbursed.
 */
export function scheduleSettlement(context, intentId, opts) {
  const env = context && context.env;
  if (!env || !intentId) return;
  const p = driveSettlement(env, intentId, opts).catch((err) => {
    console.error('[settlement] driveSettlement failed for ' + intentId, err && err.message ? err.message : String(err || 'unknown'));
    try {
      const store = ledgerKv(env);
      if (store && intentId) {
        const logKey = 'ledger:' + intentId;
        store.put(logKey, JSON.stringify({
          stage: 'settlement_error', status: 'failed',
          error: err && err.message ? err.message : String(err || 'unknown'),
          ts: Date.now()
        })).catch(() => {});
      }
    } catch(_) {}
  });
  if (context.waitUntil && typeof context.waitUntil === 'function') {
    context.waitUntil(p);
  }
  return p;
}
