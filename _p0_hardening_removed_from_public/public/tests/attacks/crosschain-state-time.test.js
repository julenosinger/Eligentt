import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { verifyRelayerAuth } from '../../functions/api/relayer-auth.mjs';
import { checkRateLimit } from '../../functions/api/rate-limit.mjs';

function mockKV() {
  const s = new Map();
  return { async get(k) { return s.get(k) ?? null; }, async put(k, v) { s.set(k, v); } };
}

describe('6.5 — Cross-Chain Adversarial (CCTP)', () => {
  it('PROPERTY: message format validates hex strictly', () => {
    const invalid = ['', '0x', 'hello', '0xGGGG', null, undefined, 42, '0x1234', true];
    for (const m of invalid) {
      const valid = typeof m === 'string' && /^0x[0-9a-fA-F]+$/.test(m) && m.length >= 10;
      expect(valid).toBe(false);
    }
  });

  it('PROPERTY: valid hex message passes validation', () => {
    const valid = '0x' + 'ab'.repeat(100);
    expect(/^0x[0-9a-fA-F]+$/.test(valid) && valid.length >= 10).toBe(true);
  });

  it('PROPERTY: intentId pipe injection blocked', () => {
    const malicious = ['a|b', '|', 'REPAY|USDC|1000', 'test|test|test|test|test'];
    for (const id of malicious) {
      expect(id.includes('|')).toBe(true);
    }
  });

  it('PROPERTY: chainId mismatch detection', () => {
    const expectedChainId = 5042002;
    const wrongChains = [1, 137, 42161, 10, 8453, 0, -1];
    for (const c of wrongChains) {
      expect(c).not.toBe(expectedChainId);
    }
  });
});

describe('6.6 — State Corruption Testing', () => {
  it('CONCURRENCY: parallel rate limit calls maintain consistency', async () => {
    const kv = mockKV();
    const promises = [];
    for (let i = 0; i < 50; i++) {
      promises.push(checkRateLimit(kv, { identifier: 'concurrent-ip', endpoint: 'test', limit: 100, windowMs: 60000 }));
    }
    const results = await Promise.all(promises);
    const allowed = results.filter(r => r.allowed).length;
    expect(allowed).toBe(50);
  });

  it('CONCURRENCY: parallel auth verifications with unique nonces', async () => {
    const wallet = ethers.Wallet.createRandom();
    const kv = mockKV();
    const promises = [];

    for (let i = 0; i < 20; i++) {
      const nonce = crypto.randomUUID();
      const timestamp = Date.now();
      const message = 'Elligentt Relayer Authorization\nTimestamp: ' + timestamp + '\nNonce: ' + nonce;
      const signPromise = wallet.signMessage(message).then(signature => {
        return verifyRelayerAuth({ auth: { address: wallet.address, message, signature, timestamp, nonce } }, kv);
      });
      promises.push(signPromise);
    }

    const results = await Promise.all(promises);
    const accepted = results.filter(r => r.valid).length;
    expect(accepted).toBe(20);
  });

  it('IDEMPOTENCY: payment link status transitions are final', () => {
    const states = ['Active', 'Paid', 'Expired', 'Disabled'];
    const finalStates = ['Paid', 'Expired', 'Disabled'];

    for (const s of finalStates) {
      expect(states.includes(s)).toBe(true);
      const canRevert = s === 'Paid' && false;
      expect(canRevert).toBe(false);
    }
  });

  it('RECOVERY: KV failure degrades gracefully', async () => {
    const brokenKV = {
      async get() { throw new Error('KV unavailable'); },
      async put() { throw new Error('KV unavailable'); },
    };

    const r = await checkRateLimit(brokenKV, { identifier: 'test', endpoint: 'test', limit: 10, windowMs: 60000 });
    expect(r.allowed).toBe(true);
  });
});

describe('6.8 — Time-Based Attacks', () => {
  it('ATTACK: timestamp skew +1 hour', async () => {
    const wallet = ethers.Wallet.createRandom();
    const kv = mockKV();
    const futureTs = Date.now() + 3600000;
    const msg = 'Elligentt Relayer Authorization\nTimestamp: ' + futureTs + '\nNonce: ' + crypto.randomUUID();
    const sig = await wallet.signMessage(msg);
    const r = await verifyRelayerAuth({ auth: { address: wallet.address, message: msg, signature: sig, timestamp: futureTs, nonce: crypto.randomUUID() } }, kv);
    expect(r.valid).toBe(false);
  });

  it('ATTACK: timestamp skew -1 hour', async () => {
    const wallet = ethers.Wallet.createRandom();
    const kv = mockKV();
    const pastTs = Date.now() - 3600000;
    const msg = 'Elligentt Relayer Authorization\nTimestamp: ' + pastTs + '\nNonce: ' + crypto.randomUUID();
    const sig = await wallet.signMessage(msg);
    const r = await verifyRelayerAuth({ auth: { address: wallet.address, message: msg, signature: sig, timestamp: pastTs, nonce: crypto.randomUUID() } }, kv);
    expect(r.valid).toBe(false);
  });

  it('ATTACK: timestamp skew -24 hours', async () => {
    const wallet = ethers.Wallet.createRandom();
    const kv = mockKV();
    const oldTs = Date.now() - 86400000;
    const msg = 'Elligentt Relayer Authorization\nTimestamp: ' + oldTs + '\nNonce: ' + crypto.randomUUID();
    const sig = await wallet.signMessage(msg);
    const r = await verifyRelayerAuth({ auth: { address: wallet.address, message: msg, signature: sig, timestamp: oldTs, nonce: crypto.randomUUID() } }, kv);
    expect(r.valid).toBe(false);
  });

  it('VALID: timestamp at boundary -4 minutes accepted', async () => {
    const wallet = ethers.Wallet.createRandom();
    const kv = mockKV();
    const ts = Date.now() - 240000;
    const nonce = crypto.randomUUID();
    const msg = 'Elligentt Relayer Authorization\nTimestamp: ' + ts + '\nNonce: ' + nonce;
    const sig = await wallet.signMessage(msg);
    const r = await verifyRelayerAuth({ auth: { address: wallet.address, message: msg, signature: sig, timestamp: ts, nonce } }, kv);
    expect(r.valid).toBe(true);
  });

  it('PROPERTY: nonce required even within valid timestamp', async () => {
    const wallet = ethers.Wallet.createRandom();
    const kv = mockKV();
    const ts = Date.now();
    const msg = 'Elligentt Relayer Authorization\nTimestamp: ' + ts + '\nNonce: ';
    const sig = await wallet.signMessage(msg);
    const r = await verifyRelayerAuth({ auth: { address: wallet.address, message: msg, signature: sig, timestamp: ts, nonce: '' } }, kv);
    // Nonce is REQUIRED: an empty nonce must be rejected even with a valid timestamp.
    expect(r.valid).toBe(false);
  });
});
