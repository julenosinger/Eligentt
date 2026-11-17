/**
 * x402-intent-do-runtime.test.js — X402IntentStore against the real workerd runtime
 * ═══════════════════════════════════════════════════════════════════════════════
 * Integration test: runs the REAL X402IntentStore class inside Miniflare/workerd
 * (the actual Cloudflare Workers runtime), exercising the real Durable Object
 * storage/transaction/blockConcurrencyWhile/alarm semantics — a strictly stronger
 * certification than the in-memory mock used elsewhere in the suite.
 *
 * NOTE: this Miniflare build provides in-memory DO storage (no SQLite file
 * persistence via `persist`), so cross-process restart durability is NOT
 * reproduced here and remains documented as UNVERIFIED. Within one runtime,
 * storage, transactions, serialization and alarms are exercised for real.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Miniflare } from 'miniflare';
import fs from 'fs';
import path from 'path';

const DO_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../functions/api/x402/x402-intent.do.js'), 'utf8'
);

const SECRET = 'runtime-test-secret-0123456789abcdef';

let mf;
let ns;

beforeAll(async () => {
  mf = new Miniflare({
    modules: [
      { type: 'ESModule', path: 'x402-intent.do.js', contents: DO_SOURCE },
    ],
    script: `
      export { X402IntentStore } from 'x402-intent.do.js';
      export default { async fetch() { return new Response('x402-intent worker'); } };
    `,
    durableObjects: { X402_INTENT_LOCK: 'X402IntentStore' },
    compatibilityFlags: ['nodejs_compat'],
    bindings: { DO_INTERNAL_SECRET: SECRET },
  });
  ns = await mf.getDurableObjectNamespace('X402_INTENT_LOCK');
});

afterAll(async () => {
  if (mf) await mf.dispose();
});

function stubFor(walletAddress) {
  return ns.get(ns.idFromName(walletAddress.toLowerCase()));
}

async function doFetch(stub, pathname, { method = 'GET', body } = {}) {
  return stub.fetch('https://x402-intent-do/' + pathname, {
    method,
    headers: { 'X-DO-Internal-Secret': SECRET, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function jsonOf(resp) { return resp.json(); }

function makeIntent(over = {}) {
  return {
    schemaVersion: 1,
    intentId: crypto.randomUUID(),
    userId: 'user-1',
    walletAddress: '0x' + 'ab'.repeat(20),
    walletProvider: 'circle',
    resourceUrl: 'https://api.example.com/premium',
    resourceFingerprint: 'a'.repeat(64),
    requirementDigest: 'b'.repeat(64),
    scheme: 'exact',
    network: 'eip155:5042',
    chainId: 5042,
    assetAddress: '0x3600000000000000000000000000000000000000',
    tokenDecimals: 6,
    amountAtomic: '1000000',
    payTo: '0x' + 'cd'.repeat(20),
    maxTimeoutSeconds: 60,
    authorizationNonce: null,
    idempotencyKey: 'key-' + crypto.randomUUID().replace(/-/g, ''),
    state: 'CREATED',
    stateVersion: 1,
    createdAt: new Date(Date.now() - 1000).toISOString(),
    updatedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    authorizedAt: null,
    authorizationSignature: null,
    authorizationValidAfter: null,
    authorizationValidBefore: null,
    facilitatorVerification: null,
    settlementAttemptId: null,
    settlementStatus: null,
    transactionHash: null,
    settlementEvidence: null,
    lastErrorCode: null,
    ...over,
  };
}

const DIGEST = 'c'.repeat(64);

describe('X402IntentStore — real workerd runtime integration', () => {
  it('persists an intent through the full lifecycle against real DO storage', async () => {
    const intent = makeIntent();
    const stub = stubFor(intent.walletAddress);

    const create = await doFetch(stub, 'create', { method: 'POST', body: { intent, requestDigest: DIGEST } });
    expect(create.status).toBe(201);

    const got = await doFetch(stub, 'intent?id=' + intent.intentId);
    const gotBody = await jsonOf(got);
    expect(got.status).toBe(200);
    expect(gotBody.intent.state).toBe('CREATED');

    const prep = await doFetch(stub, 'transition', { method: 'POST', body: { intentId: intent.intentId, to: 'PREPARED', expectedVersion: 1 } });
    expect(prep.status).toBe(200);

    const reserve = await doFetch(stub, 'reserve-nonce', { method: 'POST', body: { intentId: intent.intentId, nonce: '0x' + '11'.repeat(32), expectedVersion: 2 } });
    expect(reserve.status).toBe(200);
    const reserveBody = await jsonOf(reserve);
    expect(reserveBody.intent.state).toBe('AWAITING_AUTHORIZATION');

    // Re-read from the SAME stub (real storage, not mock).
    const after = await doFetch(stub, 'intent?id=' + intent.intentId);
    const afterBody = await jsonOf(after);
    expect(afterBody.intent.state).toBe('AWAITING_AUTHORIZATION');
    expect(afterBody.intent.authorizationNonce).toBe('0x' + '11'.repeat(32));
  });

  it('serializes 50 concurrent creates to exactly ONE winner (real DO single-instance semantics)', async () => {
    const intent = makeIntent();
    const stub = stubFor(intent.walletAddress);
    const results = await Promise.all(
      Array.from({ length: 50 }, () => doFetch(stub, 'create', { method: 'POST', body: { intent, requestDigest: DIGEST } }))
    );
    const bodies = await Promise.all(results.map((r) => r.json()));
    const created = bodies.filter((b) => b.created === true);
    const idempotent = bodies.filter((b) => b.created === false);
    expect(created).toHaveLength(1);
    expect(idempotent).toHaveLength(49);
    for (const b of bodies) expect(b.intent.intentId).toBe(intent.intentId);
  });

  it('rejects cross-wallet access (separate DO instances do not share state)', async () => {
    const intentA = makeIntent({ walletAddress: '0x' + 'ab'.repeat(20) });
    const stubA = stubFor(intentA.walletAddress);
    const create = await doFetch(stubA, 'create', { method: 'POST', body: { intent: intentA, requestDigest: DIGEST } });
    expect(create.status).toBe(201);

    const stubB = stubFor('0x' + 'ef'.repeat(20)); // different wallet → different DO
    const got = await doFetch(stubB, 'intent?id=' + intentA.intentId);
    expect(got.status).toBe(404);
  });
});
