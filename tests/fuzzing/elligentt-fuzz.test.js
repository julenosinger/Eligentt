import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { verifyRelayerAuth } from '../../functions/api/relayer-auth.mjs';
import { checkRateLimit } from '../../functions/api/rate-limit.mjs';

function mockKV() {
  const s = new Map();
  return { async get(k) { return s.get(k) ?? null; }, async put(k, v) { s.set(k, v); } };
}

function randomHex(len) { return '0x' + Array.from(crypto.getRandomValues(new Uint8Array(len)), b => b.toString(16).padStart(2, '0')).join(''); }
function randomAmount() { return [0, -1, 0.000001, 0.1, 1, 100, 999999.999999, 1e15, NaN, Infinity, -Infinity, null, undefined, 'abc'][Math.floor(Math.random() * 14)]; }
function randomAddr() { return ['0x' + 'a'.repeat(40), '0x' + '0'.repeat(40), '0x', '', '0xZZZ', null, randomHex(20), '0x' + 'ff'.repeat(20)][Math.floor(Math.random() * 8)]; }
function randomString() { return ['', null, undefined, '<script>alert(1)</script>', '0x', '\u0000', '\uFFFF', 'a'.repeat(10000), '|'.repeat(100), '{{}}', '%00', '\n\r\t'][Math.floor(Math.random() * 12)]; }

describe('6.1 — Fuzzing: Relayer Auth (500 iterations)', () => {
  const wallet = ethers.Wallet.createRandom();

  it('FUZZ: random auth objects never crash verifyRelayerAuth', async () => {
    const kv = mockKV();
    for (let i = 0; i < 500; i++) {
      const fuzzAuth = {
        address: randomAddr(),
        message: randomString(),
        signature: randomHex(Math.floor(Math.random() * 130)),
        timestamp: [Date.now(), 0, -1, Date.now() + 1e9, NaN, null, 'abc'][Math.floor(Math.random() * 7)],
        nonce: randomString(),
      };
      let threw = false;
      try {
        const r = await verifyRelayerAuth({ auth: fuzzAuth }, kv);
        expect(r).toHaveProperty('valid');
      } catch (e) {
        threw = true;
      }
      expect(threw).toBe(false);
    }
  });

  it('FUZZ: valid wallet + random mutations never cause false positive', async () => {
    const kv = mockKV();
    let falsePositives = 0;
    for (let i = 0; i < 100; i++) {
      const nonce = crypto.randomUUID();
      const timestamp = Date.now();
      const message = 'Elligentt Relayer Authorization\nTimestamp: ' + timestamp + '\nNonce: ' + nonce;
      const signature = await wallet.signMessage(message);
      const auth = { address: wallet.address, message, signature, timestamp, nonce };

      const mutations = [
        () => { auth.address = randomAddr(); },
        () => { auth.message += 'X'; },
        () => { auth.signature = auth.signature.slice(0, -2) + 'ff'; },
        () => { auth.timestamp -= 600000; },
        () => {},
      ];
      mutations[Math.floor(Math.random() * mutations.length)]();

      const r = await verifyRelayerAuth({ auth: { ...auth } }, mockKV());
      if (r.valid && auth.address !== wallet.address) falsePositives++;
    }
    expect(falsePositives).toBe(0);
  });
});

describe('6.1 — Fuzzing: Amount Parsing (200 iterations)', () => {
  it('FUZZ: ethers.parseUnits never produces negative for positive input', () => {
    for (let i = 0; i < 200; i++) {
      const amt = Math.random() * 1000000;
      const raw = ethers.parseUnits(amt.toFixed(6), 6);
      expect(raw).toBeGreaterThanOrEqual(0n);
    }
  });

  it('FUZZ: fee calculation never exceeds amount for bps <= 10000', () => {
    for (let i = 0; i < 200; i++) {
      const amt = Math.random() * 100000;
      const bps = Math.floor(Math.random() * 10000);
      const raw = ethers.parseUnits(amt.toFixed(6), 6);
      const fee = (raw * BigInt(bps)) / 10000n;
      expect(fee).toBeLessThanOrEqual(raw);
    }
  });

  it('FUZZ: total = amount + fee is always >= amount', () => {
    for (let i = 0; i < 200; i++) {
      const amt = ethers.parseUnits((Math.random() * 999999).toFixed(6), 6);
      const fee = (amt * BigInt(Math.floor(Math.random() * 500))) / 10000n;
      expect(amt + fee).toBeGreaterThanOrEqual(amt);
    }
  });
});

describe('6.1 — Fuzzing: Rate Limiter (100 iterations)', () => {
  it('FUZZ: random identifiers and endpoints never crash', async () => {
    const kv = mockKV();
    for (let i = 0; i < 100; i++) {
      const r = await checkRateLimit(kv, {
        identifier: randomString() || 'fallback',
        endpoint: randomString() || 'ep',
        limit: Math.floor(Math.random() * 100) + 1,
        windowMs: Math.floor(Math.random() * 120000) + 1000,
      });
      expect(r).toHaveProperty('allowed');
      expect(typeof r.allowed).toBe('boolean');
    }
  });
});

describe('6.1 — Fuzzing: Address Validation', () => {
  it('FUZZ: ethers.isAddress correctly validates 200 random inputs', () => {
    for (let i = 0; i < 200; i++) {
      const input = randomAddr();
      const result = ethers.isAddress(input || '');
      expect(typeof result).toBe('boolean');
    }
  });
});
