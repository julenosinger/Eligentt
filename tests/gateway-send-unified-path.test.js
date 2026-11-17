/**
 * Gateway Send 3.1 — unified execution path (protected proxy routing)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Verifies the surgical fix that routes MAINNET Gateway sends through the
 * protected Cloudflare proxy (/api/gateway/transfer → DO salt lock → Circle),
 * eliminating the direct-to-Circle bypass, while preserving the direct Circle
 * TESTNET path for development.
 *
 * The client executor lives in index.html (browser bundle), so this verifies the
 * routing logic structurally rather than via a Node module import.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');

describe('Gateway Send 3.1 — unified execution path', () => {
  it('routes MAINNET through the protected proxy, not directly to Circle', () => {
    // The executor must select /api/gateway/transfer for non-testnet chains.
    expect(html).toContain(": '/api/gateway/transfer'");
    // The mainnet Circle URL must NOT be used as a direct submit target.
    expect(html).not.toContain("'https://gateway-api.circle.com/v1/transfer'");
    // The transfer POST must target the computed URL (proxy for mainnet).
    expect(html).toContain('fetch(_gwTransferUrl');
  });

  it('preserves the direct Circle TESTNET path for development', () => {
    expect(html).toContain("'https://gateway-api-testnet.circle.com/v1/transfer'");
  });

  it('the proxy enforces the durable salt reservation before Circle submission', () => {
    const proxy = fs.readFileSync(path.resolve(__dirname, '../functions/api/gateway/transfer.js'), 'utf8');
    // Atomic reservation before forwarding (DO → KV fallback, fail-closed in prod).
    expect(proxy).toContain('tryReserve');
    expect(proxy).toContain('already_submitted');
    // Forward happens only AFTER all salts are reserved.
    const reserveIdx = proxy.indexOf('tryReserve(salt, record, env)');
    const forwardIdx = proxy.indexOf("fetch(GATEWAY_API + '/v1/transfer'");
    expect(reserveIdx).toBeGreaterThan(-1);
    expect(forwardIdx).toBeGreaterThan(-1);
    expect(reserveIdx).toBeLessThan(forwardIdx);
  });

  it('the attestation binding from Phase 3.0 remains intact', () => {
    const svc = fs.readFileSync(path.resolve(__dirname, '../shared/GatewaySpendService.js'), 'utf8');
    expect(svc).toContain('verifyEchoedBurnIntent');
    expect(svc).toContain('attestation_intent_mismatch');
  });
});
