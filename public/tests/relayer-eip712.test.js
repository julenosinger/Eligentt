import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { verifyRelayerAuth } from '../functions/api/relayer-auth.mjs';

function mockKV() {
  const s = new Map();
  return { async get(k) { return s.get(k) ?? null; }, async put(k, v) { s.set(k, v); } };
}

const DOMAIN = { name: 'Elligentt', version: '1', chainId: 5042002 };
const TYPES = {
  Authorization: [
    { name: 'user', type: 'address' },
    { name: 'intentId', type: 'bytes32' },
    { name: 'grossAmount', type: 'uint256' },
    { name: 'feeAmount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

// Mirrors the auth object produced by index.html _signRelayerAuth (scheme:'eip712').
async function buildEip712Auth(wallet, overrides = {}) {
  const value = {
    user: wallet.address,
    intentId: '0x' + 'cd'.repeat(32),
    grossAmount: '1000000',
    feeAmount: '20000',
    nonce: Date.now() * 1000 + Math.floor(Math.random() * 1000),
    deadline: Date.now() + 240000,
    ...overrides,
  };
  const signature = await wallet.signTypedData(DOMAIN, TYPES, value);
  return { scheme: 'eip712', authType: 'eip712', ...value, signature };
}

describe('Commit D — relayer EIP-712 verification', () => {
  it('accepts a valid EIP-712 authorization', async () => {
    const wallet = ethers.Wallet.createRandom();
    const auth = await buildEip712Auth(wallet);
    const r = await verifyRelayerAuth({ auth }, mockKV());
    expect(r.valid).toBe(true);
    expect(r.address.toLowerCase()).toBe(wallet.address.toLowerCase());
    expect(r.scheme).toBe('eip712');
  });

  it('rejects a tampered authorization (amount changed after signing)', async () => {
    const wallet = ethers.Wallet.createRandom();
    const auth = await buildEip712Auth(wallet);
    auth.grossAmount = '999999999'; // tamper
    const r = await verifyRelayerAuth({ auth }, mockKV());
    expect(r.valid).toBe(false);
  });

  it('rejects a reused nonce (replay)', async () => {
    const wallet = ethers.Wallet.createRandom();
    const kv = mockKV();
    const auth = await buildEip712Auth(wallet);
    const r1 = await verifyRelayerAuth({ auth }, kv);
    expect(r1.valid).toBe(true);
    const r2 = await verifyRelayerAuth({ auth }, kv);
    expect(r2.valid).toBe(false);
    expect(r2.error).toContain('replay');
  });

  it('rejects an expired deadline', async () => {
    const wallet = ethers.Wallet.createRandom();
    const auth = await buildEip712Auth(wallet, { deadline: Date.now() - 1000 });
    const r = await verifyRelayerAuth({ auth }, mockKV());
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('deadline_expired');
  });

  it('rejects a different user (signature A, user B)', async () => {
    const signerA = ethers.Wallet.createRandom();
    const userB = ethers.Wallet.createRandom();
    const auth = await buildEip712Auth(signerA);
    auth.user = userB.address; // claim a different user
    const r = await verifyRelayerAuth({ auth }, mockKV());
    expect(r.valid).toBe(false);
  });

  it('legacy personal_sign still works (no regression)', async () => {
    const wallet = ethers.Wallet.createRandom();
    const nonce = crypto.randomUUID();
    const timestamp = Date.now();
    const message = 'Elligentt Relayer Authorization\nTimestamp: ' + timestamp + '\nNonce: ' + nonce;
    const signature = await wallet.signMessage(message);
    const r = await verifyRelayerAuth({ auth: { address: wallet.address, message, signature, timestamp, nonce } }, mockKV());
    expect(r.valid).toBe(true);
    expect(r.scheme).toBe('legacy');
  });
});
