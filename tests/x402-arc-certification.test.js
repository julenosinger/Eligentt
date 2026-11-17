/**
 * x402-arc-certification.test.js
 * ═══════════════════════════════════════════════════════════════════════════
 * Phase X402-2.0 / 2.0.1 — Arc Mainnet certification invariants (static).
 *
 * CORRECTED (X402-2.0.1): Arc USDC 0x3600…0000 IS EIP-3009 compatible — the
 * X402-2.0 "incompatible" conclusion used WRONG function selectors
 * (authorizationState is 0xe94a0102, not 0xe3ee160e; the on-chain
 * DOMAIN_SEPARATOR() exactly matches the EIP-712 domain USDC/2/5042 — see
 * docs/x402-mainnet-certification-corrective.md).
 *
 * The code flag eip3009Compatible:false is CONSERVATIVE (settlement not yet
 * implemented), NOT an on-chain fact. It must be flipped to true in X402-2.1.
 *
 * These tests assert the STATIC contract that must NOT regress silently:
 *   1. Arc's trusted asset remains the canonical 0x3600…0000 (6 decimals).
 *   2. SETTLEMENT_IMPLEMENTED remains false (payments disabled).
 *   3. A facilitator URL is configured.
 *   4. validateRequirement still blocks Arc while the flag is false (settlement
 *      remains gated until X402-2.1 flips it).
 */
import { describe, it, expect } from 'vitest';
import {
  X402_NETWORKS,
  TRUSTED_ASSETS,
  SETTLEMENT_IMPLEMENTED,
  FACILITATOR_URL,
  DEFAULT_MAX_USD,
  USDC_DECIMALS,
  parseDecimalUnits,
  validateRequirement,
} from '../functions/api/x402/_x402.mjs';

const ARC_CAIP = 'eip155:5042';
const ARC_USDC = '0x3600000000000000000000000000000000000000';

describe('x402 Arc Mainnet certification (static contract)', () => {
  it('Arc (eip155:5042) registered with eip3009Compatible:true (confirmed on-chain)', () => {
    expect(X402_NETWORKS[ARC_CAIP]).toBeTruthy();
    expect(X402_NETWORKS[ARC_CAIP].chainId).toBe(5042);
    // CONFIRMED: Arc USDC DOMAIN_SEPARATOR matches EIP-712 domain USDC/2/5042.
    expect(X402_NETWORKS[ARC_CAIP].eip3009Compatible).toBe(true);
  });

  it('Arc trusted asset is the canonical 0x3600…0000 USDC (6 decimals)', () => {
    expect(TRUSTED_ASSETS[ARC_CAIP].address.toLowerCase()).toBe(ARC_USDC);
    expect(TRUSTED_ASSETS[ARC_CAIP].decimals).toBe(6);
    expect(TRUSTED_ASSETS[ARC_CAIP].symbol).toBe('USDC');
  });

  it('settlement remains disabled (SETTLEMENT_IMPLEMENTED === false)', () => {
    expect(SETTLEMENT_IMPLEMENTED).toBe(false);
  });

  it('a default facilitator URL is configured (never a blank string)', () => {
    expect(typeof FACILITATOR_URL).toBe('string');
    expect(FACILITATOR_URL.length).toBeGreaterThan(0);
  });

  it('default per-payment cap is a positive decimal string (exactly parseable)', () => {
    expect(typeof DEFAULT_MAX_USD).toBe('string');
    expect(parseDecimalUnits(DEFAULT_MAX_USD, USDC_DECIMALS)).toBeGreaterThan(0n);
  });

  it('validateRequirement accepts an Arc USDC requirement structurally (settlement is a separate gate)', () => {
    const req = {
      scheme: 'exact',
      network: ARC_CAIP,
      networkRaw: ARC_CAIP,
      amount: '1000000',           // 1.00 USDC atomic
      asset: ARC_USDC,
      payTo: '0x0000000000000000000000000000000000000001',
      maxTimeoutSeconds: 60,
      extra: { assetTransferMethod: 'eip3009', name: 'USDC', version: '2' },
    };
    const v = validateRequirement(req, { maxUsd: DEFAULT_MAX_USD });
    expect(v.checks.find((c) => c.name === 'network_eip3009').passed).toBe(true);
    expect(v.ok).toBe(true); // structural checks pass; settlement gated separately
  });
});
