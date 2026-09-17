/**
 * Production hardening — Arc Mainnet only (Bridge/CCTP/Turbo/Treasury/Schedule/Batch gates)
 * Source-level regression tests against the actual production files.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const chains = fs.readFileSync(path.join(root, 'config', 'chains.js'), 'utf8');
const cctp = fs.readFileSync(path.join(root, 'config', 'cctp.js'), 'utf8');
const aiSmart = fs.readFileSync(path.join(root, 'shared', 'aiSmartWallet.js'), 'utf8');

function between(start, end) {
  const i = html.indexOf(start);
  if (i < 0) return '';
  const j = html.indexOf(end, i);
  return html.slice(i, j < 0 ? html.length : j);
}

describe('Network policy — Mainnet only', () => {
  it('ACTIVE_CHAIN_ID is 5042 (production default)', () => {
    expect(chains).toMatch(/ACTIVE_CHAIN_ID:\s*5042/);
  });

  it('config/chains.js registers Arc Mainnet + mainnets', () => {
    expect(chains).toContain('Arc_Mainnet');
    expect(chains).toContain("chainId:5042");
    expect(chains).toContain("rpc:'https://rpc.mainnet.arc.io'");
    expect(chains).toContain('Ethereum');
    expect(chains).toContain('Base');
    expect(chains).toContain('Arbitrum');
  });

  it('production chain selector is Mainnet only (getSelectableNetworks)', () => {
    const fn = between('function getSelectableNetworks', 'function openNetworkSelector');
    expect(fn).not.toContain('showTestnets');
    expect(fn).not.toContain('ARC_TESTNET_ID');
  });
});

describe('CCTP config — official Mainnet contracts + Iris production', () => {
  it('config/cctp.js has Arc Mainnet (5042) messengers matching Circle docs', () => {
    expect(cctp).toContain("tokenMessenger:'0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d'");
    expect(cctp).toContain("messageTransmitter:'0x81D40F21F12A8F0E3252Bccb954D722d4c464B64'");
    expect(cctp).toContain("tokenMinter:'0xfd78EE919681417d192449715b2594ab58f5D002'");
  });

  it('Iris uses the production endpoint only (no sandbox)', () => {
    expect(cctp).toContain('iris-api.circle.com');
    expect(cctp).not.toContain('iris-api-sandbox.circle.com');
  });

  it('never reuses the Testnet messenger in the 5042 row', () => {
    expect(cctp).not.toContain('0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA');
    expect(cctp).not.toContain('5042002');
  });
});

describe('Bridge — LI.FI only (CCTP removed from active path)', () => {
  it('bridge subtitle is LI.FI Arc Mainnet', () => {
    expect(html).toContain('Cross-chain bridge · LI.FI · Arc Mainnet');
  });

  it('executor routes exclusively through LI.FI (no CCTP/Turbo in active path)', () => {
    const fn = between('function executeBridgeOrTurbo', '// ── Bridge via LI.FI');
    expect(fn).toContain('executeBridgeViaLiFi()');
    expect(fn).not.toContain('executeBridge()');
    expect(fn).not.toContain('Turbo Bridge is disabled');
  });

  it('LI.FI bridge validates the untrusted route before signing', () => {
    const fn = between('async function executeBridgeViaLiFi', '// ── LI.FI cross-chain status polling');
    expect(fn).toContain('LiFiAdapter.getQuote');
    expect(fn).toContain('LiFiAdapter.validateRoute');
    expect(fn).toContain('sendTransaction');
  });

  it('LI.FI bridge tracks cross-chain status (never source-confirmed == completed)', () => {
    const fn = between('async function _lifiPollBridgeStatus', '// ── Pending bridge recovery');
    expect(fn).toContain('LiFiAdapter.getStatus');
    expect(fn).toContain("status === 'DONE'");
  });

  it('Treasury nav item is hidden', () => {
    expect(html).not.toContain('id="nav-treasury"');
  });

  it('treasury route redirects to send', () => {
    expect(html).toContain("if (id === 'treasury') { showPage('send'); return; }");
  });

  it('requireArcMainnet gate exists for production execution', () => {
    const fn = between('function requireArcMainnet', 'function getTokenAddress');
    expect(fn).toContain('ARC_MAINNET_ID');
    expect(fn).toContain("Number(activeChainId) === ARC_MAINNET_ID");
  });
});

describe('Schedule — Scheduled + Stopped actions', () => {
  it('adds Scheduled + Stopped buttons', () => {
    expect(html).toContain('Scheduled');
    expect(html).toContain('Stopped');
    expect(html).toContain('scheduleFilterView');
  });

  it('filter is wired to the existing ScheduleEngine store', () => {
    const fn = between('function scheduleFilterView', 'function _schVisible');
    expect(fn).toContain('showPage');
    const vis = between('function _schVisible', 'function renderSchedules');
    expect(vis).toContain("s.status === 'Active'");
    expect(vis).toContain("s.status === 'Paused'");
  });
});

describe('Batch / Send — Arc Mainnet gate', () => {
  it('executeMultiSendV4 rejects non-5042', () => {
    const fn = between('async function executeMultiSendV4', 'const chainKeys');
    expect(fn).toContain("requireArcMainnet('Batch')");
    expect(fn).not.toContain('activeChainId !== 5042002');
  });

  it('executeSingleSend rejects non-5042', () => {
    const fn = between('async function executeSingleSend', 'const toAddr');
    expect(fn).toContain("requireArcMainnet('Send')");
  });
});

describe('AI Smart Wallet / Autonoma — chain-aware', () => {
  it('aiSmartWallet resolves the ACTIVE chain tokens (not hardcoded 5042002)', () => {
    expect(aiSmart).toContain('getActiveChain');
    expect(aiSmart).not.toContain('CHAIN_REGISTRY[5042002].tokens');
  });

  it('aiSmartWallet RPC + explorer are chain-aware', () => {
    expect(aiSmart).toContain('getActiveChain().rpc');
    expect(aiSmart).toContain('getActiveChain().explorer');
  });

  it('aiSmartWallet switches to the Arc target (not hardcoded testnet)', () => {
    expect(aiSmart).toContain('arcTargetChainId');
  });
});
