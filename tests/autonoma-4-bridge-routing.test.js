/**
 * AUTONOMA-4 — CCTP V2 Chat Bridge routing tests
 * ═══════════════════════════════════════════════════════════════════════
 * Proves, with ZERO regressions, that a NORMAL Chat Bridge intent routes to
 * CCTP V2 (`_agentExecuteBridge` → AutonomaExecutionGate → AgentScheduleExecutor)
 * and NEVER to Turbo Bridge; that Turbo Bridge is selected only for an explicit
 * "turbo/fast/quick" request; that the CCTP V2 adapter signs the burn on the
 * SOURCE chain for inbound (external → Arc); and that the single broadcast
 * authority remains intact.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const cctpIntegration = fs.readFileSync(path.join(root, 'shared', 'AutonomaCCTPV2Integration.js'), 'utf8');
const router = fs.readFileSync(path.join(root, 'shared', 'CrossChainTransferRouter.js'), 'utf8');

function fnSlice(from, to) {
  const a = html.indexOf(from);
  const b = html.indexOf(to, a + from.length);
  return html.slice(a, b > a ? b : a + 8000);
}

describe('AUTONOMA-4 — Chat Bridge routing (CCTP V2, not Turbo)', () => {
  it('autBridge routes a NORMAL bridge intent to _agentExecuteBridge (CCTP V2)', () => {
    const autBridge = fnSlice('async function autBridge(msg)', 'function autBridgeGuide');
    expect(autBridge).toContain('_agentExecuteBridge(');
    // Normal (non-turbo) bridge always selects _agentExecuteBridge.
    expect(autBridge).toContain("label:'Execute via Agent (CCTP V2)'");
    expect(autBridge).toContain('_agentExecuteBridge("+amt+","+destDomain+",\'"+toName+"\',\'"+bridgeCalldataId+"\',"+srcChainId+",null,\'"+execId+"\')');
  });

  it('autBridge does NOT auto-select Turbo Bridge for a normal intent', () => {
    const autBridge = fnSlice('async function autBridge(msg)', 'function autBridgeGuide');
    // Turbo is gated behind the explicit keyword flag AND a non-Arc source.
    expect(autBridge).toContain('isTurbo && fromIdx!==0');
    expect(autBridge).toContain('var isTurbo = /\\b(turbo|fast|r[aá]pida|rapida|quick)\\b/i.test(low)');
  });

  it('Turbo Bridge remains available ONLY for an explicit turbo/fast/quick request', () => {
    const autBridge = fnSlice('async function autBridge(msg)', 'function autBridgeGuide');
    expect(autBridge).toContain('_agentExecuteTurboBridge(');
    expect(autBridge).toContain("label:'Turbo Bridge via Agent'");
  });

  it('_agentExecuteBridge signs the burn on the SOURCE chain for inbound (external → Arc)', () => {
    const bridgeFn = fnSlice('async function _agentExecuteBridge(', 'async function _agentExecuteTurboBridge');
    expect(bridgeFn).toContain('var isArcSource = chainId === 5042002');
    expect(bridgeFn).toContain('getSessionSigner(_srcProv)');
    expect(bridgeFn).toContain('new ethers.JsonRpcProvider(RPC_URL)');
    expect(bridgeFn).toContain('!isArcSource && RPC_URL');
  });

  it('_agentExecuteBridge still goes through the gate + single broadcast authority', () => {
    const bridgeFn = fnSlice('async function _agentExecuteBridge(', 'async function _agentExecuteTurboBridge');
    expect(bridgeFn).toContain('_agentGateCheck');
    expect(bridgeFn).toContain('_agentBroadcast');
    expect(bridgeFn).not.toContain('eth_sendRawTransaction');
    expect(bridgeFn).not.toContain('signer.signTransaction');
  });

  it('AutonomaCCTPV2Integration is a passthrough (does NOT redirect inbound to CCTPV2InboundEngine)', () => {
    // The wrapper forwards to the original gated adapter, preserving the 7th executionId.
    expect(cctpIntegration).toContain(
      '__agentExecuteBridgeOriginal(amount, destDomain, destChainName, calldataId, sourceChainId, recipientAddr, executionId)'
    );
    expect(cctpIntegration).not.toContain('_executeInboundCCTPV2(amount, src, destChainName, recipientAddr)');
  });
});

describe('AUTONOMA-4 — CrossChainTransferRouter route classification', () => {
  function bootRouter() {
    // The router module references bare globals (ElligenteCCTP / ElligenteChains),
    // so they must be on globalThis for the new Function eval scope.
    globalThis.ElligenteCCTP = {
      CCTP_CONFIG: {
        '5042002': { domain: 26, usdc: '0x3'.padEnd(42, '0'), tokenMessenger: '0xm', messageTransmitter: '0xmt', rpc: 'https://arc', explorer: 'https://arc' },
        '11155111': { domain: 0, usdc: '0x1'.padEnd(42, '0'), tokenMessenger: '0xm', messageTransmitter: '0xmt', rpc: 'https://eth', explorer: 'https://eth' },
      },
    };
    globalThis.ElligenteChains = {
      CHAIN_REGISTRY: {
        '11155111': { name: 'Ethereum Sepolia', shortName: 'ETH', rpc: 'https://eth', explorer: 'https://eth' },
      },
    };
    const win = {};
    const fn = new Function('window', router);
    fn(win);
    return win.CrossChainTransferRouter;
  }

  it('external → Arc is classified as CCTP_V2_INBOUND', () => {
    const r = bootRouter().routeTransfer(11155111, 5042002);
    expect(r.strategy).toBe('CCTP_V2_INBOUND');
    expect(r.destDomain).toBe(26);
  });

  it('Arc → external is classified as EXISTING_BRIDGE (outbound)', () => {
    const r = bootRouter().routeTransfer(5042002, 11155111);
    expect(r.strategy).toBe('EXISTING_BRIDGE');
  });

  it('unsupported source → INVALID (fail-closed)', () => {
    const r = bootRouter().routeTransfer(999999, 5042002);
    expect(r.strategy).toBe('INVALID');
  });
});

describe('AUTONOMA-4 — single broadcast authority (no regression)', () => {
  it('eth_sendRawTransaction remains ONLY inside shared/agentScheduleExecutor.js', () => {
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

  it('no raw-key getter or plaintext signer reintroduced in the bridge path', () => {
    expect(html).not.toContain('function _agentGetPrivateKey');
    expect(cctpIntegration).not.toContain('privateKey');
  });
});
