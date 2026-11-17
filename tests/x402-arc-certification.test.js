/**
 * x402-arc-certification.test.js
 * ═══════════════════════════════════════════════════════════════════════════
 * Phase X402-2.0 — read-only Arc Mainnet certification invariants.
 *
 * These tests enforce the NON-NEGOTIABLE certification facts so a future change
 * cannot silently "flip" Arc into EIP-3009-compatible or enable settlement:
 *
 *   1. Arc (eip155:5042) remains eip3009Compatible:false (its native USDC
 *      precompile at 0x3600…0000 does NOT implement EIP-3009 — verified via
 *      read-only RPC: authorizationState()/eip712Domain() revert).
 *   2. Arc's trusted asset remains the canonical 0x3600…0000 (6 decimals).
 *   3. SETTLEMENT_IMPLEMENTED remains false (payments disabled).
 *   4. validateRequirement blocks Arc (network_eip3009 check fails).
 *
 * Network-dependent evidence is recorded in docs/x402-mainnet-certification.md;
 * these tests assert the STATIC contract only (no external RPC dependency).
 */
import { describe, it, expect } from 'vitest';
import {
  X402_NETWORKS,
  TRUSTED_ASSETS,
  SETTLEMENT_IMPLEMENTED,
  FACILITATOR_URL,
  DEFAULT_MAX_USD,
  validateRequirement,
} from '../functions/api/x402/_x402.mjs';

const ARC_CAIP = 'eip155:5042';
const ARC_USDC = '0x3600000000000000000000000000000000000000';

describe('x402 Arc Mainnet certification (static contract)', () => {
  it('Arc (eip155:5042) is registered with eip3009Compatible:false', () => {
    expect(X402_NETWORKS[ARC_CAIP]).toBeTruthy();
    expect(X402_NETWORKS[ARC_CAIP].chainId).toBe(5042);
    expect(X402_NETWORKS[ARC_CAIP].eip3009Compatible).toBe(false);
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

  it('default per-payment cap is a positive dollar amount', () => {
    expect(DEFAULT_MAX_USD).toBeGreaterThan(0);
  });

  it('validateRequirement blocks Arc via the network_eip3009 check (never "ready")', () => {
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
    expect(v.ok).toBe(false);
    const eip3009Check = v.checks.find((c) => c.name === 'network_eip3009');
    expect(eip3009Check.passed).toBe(false);
  });
});
