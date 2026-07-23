import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkRateLimit } from '../functions/api/rate-limit.mjs';

function createMockKV() {
  const store = new Map();
  return {
    async get(key) { return store.get(key) ?? null; },
    async put(key, value, opts) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    _store: store,
  };
}

describe('KV-backed Rate Limiter', () => {
  let kv;

  beforeEach(() => {
    kv = createMockKV();
  });

  it('allows requests within limit', async () => {
    const result = await checkRateLimit(kv, {
      identifier: '127.0.0.1',
      endpoint: 'test',
      limit: 5,
      windowMs: 60000,
    });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it('blocks after limit exceeded', async () => {
    for (let i = 0; i < 5; i++) {
      await checkRateLimit(kv, { identifier: 'ip1', endpoint: 'test', limit: 5, windowMs: 60000 });
    }
    const result = await checkRateLimit(kv, { identifier: 'ip1', endpoint: 'test', limit: 5, windowMs: 60000 });
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('separates identifiers', async () => {
    for (let i = 0; i < 5; i++) {
      await checkRateLimit(kv, { identifier: 'ip1', endpoint: 'test', limit: 5, windowMs: 60000 });
    }
    const result = await checkRateLimit(kv, { identifier: 'ip2', endpoint: 'test', limit: 5, windowMs: 60000 });
    expect(result.allowed).toBe(true);
  });

  it('separates endpoints', async () => {
    for (let i = 0; i < 5; i++) {
      await checkRateLimit(kv, { identifier: 'ip1', endpoint: 'ep1', limit: 5, windowMs: 60000 });
    }
    const result = await checkRateLimit(kv, { identifier: 'ip1', endpoint: 'ep2', limit: 5, windowMs: 60000 });
    expect(result.allowed).toBe(true);
  });

  it('allows requests when KV is null', async () => {
    const result = await checkRateLimit(null, { identifier: 'ip', endpoint: 'test', limit: 5, windowMs: 60000 });
    expect(result.allowed).toBe(true);
  });

  it('tracks remaining count correctly', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await checkRateLimit(kv, { identifier: 'ip', endpoint: 'test', limit: 5, windowMs: 60000 });
      expect(r.remaining).toBe(5 - (i + 1));
    }
  });
});
