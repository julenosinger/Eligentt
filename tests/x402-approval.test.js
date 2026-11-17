/**
 * x402-approval.test.js — operator settlement approval validation (mocked)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Tests the operator approval layer with mocked contexts. Proves that settlement
 * cannot be authorized by a feature flag, a forged/tampered/expired/revoked/
 * reused approval, or a mismatched payment. No live approval is created.
 */
import { describe, it, expect } from 'vitest';
import { X402IntentStore } from '../functions/api/x402/x402-intent.do.js';
import { buildApproval, validateApproval, consumeApprovalDurable, approvalFingerprint } from '../functions/api/x402/x402-approval.mjs';

const SECRET = 'operator-approval-secret-0123456789';
const OP = 'operator-1';
const SENDER = '0x' + 'ab'.repeat(20);
const RECIPIENT = '0x' + 'cd'.repeat(20);
const TOKEN = '0x3600000000000000000000000000000000000000';
const ATTEMPT = crypto.randomUUID();

async function makeApproval(over = {}) {
  return buildApproval({
    id: over.id || crypto.randomUUID(),
    operator: over.operator || OP,
    chainId: over.chainId || 5042,
    tokenAddress: over.tokenAddress || TOKEN,
    sender: over.sender || SENDER,
    recipient: over.recipient || RECIPIENT,
    maxAmountAtomic: over.maxAmountAtomic || '1000000',
    feeCeiling: over.feeCeiling || '500000',
    settlementAttemptId: over.settlementAttemptId || ATTEMPT,
    expiresAt: over.expiresAt || Date.now() + 3600_000,
    issuedAt: over.issuedAt,
  }, SECRET);
}

function request(over = {}) {
  return {
    chainId: 5042, tokenAddress: TOKEN, sender: SENDER, recipient: RECIPIENT,
    amountAtomic: '1000000', settlementAttemptId: ATTEMPT, ...over,
  };
}

describe('x402 operator approval — authentication & binding', () => {
  it('accepts a valid, matching, unexpired approval', async () => {
    const approval = await makeApproval();
    const res = await validateApproval(SECRET, approval, request(), { now: Date.now() });
    expect(res.ok).toBe(true);
  });

  it('rejects a tampered approval (signature invalid)', async () => {
    const approval = await makeApproval();
    approval.maxAmountAtomic = '999999999999';
    const res = await validateApproval(SECRET, approval, request(), {});
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('approval_signature_invalid');
  });

  it('rejects an approval signed with a different secret', async () => {
    const approval = await makeApproval();
    const res = await validateApproval('wrong-secret', approval, request(), {});
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('approval_signature_invalid');
  });

  it('rejects field mismatches (chain/token/sender/recipient/attempt)', async () => {
    const approval = await makeApproval();
    expect((await validateApproval(SECRET, approval, request({ chainId: 1 }), {})).reason).toBe('chain_mismatch');
    expect((await validateApproval(SECRET, approval, request({ tokenAddress: '0x' + '99'.repeat(20) }), {})).reason).toBe('token_mismatch');
    expect((await validateApproval(SECRET, approval, request({ sender: '0x' + 'ee'.repeat(20) }), {})).reason).toBe('sender_mismatch');
    expect((await validateApproval(SECRET, approval, request({ recipient: '0x' + 'ee'.repeat(20) }), {})).reason).toBe('recipient_mismatch');
    expect((await validateApproval(SECRET, approval, request({ settlementAttemptId: crypto.randomUUID() }), {})).reason).toBe('attempt_mismatch');
  });

  it('rejects an amount exceeding the approved maximum (exact BigInt)', async () => {
    const approval = await makeApproval();
    const res = await validateApproval(SECRET, approval, request({ amountAtomic: '1000001' }), {});
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('amount_exceeds_approval');
    // Exactly the max is allowed.
    expect((await validateApproval(SECRET, approval, request({ amountAtomic: '1000000' }), {})).ok).toBe(true);
  });
});

describe('x402 operator approval — lifecycle', () => {
  it('rejects an expired approval', async () => {
    const approval = await makeApproval({ expiresAt: Date.now() - 1000 });
    const res = await validateApproval(SECRET, approval, request(), { now: Date.now() });
    expect(res.reason).toBe('approval_expired');
  });

  it('rejects a revoked approval', async () => {
    const approval = await makeApproval();
    const res = await validateApproval(SECRET, approval, request(), { revokedIds: new Set([approval.id]) });
    expect(res.reason).toBe('approval_revoked');
  });

  it('enforces one-time-use (replay rejected)', async () => {
    const approval = await makeApproval();
    const usedIds = new Set();
    expect((await validateApproval(SECRET, approval, request(), { usedIds })).ok).toBe(true);
    usedIds.add(approval.id);
    const replay = await validateApproval(SECRET, approval, request(), { usedIds });
    expect(replay.ok).toBe(false);
    expect(replay.reason).toBe('approval_already_used');
  });

  it('rejects when no secret is configured (fail-closed)', async () => {
    const approval = await makeApproval();
    const res = await validateApproval('', approval, request(), {});
    expect(res.reason).toBe('approval_secret_unconfigured');
  });
});

