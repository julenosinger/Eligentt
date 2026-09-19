import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveSourceDomain, fetchAttestation, driveSettlement } from '../../functions/api/core/settlement.mjs';
import { saveIntent, getStoredIntent } from '../../functions/api/core/store.mjs';
import { INTENT_STATUS } from '../../functions/api/core/intent-service.mjs';
import { readLedger, LEDGER_STAGES } from '../../functions/api/ledger.mjs';

function mockKV() {
  const store = new Map();
  return {
    _store: store,
    async get(k) { return store.get(k) ?? null; },
    async put(k, v) { store.set(k, v); },
    async list({ prefix = '', limit = 1000 } = {}) {
      return { keys: Array.from(store.keys()).filter(k => k.startsWith(prefix)).slice(0, limit).map(name => ({ name })) };
    },
  };
}

const BURN_TX = '0x' + 'ab'.repeat(32);

function baseIntent(over = {}) {
  return {
    intentId: 'INT-TEST-1',
    application: 'EXECDAAT',
    client: 'default',
    version: 'v1',
    asset: 'usdc',
    amount: 100,
    grossAmount: 100,
    feeAmount: 1,
    wallet: '0x' + '1'.repeat(40),
    sourceChain: 'Base_Sepolia',
    status: INTENT_STATUS.FULFILLED,
    fulfilledAt: Date.now(),
    settledAt: null,
    txHashes: { fulfill: '0x' + 'cc'.repeat(32), burn: BURN_TX },
    timeline: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...over,
  };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Settlement — source domain resolution', () => {
  it('resolves domain from numeric chainId', () => {
    expect(resolveSourceDomain({ sourceChain: '84532' })).toBe(6);
  });
  it('resolves domain from symbolic chain name', () => {
    expect(resolveSourceDomain({ sourceChain: 'Base_Sepolia' })).toBe(6);
    expect(resolveSourceDomain({ sourceChain: 'ethereum_sepolia' })).toBe(0);
  });
  it('prefers an explicit sourceDomain', () => {
    expect(resolveSourceDomain({ sourceDomain: 7, sourceChain: 'Base_Sepolia' })).toBe(7);
  });
  it('returns null when unresolvable', () => {
    expect(resolveSourceDomain({ sourceChain: 'nonsense_chain' })).toBe(null);
    expect(resolveSourceDomain({})).toBe(null);
  });
});

describe('Settlement — Iris attestation fetch', () => {
  it('returns complete with message + attestation', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({
      messages: [{ status: 'complete', message: '0xdead', attestation: '0xbeef' }],
    }), { status: 200 });
    const r = await fetchAttestation(6, BURN_TX, fetchImpl);
    expect(r.status).toBe('complete');
    expect(r.message).toBe('0xdead');
    expect(r.attestation).toBe('0xbeef');
  });
  it('maps 404 to pending', async () => {
    const fetchImpl = async () => new Response('nope', { status: 404 });
    const r = await fetchAttestation(6, BURN_TX, fetchImpl);
    expect(r.status).toBe('pending');
  });
  it('treats PENDING attestation as pending', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({
      messages: [{ status: 'pending_confirmations', attestation: 'PENDING' }],
    }), { status: 200 });
    const r = await fetchAttestation(6, BURN_TX, fetchImpl);
    expect(r.status).toBe('pending');
  });
});

