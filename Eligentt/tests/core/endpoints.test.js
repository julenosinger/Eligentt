import { describe, it, expect, vi, afterEach } from 'vitest';
import { onRequestPost as createIntent, onRequestOptions as intentsOptions } from '../../functions/api/core/v1/intents.js';
import { onRequestGet as intentStatus } from '../../functions/api/core/v1/intents/[intentId].js';
import { onRequestPost as quote } from '../../functions/api/core/v1/quote.js';
import { onRequestPost as execute } from '../../functions/api/core/v1/execute.js';
import { onRequestGet as history } from '../../functions/api/core/v1/history.js';
import { onRequestGet as metrics } from '../../functions/api/core/v1/metrics.js';
import { onRequestGet as health } from '../../functions/api/core/v1/health.js';
import { onRequestGet as applications } from '../../functions/api/core/v1/applications.js';

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

function makeEnv() {
  return { CORE_KV: mockKV(), ALLOWED_ORIGINS: 'https://elligente.pages.dev' };
}

function post(url, body, headers = {}) {
  return new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
function get(url, headers = {}) {
  return new Request(url, { method: 'GET', headers });
}

function assertEnvelope(body) {
  expect(body).toHaveProperty('success');
  expect(body).toHaveProperty('requestId');
  expect(body).toHaveProperty('correlationId');
  expect(body).toHaveProperty('timestamp');
  expect(body).toHaveProperty('version');
  expect(body).toHaveProperty('data');
  expect(body).toHaveProperty('errors');
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('Core API — endpoints (v1)', () => {
  it('POST /intents creates an intent and returns a standardized envelope', async () => {
    const env = makeEnv();
    const res = await createIntent({ request: post('https://app/api/core/v1/intents', { asset: 'usdc', amount: 100, wallet: '0x' + '1'.repeat(40) }), env });
    expect(res.status).toBe(201);
    const body = await res.json();
    assertEnvelope(body);
    expect(body.success).toBe(true);
    expect(body.data.intentId).toMatch(/^INT-/);
    expect(body.data.application).toBe('ELLIGENT');
    expect(body.data.quote.bridge).toBe('Turbo');
    expect(body.version).toBe('v1');
  });

  it('OPTIONS preflight returns 204 with CORS', async () => {
    const env = makeEnv();
    const res = await intentsOptions({ request: new Request('https://app/api/core/v1/intents', { method: 'OPTIONS', headers: { Origin: 'https://elligente.pages.dev' } }), env });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://elligente.pages.dev');
  });

  it('propagates the caller X-Correlation-ID through the envelope + headers', async () => {
    const env = makeEnv();
    const res = await createIntent({ request: post('https://app/api/core/v1/intents', { asset: 'usdc', amount: 10, wallet: '0x' + '2'.repeat(40) }, { 'X-Correlation-ID': 'trace-xyz-1' }), env });
    const body = await res.json();
    expect(body.correlationId).toBe('trace-xyz-1');
    expect(res.headers.get('X-Correlation-ID')).toBe('trace-xyz-1');
  });

  it('rejects a prepared-but-not-enabled auth scheme with 401', async () => {
    const env = makeEnv();
    const res = await createIntent({ request: post('https://app/api/core/v1/intents', { asset: 'usdc', amount: 10, wallet: '0x' + '3'.repeat(40) }, { 'X-Api-Key': 'k' }), env });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.errors[0].code).toBe('AUTH_NOT_ENABLED');
  });

  it('returns 422 with field errors on invalid create-intent', async () => {
    const env = makeEnv();
    const res = await createIntent({ request: post('https://app/api/core/v1/intents', { asset: 'xxx', amount: -5 }), env });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.errors.length).toBeGreaterThan(0);
  });

  it('GET /intents/{id} returns real stored status, and 404 for unknown', async () => {
    const env = makeEnv();
    const created = await (await createIntent({ request: post('https://app/api/core/v1/intents', { asset: 'usdc', amount: 250, wallet: '0x' + '4'.repeat(40) }), env })).json();
    const id = created.data.intentId;

    const res = await intentStatus({ request: get('https://app/api/core/v1/intents/' + id), env, params: { intentId: id } });
    expect(res.status).toBe(200);
    const body = await res.json();
    assertEnvelope(body);
    expect(body.data.intentId).toBe(id);
    expect(body.data.application).toBe('ELLIGENT');
    expect(Array.isArray(body.data.timeline)).toBe(true);
    expect(body.data.treasury.vault).toMatch(/^0x/);

    const missing = await intentStatus({ request: get('https://app/api/core/v1/intents/UNKNOWN'), env, params: { intentId: 'UNKNOWN' } });
    expect(missing.status).toBe(404);
    const mbody = await missing.json();
    expect(mbody.errors[0].code).toBe('INTENT_NOT_FOUND');
  });

  it('POST /quote returns route/fee/eta/receive', async () => {
    const env = makeEnv();
    const res = await quote({ request: post('https://app/api/core/v1/quote', { token: 'usdc', amount: 500 }), env });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.bridge).toBe('Turbo');
    expect(body.data.fee).toBeCloseTo(5, 6);
    expect(body.data.receive).toBeCloseTo(495, 6);
    expect(body.data.provider).toBe('Circle CCTP');
  });

  it('POST /execute dryRun previews without touching the chain', async () => {
    const env = makeEnv();
    const created = await (await createIntent({ request: post('https://app/api/core/v1/intents', { asset: 'usdc', amount: 300, wallet: '0x' + '5'.repeat(40) }), env })).json();
    const id = created.data.intentId;

    const res = await execute({ request: post('https://app/api/core/v1/execute', { intentId: id, dryRun: true }), env });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.dryRun).toBe(true);
    expect(body.data.wouldExecute.userAddress).toBe('0x' + '5'.repeat(40));
    expect(body.data.wouldExecute.intentBytes32).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('GET /history filters + paginates stored intents', async () => {
    const env = makeEnv();
    for (let i = 0; i < 3; i++) {
      await createIntent({ request: post('https://app/api/core/v1/intents', { asset: 'usdc', amount: 10 + i, wallet: '0x' + '6'.repeat(40) }), env });
    }
    const res = await history({ request: get('https://app/api/core/v1/history?application=ELLIGENT&limit=2&page=1'), env });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items.length).toBe(2);
    expect(body.data.pagination.total).toBe(3);
    expect(body.data.pagination.totalPages).toBe(2);
    expect(body.data.pagination.hasNext).toBe(true);
    expect(body.data.filters.application).toBe('ELLIGENT');
  });

  it('GET /metrics aggregates ledger + intents', async () => {
    const env = makeEnv();
    await createIntent({ request: post('https://app/api/core/v1/intents', { asset: 'usdc', amount: 1000, wallet: '0x' + '7'.repeat(40) }), env });
    const res = await metrics({ request: get('https://app/api/core/v1/metrics'), env });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveProperty('totalVolume');
    expect(body.data).toHaveProperty('tvl');
    expect(body.data).toHaveProperty('outstandingLiquidity');
    expect(body.data).toHaveProperty('bridgeSuccessRate');
    expect(body.data).toHaveProperty('applicationBreakdown');
    expect(body.data.intentCount).toBeGreaterThanOrEqual(1);
  });

  it('GET /health reports all components (RPC stubbed)', async () => {
    const env = makeEnv();
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ result: '0x2a' }), { status: 200 }));
    const res = await health({ request: get('https://app/api/core/v1/health'), env });
    expect(res.status).toBe(200);
    const body = await res.json();
    assertEnvelope(body);
    expect(body.data.components).toHaveProperty('treasury');
    expect(body.data.components).toHaveProperty('vault');
    expect(body.data.components).toHaveProperty('relayer');
    expect(body.data.components).toHaveProperty('circle');
    expect(body.data.components).toHaveProperty('rpc');
    expect(body.data.components).toHaveProperty('kv');
    expect(body.data.components).toHaveProperty('workers');
    expect(body.data.components).toHaveProperty('bridgeEngine');
    expect(body.data.components.rpc.status).toBe('ok');
    expect(body.data.components.rpc.blockNumber).toBe(42);
  });

  it('GET /applications returns registry with masked secrets', async () => {
    const env = makeEnv();
    const res = await applications({ request: get('https://app/api/core/v1/applications'), env });
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.data.applications.map(a => a.applicationId);
    expect(ids).toContain('ELLIGENT');
    expect(ids).toContain('EXECDAAT');
    // No secret hash/salt should ever be present.
    for (const a of body.data.applications) {
      if (a.secret) { expect(a.secret.hash).toBeUndefined(); expect(a.secret.salt).toBeUndefined(); }
    }
  });
});
