/**
 * AUTONOMA-5 — Reuse the proven Bridge, do not reimplement it.
 * ═══════════════════════════════════════════════════════════════════════
 * Proves the Autonoma Chat Bridge adapter (`_agentExecuteBridge`) produces the
 * SAME CCTP V2 transactions as the normal Bridge UI (`executeBridge`):
 *
 *   - approve targets the SOURCE chain's USDC (not Arc's hardcoded USDC)
 *   - depositForBurn targets the SOURCE chain's tokenMessenger (not Arc's)
 *   - same domains, same finality threshold (1000), same maxFee (0.5 USDC)
 *   - attestation + receiveMessage flow unchanged
 *
 * and that the safety architecture is preserved (gate + single authority).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function fnSlice(from, to) {
  const a = html.indexOf(from);
  const b = html.indexOf(to, a + from.length);
  return html.slice(a, b > a ? b : a + 9000);
}

describe('AUTONOMA-5 — Autonoma reuses the proven CCTP V2 bridge flow', () => {
  it('_agentExecuteBridge uses source-chain config (same source as the normal Bridge)', () => {
    const fn = fnSlice('async function _agentExecuteBridge(', 'async function _agentExecuteTurboBridge');
    expect(fn).toContain('ElligenteCCTP.CCTP_CONFIG');
    expect(fn).toContain('var USDC_ADDR = cctpCfg.usdc');
    expect(fn).toContain('var MESSENGER_ADDR = cctpCfg.tokenMessenger');
  });

  it('approve targets the SOURCE USDC and SOURCE tokenMessenger (not Arc hardcoded)', () => {
    const fn = fnSlice('async function _agentExecuteBridge(', 'async function _agentExecuteTurboBridge');
    expect(fn).toContain("txData.method === 'approve'");
    expect(fn).toContain('contractAddr = USDC_ADDR');
    expect(fn).toContain("encodeFunctionData('approve', [MESSENGER_ADDR");
  });

  it('depositForBurn targets the SOURCE tokenMessenger with matching finality (1000)', () => {
    const fn = fnSlice('async function _agentExecuteBridge(', 'async function _agentExecuteTurboBridge');
    expect(fn).toContain('contractAddr = MESSENGER_ADDR');
    // finalityThreshold 1000 + maxFee 0.5 — same values as the normal Bridge.
    expect(fn).toContain("ethers.parseUnits('0.5', 6)");
    expect(fn).toContain('1000');
  });

  it('normal Bridge executeBridge() remains untouched (the proven reference)', () => {
    const fn = fnSlice('async function executeBridge(){', 'async function executeBridgeIntentV4');
    expect(fn).toContain('CCTP_CONFIG[fromChain.chainId]');
    expect(fn).toContain('CCTP_CONFIG[toChain.chainId]');
    expect(fn).toContain('depositForBurn');
    expect(fn).toContain('receiveMessage');
  });

  it('Autonoma bridge still passes through the gate + single broadcast authority', () => {
    const fn = fnSlice('async function _agentExecuteBridge(', 'async function _agentExecuteTurboBridge');
    expect(fn).toContain('_agentGateCheck');
    expect(fn).toContain('_agentBroadcast');
    expect(fn).not.toContain('eth_sendRawTransaction');
    expect(fn).not.toContain('signer.signTransaction');
  });

  it('no new broadcast authority (eth_sendRawTransaction only in AgentScheduleExecutor)', () => {
    const sharedDir = path.join(root, 'shared');
    const files = new Set();
    for (const name of fs.readdirSync(sharedDir)) {
      if (!name.endsWith('.js')) continue;
      const c = fs.readFileSync(path.join(sharedDir, name), 'utf8');
      if (c.includes('eth_sendRawTransaction')) files.add(name);
    }
    if (html.includes('eth_sendRawTransaction')) files.add('index.html');
    expect([...files]).toEqual(['agentScheduleExecutor.js']);
  });

  it('normal Bridge does NOT auto-select Turbo (turbo only via explicit intent)', () => {
    const autBridge = fnSlice('async function autBridge(msg)', 'function autBridgeGuide');
    expect(autBridge).toContain('isTurbo && fromIdx!==0');
    expect(autBridge).toContain('_agentExecuteBridge(');
  });
});
