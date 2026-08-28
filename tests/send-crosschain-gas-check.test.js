/**
 * Send Assets — Destination Gas Safety Check (cross-chain) — structural guard.
 * ═══════════════════════════════════════════════════════════════════════
 * Verifies the DGV layer now also gates the Send Assets CROSS-CHAIN flow
 * (destination ≠ Arc), without touching same-chain sends and without
 * regressing the existing Bridge / Cross-Chain gating.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function between(start, end) {
  const i = html.indexOf(start);
  if (i < 0) return '';
  const j = html.indexOf(end, i);
  return html.slice(i, j < 0 ? html.length : j);
}

describe('Send Assets — cross-chain destination gas check', () => {
  it('has a Send Assets controller gated on cross-chain only (condActive → saIsCrossChain)', () => {
    const dgv = between('DESTINATION GAS SAFETY CHECK', 'AUTONOMA CHAT COMPOSER');
    expect(dgv).toContain("pageId: 'page-send'");
    expect(dgv).toContain("buttonId: 'sa-send-btn'");
    expect(dgv).toContain('condActive');
    expect(dgv).toContain('saIsCrossChain');
    expect(dgv).toContain('saDestChainId');
  });

  it('same-chain sends are exempt (Arc = USDC gas, never gated)', () => {
    const dgv = between('DESTINATION GAS SAFETY CHECK', 'AUTONOMA CHAT COMPOSER');
    expect(dgv).toContain('saIsCrossChain() : false');
  });

  it('#sa-send-btn is included in the capture-phase click gate', () => {
    const dgv = between('DESTINATION GAS SAFETY CHECK', 'AUTONOMA CHAT COMPOSER');
    expect(dgv).toContain("t.closest('#sa-send-btn')");
  });

  it('destination network change re-validates the gas check', () => {
    const dgv = between('DESTINATION GAS SAFETY CHECK', 'AUTONOMA CHAT COMPOSER');
    expect(dgv).toContain("sa-dest-network");
    expect(dgv).toContain('refreshActive(true)');
  });

  it('existing Bridge + Cross-Chain gating preserved (no regression)', () => {
    const dgv = between('DESTINATION GAS SAFETY CHECK', 'AUTONOMA CHAT COMPOSER');
    expect(dgv).toContain("pageId: 'page-bridge'");
    expect(dgv).toContain("buttonId: 'bridge-btn'");
    expect(dgv).toContain("pageId: 'page-xchain'");
    expect(dgv).toContain("buttonId: 'xc-send-btn'");
    expect(dgv).toContain("t.closest('#bridge-btn')");
    expect(dgv).toContain("t.closest('#xc-send-btn')");
  });

  it('cross-chain send still routes through the existing xcExecuteSend executor', () => {
    expect(html).toContain('function saExecuteCrossChain');
    expect(html).toContain('xcExecuteSend()');
    expect(html).toContain('xcFromIdx = 0');
  });
});
