import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { verifyRelayerAuth } from '../../functions/api/relayer-auth.mjs';

function mockKV() {
  const s = new Map();
  return { async get(k) { return s.get(k) ?? null; }, async put(k, v, o) { s.set(k, v); } };
}

async function validAuth(wallet) {
  const nonce = crypto.randomUUID();
  const timestamp = Date.now();
  const message = 'Elligentt Relayer Authorization\nTimestamp: ' + timestamp + '\nNonce: ' + nonce;
  const signature = await wallet.signMessage(message);
  return { address: wallet.address, message, signature, timestamp, nonce };
}

describe('5.2 — Relayer Exploit Tests', () => {
  const wallet = ethers.Wallet.createRandom();
  const attacker = ethers.Wallet.createRandom();

  it('ATTACK: replay same signature twice', async () => {
    const kv = mockKV();
    const auth = await validAuth(wallet);
    const r1 = await verifyRelayerAuth({ auth }, kv);
    expect(r1.valid).toBe(true);
    const r2 = await verifyRelayerAuth({ auth }, kv);
    expect(r2.valid).toBe(false);
    expect(r2.error).toContain('replay');
  });

  it('ATTACK: tampered message body', async () => {
    const kv = mockKV();
    const auth = await validAuth(wallet);
    auth.message = auth.message.replace(/Nonce: \w+/, 'Nonce: tampered');
    const r = await verifyRelayerAuth({ auth }, kv);
    expect(r.valid).toBe(false);
  });

  it('ATTACK: stolen signature + wrong address', async () => {
    const kv = mockKV();
    const auth = await validAuth(wallet);
    auth.address = attacker.address;
    const r = await verifyRelayerAuth({ auth }, kv);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('does not match');
  });

  it('ATTACK: forged signature bytes', async () => {
    const kv = mockKV();
    const auth = await validAuth(wallet);
    auth.signature = '0x' + 'ff'.repeat(65);
    const r = await verifyRelayerAuth({ auth }, kv);
    expect(r.valid).toBe(false);
  });

  it('ATTACK: timestamp 10 minutes ago', async () => {
    const kv = mockKV();
    const old = Date.now() - 600000;
    const nonce = crypto.randomUUID();
    const msg = 'Elligentt Relayer Authorization\nTimestamp: ' + old + '\nNonce: ' + nonce;
    const sig = await wallet.signMessage(msg);
    const r = await verifyRelayerAuth({ auth: { address: wallet.address, message: msg, signature: sig, timestamp: old, nonce } }, kv);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('expired');
  });

  it('ATTACK: timestamp 10 minutes in the future', async () => {
    const kv = mockKV();
    const future = Date.now() + 600000;
    const nonce = crypto.randomUUID();
    const msg = 'Elligentt Relayer Authorization\nTimestamp: ' + future + '\nNonce: ' + nonce;
    const sig = await wallet.signMessage(msg);
    const r = await verifyRelayerAuth({ auth: { address: wallet.address, message: msg, signature: sig, timestamp: future, nonce } }, kv);
    expect(r.valid).toBe(false);
  });

  it('ATTACK: wrong message prefix', async () => {
    const kv = mockKV();
    const msg = 'EVIL Relayer Authorization\nTimestamp: ' + Date.now() + '\nNonce: x';
    const sig = await wallet.signMessage(msg);
    const r = await verifyRelayerAuth({ auth: { address: wallet.address, message: msg, signature: sig, timestamp: Date.now(), nonce: 'x' } }, kv);
    expect(r.valid).toBe(false);
  });

  it('ATTACK: empty auth object', async () => {
    const r = await verifyRelayerAuth({ auth: {} }, null);
    expect(r.valid).toBe(false);
  });

  it('ATTACK: null body', async () => {
    const r = await verifyRelayerAuth(null, null);
    expect(r.valid).toBe(false);
  });

  it('ATTACK: auth without body wrapper', async () => {
    const r = await verifyRelayerAuth({}, null);
    expect(r.valid).toBe(false);
  });

  it('VALID: legitimate request passes', async () => {
    const kv = mockKV();
    const auth = await validAuth(wallet);
    const r = await verifyRelayerAuth({ auth }, kv);
    expect(r.valid).toBe(true);
    expect(r.address.toLowerCase()).toBe(wallet.address.toLowerCase());
  });
});
