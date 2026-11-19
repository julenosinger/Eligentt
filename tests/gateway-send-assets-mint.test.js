/**
 * Gateway Send 3.1.2 — Send Assets mint recovery regression
 * ═══════════════════════════════════════════════════════════════════════════════
 * Locks in the fix: the Send Assets Gateway executor (`saDispatchSend`) must
 * AWAIT `saExecGateway()` and then execute the destination `gatewayMint` via the
 * SAME proven helper (`UBScreen._execGatewayMint`) as Unified Balance — instead of
 * fire-and-forget, which left the transfer stopped after the first signature.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');

describe('Gateway Send 3.1.2 — Send Assets mint recovery', () => {
  it('saDispatchSend awaits saExecGateway() (no fire-and-forget)', () => {
    const patch = html.slice(html.indexOf('var _saDispatchSendOrig = saDispatchSend'), html.indexOf('// ── END GATEWAY ORIGIN — Send Assets'));
    expect(patch).toContain('async function');
    expect(patch).toContain('await saExecGateway()');
    // The old fire-and-forget form must be gone.
    expect(patch).not.toMatch(/\n\s*saExecGateway\(\);/);
  });

  it('saDispatchSend executes gatewayMint for a pending attestation', () => {
    const patch = html.slice(html.indexOf('var _saDispatchSendOrig = saDispatchSend'), html.indexOf('// ── END GATEWAY ORIGIN — Send Assets'));
    expect(patch).toContain("gwStatus === 'pending' && gwResult.attestation");
    expect(patch).toContain('UBScreen._execGatewayMint');
    expect(patch).toContain('signature:   gwResult.operatorSig');
  });

  it('UBScreen exposes the proven _execGatewayMint helper for reuse', () => {
    const ret = html.slice(html.indexOf('return {', html.indexOf('const UBScreen')), html.indexOf('// ═══════════════ SCREEN HELPERS'));
    expect(ret).toContain('_execGatewayMint: _execGatewayMint');
  });

  it('the mint helper targets the verified GatewayMinter and uses gatewayMint selector', () => {
    const mint = html.slice(html.indexOf('async function _execGatewayMint'), html.indexOf('function execSend'));
    expect(mint).toContain("'0x2222222d7164433c4C09B0b0D809a9b52C04C205'");
    expect(mint).toContain('0x9fb01cc5');
  });
});
