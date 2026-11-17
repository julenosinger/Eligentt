/**
 * Gateway Send 3.0 — attestation binding + balance shape regression tests
 * ═══════════════════════════════════════════════════════════════════════════════
 * Exercises the REAL GatewaySpendService exports:
 *   - verifyEchoedBurnIntent (P0.2): the Circle /v1/transfer response's echoed
 *     BurnIntent must match the submitted intent (salt + all critical fields).
 *   - prepare() against the actual /api/gateway/balances response shape
 *     ({ USDC, EURC, cirBTC }) as well as the historical { assets } shape.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import GatewaySpendService from '../shared/GatewaySpendService.js';

const { verifyEchoedBurnIntent, prepare, buildBurnIntent, maxFeeFor } = GatewaySpendService;

const ADDR_A = '0x1234567890123456789012345678901234567890';
const ADDR_B = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const ADDR_C = '0xCCCCccccCCCCcCCCCCCcCcCCCcCCCCcCCCCcCCcc';
const SALT = '0x' + '12'.repeat(32);

function pad32(a) { return '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0'); }

function spec(over = {}) {
  return {
    version:              1,
    sourceDomain:         26,
    destinationDomain:    0,
    sourceContract:       pad32('0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE'),
    destinationContract:  pad32('0x2222222d7164433c4C09B0b0D809a9b52C04C205'),
    sourceToken:          pad32('0x3600000000000000000000000000000000000000'),
    destinationToken:     pad32('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
    sourceDepositor:      pad32(ADDR_A),
    destinationRecipient: pad32(ADDR_B),
    sourceSigner:         pad32(ADDR_A),
    destinationCaller:    pad32('0x0000000000000000000000000000000000000000'),
    value:                '1000000',
    salt:                 SALT,
    hookData:             '0x',
    ...over,
  };
}

function intent(specOver = {}) {
  return { maxBlockHeight: '115792089237316195423570985008687907853269984665640564039457584007913129639935', maxFee: '2010000', spec: spec(specOver) };
}

describe('Gateway Send 3.0 — P0.2 attestation binding', () => {
  it('accepts an echoed intent identical to the submitted intent', () => {
    const submitted = intent();
    const echoed = intent();
    expect(() => verifyEchoedBurnIntent(echoed, submitted)).not.toThrow();
  });

  it('accepts an echoed intent with value as a number (JSON round-trip normalisation)', () => {
    const submitted = intent();
    // A JSON round-trip may express `value` as a number or BigInt→string.
    const echoed = intent({ value: 1000000 }); // number form
    expect(() => verifyEchoedBurnIntent(echoed, submitted)).not.toThrow();
  });

  it('rejects a mismatched salt (attestation for a different intent)', () => {
    const submitted = intent();
    const echoed = intent({ salt: '0x' + 'ab'.repeat(32) });
    let threw = null;
    try { verifyEchoedBurnIntent(echoed, submitted); } catch (e) { threw = e; }
    expect(threw).toBeTruthy();
    expect(threw.message).toContain('attestation_intent_mismatch');
    expect(threw.mismatches).toContain('salt');
  });

  it('rejects a mismatched recipient / amount / domain / token / signer', () => {
    const submitted = intent();
    const cases = [
      { destinationRecipient: pad32(ADDR_C) },
      { value: '2000000' },
      { destinationDomain: 6 },
      { destinationToken: pad32('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913') },
      { sourceSigner: pad32(ADDR_B) },
    ];
    for (const over of cases) {
      let threw = null;
      try { verifyEchoedBurnIntent(intent(over), submitted); } catch (e) { threw = e; }
      expect(threw, JSON.stringify(over)).toBeTruthy();
      expect(threw.message).toContain('attestation_intent_mismatch');
    }
  });

  it('is a no-op when the response does not echo the intent (opaque attestation)', () => {
    // Server /confirm re-verifies the salt on-chain in this case.
    expect(() => verifyEchoedBurnIntent(null, intent())).not.toThrow();
    expect(() => verifyEchoedBurnIntent(undefined, intent())).not.toThrow();
  });
});

describe('Gateway Send 3.0 — P0.6 balance response shape', () => {
  let realFetch;
  beforeEach(() => { realFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

  function mockBalances(body) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => body,
    });
  }

  it('prepare() resolves balance from the { USDC, EURC, cirBTC } proxy shape', async () => {
    mockBalances({ address: ADDR_A, USDC: [{ domain: 26, domainName: 'Arc', balance: '10.0' }], EURC: [], cirBTC: [] });
    const res = await prepare({ token: 'USDC', srcChainId: 5042, dstChainId: 1, amount: '1.0', depositor: ADDR_A, recipient: ADDR_B });
    expect(res.ok).toBe(true);
    expect(res.balance).toBe('10.0');
  });

  it('prepare() still resolves balance from the historical { assets } shape', async () => {
    mockBalances({ assets: [{ token: 'USDC', balances: [{ domain: 26, balance: '5.0' }] }] });
    const res = await prepare({ token: 'USDC', srcChainId: 5042, dstChainId: 1, amount: '1.0', depositor: ADDR_A, recipient: ADDR_B });
    expect(res.ok).toBe(true);
    expect(res.balance).toBe('5.0');
  });

  it('prepare() reports insufficient balance when the amount exceeds the Gateway balance', async () => {
    mockBalances({ address: ADDR_A, USDC: [{ domain: 26, balance: '0.5' }], EURC: [], cirBTC: [] });
    const res = await prepare({ token: 'USDC', srcChainId: 5042, dstChainId: 1, amount: '1.0', depositor: ADDR_A, recipient: ADDR_B });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('insufficient_gateway_balance');
  });
});
