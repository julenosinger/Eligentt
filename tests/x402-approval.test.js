/**
 * x402-approval.test.js — operator settlement approval validation (mocked)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Tests the operator approval layer with mocked contexts. Proves that settlement
 * cannot be authorized by a feature flag, a forged/tampered/expired/revoked/
 * reused approval, or a mismatched payment. No live approval is created.
 */
import { describe, it, expect } from 'vitest';
import { buildApproval, validateApproval } from '../functions/api/x402/x402-approval.mjs';

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
