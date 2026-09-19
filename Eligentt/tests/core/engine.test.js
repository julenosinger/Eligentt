import { describe, it, expect } from 'vitest';
import { getQuote } from '../../functions/api/core/quote-engine.mjs';
import { recordUsage } from '../../functions/api/core/rate-limit.mjs';
import { validateCreateIntent, validateQuote, validateExecute, validateHistoryQuery } from '../../functions/api/core/validation.mjs';

function mockKV() {
  const store = new Map();
  return {
    async get(k) { return store.get(k) ?? null; },
    async put(k, v) { store.set(k, v); },
  };
}

describe('Core API — quote engine', () => {
  it('selects Turbo for small amounts and applies the turbo fee', () => {
    const q = getQuote({ token: 'usdc', amount: 100 });
    expect(q.bridge).toBe('Turbo');
    expect(q.feeBps).toBe(100);
    expect(q.fee).toBeCloseTo(1, 6);       // 1% of 100
    expect(q.receive).toBeCloseTo(99, 6);
    expect(q.provider).toBe('Circle CCTP');
    expect(q.slippage).toBe(0);
    expect(q.destChain).toBe('Arc_Testnet');
    expect(q.liquidityAvailable).toBeGreaterThan(0);
  });

  it('selects Standard for large amounts', () => {
    const q = getQuote({ token: 'usdc', amount: 100000 });
    expect(q.bridge).toBe('Standard');
    expect(q.feeBps).toBe(5); // 0.0005 * 10000
  });

  it('resolves named source/destination chains', () => {
    const q = getQuote({ token: 'usdc', amount: 10, sourceChain: '11155111', destChain: '5042002' });
    expect(q.sourceChain).toBe('Ethereum_Sepolia');
    expect(q.destChain).toBe('Arc_Testnet');
    expect(q.eta.display).toBeTruthy();
  });
});

describe('Core API — rate limit (record only)', () => {
  it('records usage and NEVER blocks', async () => {
    const env = { CORE_KV: mockKV() };
    const r1 = await recordUsage(env, { application: 'ELLIGENT', client: 'default', endpoint: '/x', kind: 'request' });
    expect(r1.blocked).toBe(false);
    expect(r1.enforced).toBe(false);
    expect(r1.count).toBe(1);
    const r2 = await recordUsage(env, { application: 'ELLIGENT', client: 'default', endpoint: '/x', kind: 'request' });
    expect(r2.count).toBe(2);
    expect(r2.blocked).toBe(false);
  });

  it('reports exceeded (informational) without blocking', async () => {
    const env = { CORE_KV: mockKV(), _appRecord: { rateLimits: { requestsPerMin: 1 } } };
    await recordUsage(env, { application: 'A', client: 'c', endpoint: '/y', kind: 'request' });
    const r = await recordUsage(env, { application: 'A', client: 'c', endpoint: '/y', kind: 'request' });
    expect(r.exceeded).toBe(true);
    expect(r.blocked).toBe(false);
  });
});

describe('Core API — validation', () => {
  it('validates create-intent input', () => {
    const good = validateCreateIntent({ asset: 'USDC', amount: 100, wallet: '0x' + '1'.repeat(40) });
    expect(good.valid).toBe(true);
    expect(good.value.asset).toBe('usdc');
    const bad = validateCreateIntent({ asset: 'xxx', amount: -1, wallet: 'nope' });
    expect(bad.valid).toBe(false);
    expect(bad.errors.length).toBeGreaterThanOrEqual(3);
  });

  it('validates quote input', () => {
    expect(validateQuote({ token: 'usdc', amount: 5 }).valid).toBe(true);
    expect(validateQuote({ token: 'usdc' }).valid).toBe(false);
  });

  it('validates execute input', () => {
    expect(validateExecute({ intentId: 'INT-1' }).valid).toBe(true);
    expect(validateExecute({}).valid).toBe(false);
    expect(validateExecute({ intentId: 'INT-1', intentBytes32: '0xbad' }).valid).toBe(false);
  });

  it('normalizes history query with pagination + sorting defaults', () => {
    const v = validateHistoryQuery(new URLSearchParams('application=execdaat&limit=1000&order=asc'));
    expect(v.value.application).toBe('EXECDAAT');
    expect(v.value.limit).toBe(200);   // capped
    expect(v.value.order).toBe('asc');
    expect(v.value.page).toBe(1);
  });
});
