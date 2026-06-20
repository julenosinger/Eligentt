import { describe, it, expect } from 'vitest';
import { checkRateLimit } from '../../functions/api/rate-limit.mjs';

function mockKV() {
  const s = new Map();
  return {
    async get(k) { return s.get(k) ?? null; },
    async put(k, v) { s.set(k, v); },
    _store: s,
  };
}

describe('5.6 — Rate Limit Bypass Tests', () => {
  it('ATTACK: burst 100 requests same IP same endpoint', async () => {
    const kv = mockKV();
    let blocked = 0;
    for (let i = 0; i < 100; i++) {
      const r = await checkRateLimit(kv, { identifier: '192.168.1.1', endpoint: 'relayer', limit: 20, windowMs: 60000 });
      if (!r.allowed) blocked++;
    }
    expect(blocked).toBe(80);
  });

  it('ATTACK: rotate endpoints to bypass', async () => {
    const kv = mockKV();
    for (let i = 0; i < 20; i++) {
      await checkRateLimit(kv, { identifier: 'ip1', endpoint: 'relayer', limit: 20, windowMs: 60000 });
    }
    const r1 = await checkRateLimit(kv, { identifier: 'ip1', endpoint: 'relayer', limit: 20, windowMs: 60000 });
    expect(r1.allowed).toBe(false);

    const r2 = await checkRateLimit(kv, { identifier: 'ip1', endpoint: 'mint', limit: 20, windowMs: 60000 });
    expect(r2.allowed).toBe(true);
  });

  it('ATTACK: same wallet different IPs', async () => {
    const kv = mockKV();
    for (let i = 0; i < 20; i++) {
      await checkRateLimit(kv, { identifier: '10.0.0.' + i, endpoint: 'relayer', limit: 20, windowMs: 60000 });
    }
    const r = await checkRateLimit(kv, { identifier: '10.0.0.99', endpoint: 'relayer', limit: 20, windowMs: 60000 });
    expect(r.allowed).toBe(true);
  });

  it('ATTACK: null KV graceful degradation', async () => {
    const r = await checkRateLimit(null, { identifier: 'ip', endpoint: 'test', limit: 5, windowMs: 60000 });
    expect(r.allowed).toBe(true);
  });

  it('PERSISTENCE: KV state survives across calls', async () => {
    const kv = mockKV();
    for (let i = 0; i < 15; i++) {
      await checkRateLimit(kv, { identifier: 'persist-test', endpoint: 'test', limit: 20, windowMs: 60000 });
    }
    const r = await checkRateLimit(kv, { identifier: 'persist-test', endpoint: 'test', limit: 20, windowMs: 60000 });
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(4);
  });
});

describe('5.8 — Nonce + Timestamp Stress Test', () => {
  it('STRESS: 1000 requests same nonce blocked', async () => {
    const { verifyRelayerAuth } = await import('../../functions/api/relayer-auth.mjs');
    const { ethers } = await import('ethers');
    const kv = mockKV();
    const wallet = ethers.Wallet.createRandom();
    const nonce = crypto.randomUUID();
    const timestamp = Date.now();
    const message = 'Elligentt Relayer Authorization\nTimestamp: ' + timestamp + '\nNonce: ' + nonce;
    const signature = await wallet.signMessage(message);
    const auth = { address: wallet.address, message, signature, timestamp, nonce };

    let accepted = 0;
    let rejected = 0;
    for (let i = 0; i < 1000; i++) {
      const r = await verifyRelayerAuth({ auth }, kv);
      if (r.valid) accepted++; else rejected++;
    }
    expect(accepted).toBe(1);
    expect(rejected).toBe(999);
  });

  it('STRESS: timestamp at exact boundary (300s)', async () => {
    const { verifyRelayerAuth } = await import('../../functions/api/relayer-auth.mjs');
    const { ethers } = await import('ethers');
    const kv = mockKV();
    const wallet = ethers.Wallet.createRandom();

    const edgeTimestamp = Date.now() - 299000;
    const nonce = crypto.randomUUID();
    const msg = 'Elligentt Relayer Authorization\nTimestamp: ' + edgeTimestamp + '\nNonce: ' + nonce;
    const sig = await wallet.signMessage(msg);
    const r = await verifyRelayerAuth({ auth: { address: wallet.address, message: msg, signature: sig, timestamp: edgeTimestamp, nonce } }, kv);
    expect(r.valid).toBe(true);
  });
});
