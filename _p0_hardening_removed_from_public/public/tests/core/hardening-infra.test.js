import { describe, it, expect } from 'vitest';
import { recordLatency, loadSamples, percentile, summarize } from '../../functions/api/core/latency.mjs';
import { withCache, getCached, setCached, isCacheable, CACHEABLE } from '../../functions/api/core/cache.mjs';
import * as breaker from '../../functions/api/core/circuit-breaker.mjs';

function mockKV() {
  const store = new Map();
  return {
    async get(k) { return store.get(k) ?? null; },
    async put(k, v) { store.set(k, v); },
    async list({ prefix = '', limit = 1000 } = {}) {
      return { keys: Array.from(store.keys()).filter(k => k.startsWith(prefix)).slice(0, limit).map(name => ({ name })) };
    },
  };
}

describe('Core hardening — latency & percentiles', () => {
  it('computes percentiles', () => {
    const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(ms => ({ ms, t: Date.now(), ok: true }));
    expect(percentile(samples, 50)).toBeGreaterThan(0);
    expect(percentile(samples, 99)).toBe(100);
    const s = summarize(samples);
    expect(s.p50).toBeLessThanOrEqual(s.p95);
    expect(s.p95).toBeLessThanOrEqual(s.p99);
    expect(s.averageLatency).toBeGreaterThan(0);
    expect(s.errorRate).toBe(0);
  });
  it('records and reads back samples via KV', async () => {
    const env = { CORE_KV: mockKV() };
    await recordLatency(env, '/api/core/v1/quote', 25, { status: 200 });
    await recordLatency(env, '/api/core/v1/quote', 75, { status: 500, error: true });
    const global = await loadSamples(env, 'global');
    expect(global.length).toBe(2);
    const s = summarize(global);
    expect(s.errorRate).toBeGreaterThan(0);
  });
});

describe('Core hardening — intelligent cache', () => {
  it('only allows metrics/health/applications', () => {
    expect(isCacheable('metrics')).toBe(true);
    expect(isCacheable('health')).toBe(true);
    expect(isCacheable('applications')).toBe(true);
    expect(isCacheable('execute')).toBe(false);
    expect(isCacheable('history')).toBe(false);
    expect(isCacheable('intent')).toBe(false);
    expect(Object.keys(CACHEABLE).sort()).toEqual(['applications', 'health', 'metrics']);
  });
  it('read-through caches cacheable endpoints', async () => {
    const env = { CORE_KV: mockKV() };
    let calls = 0;
    const compute = async () => { calls++; return { v: calls }; };
    const a = await withCache(env, 'metrics', 'all', compute);
    const b = await withCache(env, 'metrics', 'all', compute);
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(calls).toBe(1);
    expect(b.data.v).toBe(1);
  });
  it('never caches non-cacheable endpoints', async () => {
    const env = { CORE_KV: mockKV() };
    let calls = 0;
    await withCache(env, 'execute', 'x', async () => { calls++; return 1; });
    await withCache(env, 'execute', 'x', async () => { calls++; return 1; });
    expect(calls).toBe(2);
    expect(await getCached(env, 'execute', 'x')).toBeNull();
    expect(await setCached(env, 'execute', 'x', {})).toBe(false);
  });
});

describe('Core hardening — circuit breaker', () => {
  it('opens after the failure threshold and fails fast', async () => {
    const env = { CORE_KV: mockKV() };
    for (let i = 0; i < 5; i++) await breaker.recordFailure(env, 'rpc', 'boom');
    const c = await breaker.check(env, 'rpc');
    expect(c.allowed).toBe(false);
    expect(c.state).toBe('open');
    const snap = await breaker.snapshot(env);
    expect(snap.rpc.state).toBe('open');
  });
  it('closes on success', async () => {
    const env = { CORE_KV: mockKV() };
    await breaker.recordFailure(env, 'circle', 'x');
    await breaker.recordSuccess(env, 'circle');
    const c = await breaker.check(env, 'circle');
    expect(c.allowed).toBe(true);
    expect(c.state).toBe('closed');
  });
  it('guard throws a fail-fast error when open', async () => {
    const env = { CORE_KV: mockKV() };
    for (let i = 0; i < 5; i++) await breaker.recordFailure(env, 'vault', 'x');
    await expect(breaker.guard(env, 'vault', async () => 'should not run')).rejects.toMatchObject({ circuitOpen: true, dependency: 'vault' });
  });
  it('guard runs and records success when closed', async () => {
    const env = { CORE_KV: mockKV() };
    const v = await breaker.guard(env, 'treasury', async () => 42);
    expect(v).toBe(42);
    const c = await breaker.check(env, 'treasury');
    expect(c.allowed).toBe(true);
  });
});
