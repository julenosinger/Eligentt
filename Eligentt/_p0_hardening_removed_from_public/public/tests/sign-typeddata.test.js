import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { onRequestPost } from '../functions/api/auth/sign.js';

const AUTH_SECRET = 'test-secret-phase25';
const subtle = globalThis.crypto.subtle;

// Mirror functions/api/auth/verify.js v2 encryption so we can build a custodial wallet.
async function deriveKey(secret, saltStr) {
  const enc = new TextEncoder();
  const material = await subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(saltStr), iterations: 100000, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

async function encryptV2(plaintext, secret, saltStr) {
  const enc = new TextEncoder();
  const key = await deriveKey(secret, saltStr);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  return JSON.stringify({ iv: Array.from(iv), ct: Array.from(new Uint8Array(cipher)), salt: saltStr, version: 2 });
}

function mockKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    async get(k) { return store.get(k) ?? null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
}

async function makeEnv(wallet) {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
  const email = 'user@example.com';
  const encryptedKey = await encryptV2(wallet.privateKey, AUTH_SECRET, 'usersalt123');
  const kv = mockKV({
    [`session:${token}`]: JSON.stringify({ email }),
    [`user:${email}`]: JSON.stringify({ wallet: { address: wallet.address, encryptedKey } }),
  });
  return { token, env: { AUTH_KV: kv, AUTH_SECRET, ARC_RPC_URL: 'https://rpc.testnet.arc.network' } };
}

function makeRequest(token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  return new Request('https://app.local/api/auth/sign', { method: 'POST', headers, body: JSON.stringify(body) });
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

describe('Commit C — custodial signTypedData', () => {
  it('signTypedData returns a signature that recovers the correct address', async () => {
    const wallet = ethers.Wallet.createRandom();
    const { token, env } = await makeEnv(wallet);

    const value = {
      user: wallet.address,
      intentId: '0x' + 'ab'.repeat(32),
      grossAmount: '1000000',
      feeAmount: '20000',
      nonce: '1',
      deadline: String(Date.now() + 120000),
    };

    const res = await onRequestPost({ request: makeRequest(token, { action: 'signTypedData', domain: DOMAIN, types: TYPES, value }), env });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(typeof data.signature).toBe('string');

    const recovered = ethers.verifyTypedData(DOMAIN, TYPES, value, data.signature);
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('signMessage still works unchanged (compatibility)', async () => {
    const wallet = ethers.Wallet.createRandom();
    const { token, env } = await makeEnv(wallet);
    const res = await onRequestPost({ request: makeRequest(token, { action: 'signMessage', message: 'hello' }), env });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(ethers.verifyMessage('hello', data.signature).toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('invalid session fails with 401', async () => {
    const wallet = ethers.Wallet.createRandom();
    const { env } = await makeEnv(wallet);
    const badToken = '0'.repeat(64);
    const res = await onRequestPost({ request: makeRequest(badToken, { action: 'signTypedData', domain: DOMAIN, types: TYPES, value: {} }), env });
    expect(res.status).toBe(401);
  });

  it('unknown action fails with 400', async () => {
    const wallet = ethers.Wallet.createRandom();
    const { token, env } = await makeEnv(wallet);
    const res = await onRequestPost({ request: makeRequest(token, { action: 'doEvilThing' }), env });
    expect(res.status).toBe(400);
  });
});
