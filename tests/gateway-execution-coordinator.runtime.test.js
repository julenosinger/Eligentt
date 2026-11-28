/**
 * gateway-execution-coordinator.runtime.test.js — GatewayExecutionCoordinator
 * against the REAL workerd runtime (Miniflare).
 * ═══════════════════════════════════════════════════════════════════════════
 * Phase 1.0.1C.1 — validates the DO on the actual Cloudflare Workers runtime,
 * exercising real Durable Object storage/transaction/blockConcurrencyWhile
 * semantics (a strictly stronger certification than the in-memory mock).
 *
 * NOTE: this Miniflare build provides in-memory DO storage (no SQLite `persist`),
 * so cross-process restart durability is NOT reproduced here and remains
 * documented as UNVERIFIED. Within one runtime, storage, transactions,
 * serialization and atomicity are exercised for real.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Miniflare } from 'miniflare';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DO_SOURCE   = fs.readFileSync(path.join(ROOT, 'functions/api/gateway/gateway-execution-coordinator.do.js'), 'utf8');
const UTIL_SOURCE = fs.readFileSync(path.join(ROOT, 'functions/api/gateway/coordinator-util.js'), 'utf8');

// Bundle the DO + its single dependency into one module for the Miniflare worker.
// The util is pure (no imports); its `export` keywords are stripped and the DO's
// `import { … } from './coordinator-util.js'` is removed.
function bundleDOWithUtil() {
  const utilBody = UTIL_SOURCE.replace(/^export /gm, '');
  const doBody = DO_SOURCE.replace(/^import \{[^}]*\} from '\.\/coordinator-util\.js';\s*$/m, '');
  return utilBody + '\n' + doBody;
}

const SECRET = 'runtime-test-secret-0123456789abcdef';

let mf;
let ns;

beforeAll(async () => {
  mf = new Miniflare({
    modules: [
      { type: 'ESModule', path: 'coordinator-bundle.js', contents: bundleDOWithUtil() },
    ],
    script: `
      export { GatewayExecutionCoordinator } from 'coordinator-bundle.js';
      export default { async fetch() { return new Response('gateway-exec worker'); } };
    `,
    durableObjects: { GATEWAY_EXECUTION_COORDINATOR: 'GatewayExecutionCoordinator' },
    compatibilityFlags: ['nodejs_compat'],
    bindings: { DO_INTERNAL_SECRET: SECRET },
  });
  ns = await mf.getDurableObjectNamespace('GATEWAY_EXECUTION_COORDINATOR');
});

afterAll(async () => {
  if (mf) await mf.dispose();
});

function stubFor(name) {
  return ns.get(ns.idFromName(name));
}

async function doFetch(stub, pathname, { method = 'GET', body } = {}) {
  return stub.fetch('https://gateway-exec-do/' + pathname, {
    method,
    headers: { 'X-DO-Internal-Secret': SECRET, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function pad32(addr) {
  return '0x' + String(addr).toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

const DEPOSITOR = '0x' + '11'.repeat(20);
const RECIPIENT = '0x' + '22'.repeat(20);
const TOKEN_A   = '0x' + 'aa'.repeat(20);
const TOKEN_B   = '0x' + 'bb'.repeat(20);
const MAINNET_WALLET = '0x77777777dcc4d5a8b6e418fd04d8997ef11000ee';
const SCOPE = TOKEN_A + ':26';

function makeBurnIntent(over = {}) {
  const specOver = over.spec || {};
  return {
    maxBlockHeight: '115792089237316195423570985008687907853269984665640564039457584007913129639935',
    maxFee: '2010000',
    spec: {
      version: 1,
      sourceDomain: 26,
      destinationDomain: 0,
      sourceContract: pad32(MAINNET_WALLET),
      destinationContract: pad32('0x2222222d7164433c4c09b0b0d809a9b52c04c205'),
      sourceToken: pad32(TOKEN_A),
      destinationToken: pad32(TOKEN_B),
      sourceDepositor: pad32(DEPOSITOR),
      destinationRecipient: pad32(RECIPIENT),
      sourceSigner: pad32(DEPOSITOR),
      destinationCaller: pad32('0x0000000000000000000000000000000000000000'),
      value: '1000000',
      salt: '0x' + '44'.repeat(32),
      hookData: '0x',
      ...specOver,
    },
  };
}

const DO_NAME = 'gateway-exec:' + DEPOSITOR + ':mainnet';

// Unique depositor per test → isolated DO instance (no cross-test state).
function depFor(n) { return '0x' + n.toString(16).padStart(2, '0').repeat(20); }
function nameFor(n, env = 'mainnet') { return 'gateway-exec:' + depFor(n) + ':' + env; }

describe('GatewayExecutionCoordinator — real workerd runtime integration', () => {
  it('persists reserve → recover → terminal release against real DO storage', async () => {
    const stub = stubFor(nameFor(1));
    await doFetch(stub, 'set-balance', { method: 'POST', body: { scope: SCOPE, amount: '100000000' } });

    const reserve = await doFetch(stub, 'reserve', { method: 'POST', body: { burnIntent: makeBurnIntent(), idempotencyKey: 'intent-runtime-1' } });
    expect(reserve.status).toBe(201);
    const rec = (await reserve.json()).record;

    // Cross-salt duplicate → recover (same key + same payload, different salt).
    const dup = await doFetch(stub, 'reserve', { method: 'POST', body: { burnIntent: makeBurnIntent({ spec: { salt: '0x' + '55'.repeat(32) } }), idempotencyKey: 'intent-runtime-1' } });
    expect(dup.status).toBe(200);
    expect((await dup.json()).recovered).toBe(true);

    // Full lifecycle: reserved → submitting → accepted → confirmed.
    await doFetch(stub, 'update', { method: 'POST', body: { operationId: rec.operationId, to: 'submitting', expectedVersion: 1, evidence: {} } });
    await doFetch(stub, 'update', { method: 'POST', body: { operationId: rec.operationId, to: 'accepted', expectedVersion: 2, evidence: {} } });
    const confirm = await doFetch(stub, 'update', { method: 'POST', body: { operationId: rec.operationId, to: 'confirmed', expectedVersion: 3, evidence: { transactionHash: '0x' + 'cc'.repeat(32) } } });
    expect(confirm.status).toBe(200);

    // Re-read from the same stub — real storage.
    const st = await doFetch(stub, 'status?operationId=' + rec.operationId);
    const stBody = await st.json();
    expect(stBody.record.status).toBe('confirmed');
    expect(stBody.record.txHash).toBe('0x' + 'cc'.repeat(32));
  });

  it('serializes 50 concurrent reserves with different salts into exactly ONE winner', async () => {
    const stub = stubFor(nameFor(2));
    await doFetch(stub, 'set-balance', { method: 'POST', body: { scope: SCOPE, amount: '100000000' } });
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        doFetch(stub, 'reserve', { method: 'POST', body: { burnIntent: makeBurnIntent({ spec: { salt: '0x' + i.toString(16).padStart(2, '0').repeat(32) } }), idempotencyKey: 'intent-concurrent-1' } })
      )
    );
    const bodies = await Promise.all(results.map((r) => r.json()));
    const reserved  = bodies.filter((b) => b.reserved === true);
    const recovered = bodies.filter((b) => b.recovered === true);
    expect(reserved).toHaveLength(1);
    expect(recovered).toHaveLength(49);
  });

  it('enforces the quantitative balance reservation under concurrency (no over-spend)', async () => {
    const stub = stubFor(nameFor(3));
    // Balance 4_000_000 covers exactly ONE reservation of 3_010_000.
    await doFetch(stub, 'set-balance', { method: 'POST', body: { scope: SCOPE, amount: '4000000' } });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        doFetch(stub, 'reserve', { method: 'POST', body: { burnIntent: makeBurnIntent({ spec: { salt: '0x' + (i + 10).toString(16).padStart(2, '0').repeat(32) } }), idempotencyKey: 'intent-bal-' + i } })
      )
    );
    const bodies = await Promise.all(results.map((r) => r.json()));
    const reserved = bodies.filter((b) => b.reserved === true);
    expect(reserved).toHaveLength(1);
    // The remaining 9 are rejected with insufficient balance, never over-committed.
    const rejected = bodies.filter((b) => b.error === 'insufficient_available_balance');
    expect(rejected).toHaveLength(9);
  });

  it('isolates mainnet from testnet (separate DO instances)', async () => {
    const mainnetStub = stubFor(nameFor(4, 'mainnet'));
    const testnetStub = stubFor(nameFor(4, 'testnet'));
    await doFetch(mainnetStub, 'set-balance', { method: 'POST', body: { scope: SCOPE, amount: '100000000' } });

    const r1 = await doFetch(mainnetStub, 'reserve', { method: 'POST', body: { burnIntent: makeBurnIntent(), idempotencyKey: 'intent-iso-1' } });
    expect(r1.status).toBe(201);

    // Testnet has no balance synced → its own reservation fails closed independently.
    const r2 = await doFetch(testnetStub, 'reserve', { method: 'POST', body: { burnIntent: makeBurnIntent(), idempotencyKey: 'intent-iso-1' } });
    expect(r2.status).toBe(503);
  });
});