describe('Settlement — driveSettlement (shared pipeline continuation)', () => {
  it('continues the pipeline past Fulfill: attestation received + SETTLEMENT ledger + reimbursement attempted', async () => {
    const env = { CORE_KV: mockKV(), TURBO_RELAYER_PRIVATE_KEY: '0x' + '1'.repeat(64) };
    await saveIntent(env, baseIntent());

    // The attestation poll uses the injected fetch; the reimbursement (mint.js)
    // uses global fetch for its RPC — stub it to fail fast so no real network is
    // hit. The KEY assertion is that the pipeline CONTINUED past Fulfill.
    vi.stubGlobal('fetch', async () => { throw new Error('no-network-in-test'); });

    const fetchImpl = async () => new Response(JSON.stringify({
      messages: [{ status: 'complete', message: '0x' + '11'.repeat(20), attestation: '0x' + '22'.repeat(20) }],
    }), { status: 200 });

    const res = await driveSettlement(env, 'INT-TEST-1', { maxAttempts: 1, intervalMs: 1, fetchImpl });

    const rec = await getStoredIntent(env, 'INT-TEST-1');
    const events = (rec.timeline || []).map(t => t.event);
    expect(events).toContain('settlement_started');
    expect(events).toContain('circle_attestation_received');

    const ledger = await readLedger(env.CORE_KV, { limit: 100 });
    const stages = ledger.map(e => e.stage);
    expect(stages).toContain(LEDGER_STAGES.SETTLEMENT);
    // Reimbursement cannot confirm without RPC in a unit env, but it WAS attempted.
    expect(['reimbursement_error', 'reimbursement_failed', 'settled']).toContain(res.status);
  });

  it('is idempotent when already settled', async () => {
    const env = { CORE_KV: mockKV() };
    await saveIntent(env, baseIntent({ status: INTENT_STATUS.SETTLED, settledAt: Date.now() }));
    const r = await driveSettlement(env, 'INT-TEST-1', { maxAttempts: 1, intervalMs: 1 });
    expect(r.status).toBe('already_settled');
  });

  it('reports awaiting_burn_tx WITHOUT stranding the intent (stays FULFILLED)', async () => {
    const env = { CORE_KV: mockKV() };
    await saveIntent(env, baseIntent({ txHashes: { fulfill: '0x' + 'cc'.repeat(32) } }));
    const r = await driveSettlement(env, 'INT-TEST-1', { maxAttempts: 1, intervalMs: 1 });
    expect(r.status).toBe('awaiting_burn_tx');
    const rec = await getStoredIntent(env, 'INT-TEST-1');
    // Non-destructive: user is already paid, so it MUST remain FULFILLED.
    expect(rec.status).toBe(INTENT_STATUS.FULFILLED);
    expect(rec.settlement.state).toBe('awaiting_burn_tx');
  });

  it('reports awaiting_domain without changing rec.status', async () => {
    const env = { CORE_KV: mockKV() };
    await saveIntent(env, baseIntent({ sourceChain: 'unknown_chain', sourceDomain: null }));
    const r = await driveSettlement(env, 'INT-TEST-1', { maxAttempts: 1, intervalMs: 1 });
    expect(r.status).toBe('awaiting_domain');
    const rec = await getStoredIntent(env, 'INT-TEST-1');
    expect(rec.status).toBe(INTENT_STATUS.FULFILLED);
    expect(rec.settlement.state).toBe('awaiting_domain');
  });

  it('single-shot: pending attestation keeps FULFILLED and is resumable (never stuck in SETTLING)', async () => {
    const env = { CORE_KV: mockKV() };
    await saveIntent(env, baseIntent());
    const fetchImpl = async () => new Response('x', { status: 404 });
    const r = await driveSettlement(env, 'INT-TEST-1', { maxAttempts: 1, intervalMs: 1, fetchImpl });
    expect(r.status).toBe('attestation_pending');
    const rec = await getStoredIntent(env, 'INT-TEST-1');
    expect(rec.status).toBe(INTENT_STATUS.FULFILLED);
    expect(rec.settledAt).toBeFalsy();
    expect(rec.settlement.state).toBe('pending_attestation');
  });

  it('resumes on a later call: completes once Iris returns the attestation', async () => {
    const env = { CORE_KV: mockKV(), TURBO_RELAYER_PRIVATE_KEY: '0x' + '1'.repeat(64) };
    await saveIntent(env, baseIntent());

    // First call: Iris not ready → stays FULFILLED / pending_attestation.
    const notReady = async () => new Response('x', { status: 404 });
    const r1 = await driveSettlement(env, 'INT-TEST-1', { maxAttempts: 1, intervalMs: 1, fetchImpl: notReady });
    expect(r1.status).toBe('attestation_pending');

    // Second call: Iris ready → attestation received + reimbursement attempted.
    vi.stubGlobal('fetch', async () => { throw new Error('no-network-in-test'); });
    const ready = async () => new Response(JSON.stringify({
      messages: [{ status: 'complete', message: '0x' + '11'.repeat(20), attestation: '0x' + '22'.repeat(20) }],
    }), { status: 200 });
    const r2 = await driveSettlement(env, 'INT-TEST-1', { maxAttempts: 1, intervalMs: 1, fetchImpl: ready });
    const rec = await getStoredIntent(env, 'INT-TEST-1');
    const events = (rec.timeline || []).map(t => t.event);
    expect(events).toContain('circle_attestation_received');
    expect(['reimbursement_error', 'reimbursement_failed', 'settled']).toContain(r2.status);
  });
});