describe('x402 operator approval — durable atomic consumption (P0.2)', () => {
  const DO_SECRET = 'test-internal-secret-0123456789abcdef';

  function makeMutex() { let t = Promise.resolve(); return (fn) => { const r = t.then(fn, fn); t = r.catch(() => {}); return r; }; }
  function makeDOBinding() {
    const instances = new Map();
    return {
      idFromName(name) { return { __name: String(name) }; },
      get(id) {
        const name = id.__name;
        if (!instances.has(name)) {
          const store = new Map();
          const lock = makeMutex();
          const txn = { get: async (k) => store.has(k) ? store.get(k) : undefined, put: async (k, v) => store.set(k, v), delete: async (k) => store.delete(k) };
          const state = { storage: { get: async (k) => store.has(k) ? store.get(k) : undefined, put: async (k, v) => store.set(k, v), delete: async (k) => store.delete(k), setAlarm: async () => {}, deleteAlarm: async () => {}, getAlarm: async () => null, transaction: async (cb) => cb(txn) }, blockConcurrencyWhile: async (cb) => lock(cb), _store: store };
          instances.set(name, new X402IntentStore(state, { DO_INTERNAL_SECRET: DO_SECRET }));
        }
        const doObj = instances.get(name);
        return { fetch: (url, opts) => doObj.fetch(new Request(url, opts)) };
      },
      _instances: instances,
    };
  }

  function env(binding) {
    return { X402_OPERATOR_APPROVAL_SECRET: SECRET, X402_INTENT_LOCK: binding, DO_INTERNAL_SECRET: DO_SECRET };
  }

  it('consumes an approval exactly once (duplicate returns no new grant)', async () => {
    const binding = makeDOBinding();
    const approval = await makeApproval();
    const e = env(binding);
    const first = await consumeApprovalDurable(e, { approval, request: request(), walletAddress: SENDER, userId: 'user-1', state: {} });
    expect(first.ok).toBe(true);
    expect(first.consumed).toBe(true);
    const second = await consumeApprovalDurable(e, { approval, request: request(), walletAddress: SENDER, userId: 'user-1', state: {} });
    expect(second.ok).toBe(true);
    expect(second.consumed).toBe(false);
    expect(second.already).toBe(true);
  });

  it('serializes 50 concurrent consumption attempts to exactly ONE grant', async () => {
    const binding = makeDOBinding();
    const approval = await makeApproval();
    const e = env(binding);
    const results = await Promise.all(
      Array.from({ length: 50 }, () => consumeApprovalDurable(e, { approval, request: request(), walletAddress: SENDER, userId: 'user-1', state: {} }))
    );
    const grants = results.filter((r) => r.consumed === true);
    const duplicates = results.filter((r) => r.consumed === false && r.already === true);
    expect(grants).toHaveLength(1);
    expect(duplicates).toHaveLength(49);
  });

  it('rejects a revoked approval at consumption time', async () => {
    const binding = makeDOBinding();
    const approval = await makeApproval();
    const e = env(binding);
    // Revoke via the DO directly.
    const stub = binding.get(binding.idFromName(SENDER));
    await stub.fetch('https://do/revoke-approval', { method: 'POST', headers: { 'X-DO-Internal-Secret': DO_SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify({ approvalId: approval.id }) });
    const res = await consumeApprovalDurable(e, { approval, request: request(), walletAddress: SENDER, userId: 'user-1', state: {} });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('approval_revoked');
  });

  it('rejects a tampered approval before any durable consumption', async () => {
    const binding = makeDOBinding();
    const approval = await makeApproval();
    const tampered = { ...approval, maxAmountAtomic: '999999999999' };
    const res = await consumeApprovalDurable(env(binding), { approval: tampered, request: request(), walletAddress: SENDER, userId: 'user-1', state: {} });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('approval_signature_invalid');
    // Nothing was consumed.
    const stub = binding.get(binding.idFromName(SENDER));
    const chk = await stub.fetch('https://do/consume-approval', { method: 'POST', headers: { 'X-DO-Internal-Secret': DO_SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify({ approvalId: approval.id, approvalFingerprint: await approvalFingerprint(approval), expectedAttemptId: ATTEMPT }) });
    expect(chk.status).toBe(201);
  });
});
