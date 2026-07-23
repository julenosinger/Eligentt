import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { verifyRelayerAuth } from '../functions/api/relayer-auth.mjs';

function createMockKV() {
  const store = new Map();
  return {
    async get(key) { return store.get(key) ?? null; },
    async put(key, value, opts) { store.set(key, value); },
  };
}

async function createValidAuth(wallet) {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  const timestamp = Date.now();
  const message = 'Elligentt Relayer Authorization\nTimestamp: ' + timestamp + '\nNonce: ' + nonce;
  const signature = await wallet.signMessage(message);
  return { address: wallet.address, message, signature, timestamp, nonce };
}

describe('Relayer Signature Auth', () => {
  const wallet = ethers.Wallet.createRandom();
  let kv;

  it('accepts valid signature', async () => {
    kv = createMockKV();
    const auth = await createValidAuth(wallet);
    const result = await verifyRelayerAuth({ auth }, kv);
    expect(result.valid).toBe(true);
    expect(result.address.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('rejects missing auth object', async () => {
    const result = await verifyRelayerAuth({}, null);
    expect(result.valid).toBe(false);
  });

  it('rejects invalid signature', async () => {
    kv = createMockKV();
    const auth = await createValidAuth(wallet);
    auth.signature = '0x' + '00'.repeat(65);
    const result = await verifyRelayerAuth({ auth }, kv);
    expect(result.valid).toBe(false);
  });

  it('rejects wrong address', async () => {
    kv = createMockKV();
    const auth = await createValidAuth(wallet);
    auth.address = ethers.Wallet.createRandom().address;
    const result = await verifyRelayerAuth({ auth }, kv);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('does not match');
  });

  it('rejects expired timestamp', async () => {
    kv = createMockKV();
    const auth = await createValidAuth(wallet);
    auth.timestamp = Date.now() - 600000;
    auth.message = 'Elligentt Relayer Authorization\nTimestamp: ' + auth.timestamp + '\nNonce: ' + auth.nonce;
    auth.signature = await wallet.signMessage(auth.message);
    const result = await verifyRelayerAuth({ auth }, kv);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('expired');
  });

  it('rejects replay (same nonce)', async () => {
    kv = createMockKV();
    const auth = await createValidAuth(wallet);
    const r1 = await verifyRelayerAuth({ auth }, kv);
    expect(r1.valid).toBe(true);
    const r2 = await verifyRelayerAuth({ auth }, kv);
    expect(r2.valid).toBe(false);
    expect(r2.error).toContain('replay');
  });

  it('rejects wrong message prefix', async () => {
    kv = createMockKV();
    const message = 'Wrong Prefix\nTimestamp: ' + Date.now() + '\nNonce: abc';
    const signature = await wallet.signMessage(message);
    const result = await verifyRelayerAuth({
      auth: { address: wallet.address, message, signature, timestamp: Date.now(), nonce: 'abc' }
    }, kv);
    expect(result.valid).toBe(false);
  });
});
