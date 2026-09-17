/**
 * Send Assets — Arc Mainnet source-level regression tests
 * ═══════════════════════════════════════════════════════════════════════
 * Validates that the actual production source (index.html) has Arc Mainnet
 * wired into the Send Assets data path — NOT merely that a self-contained
 * mock mirrors the desired logic. These tests read the real index.html.
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

describe('Send Assets — Arc Mainnet in the chain registry', () => {
  it('registers Arc Mainnet (5042) with the official RPC', () => {
    const reg = between('const CHAIN_REGISTRY = {', '};');
    expect(reg).toContain('5042:');
    expect(reg).toContain("id: 'Arc_Mainnet'");
    expect(reg).toContain('name: \'Arc Mainnet\'');
    expect(reg).toContain('chainId: 5042');
    expect(reg).toContain("rpc: 'https://rpc.mainnet.arc.io'");
    expect(reg).toContain("explorer: 'https://explorer.arc.io'");
  });

  it('Arc Mainnet uses the mainnet EURC + cirBTC addresses (different from testnet)', () => {
    const reg = between('const CHAIN_REGISTRY = {', '};');
    expect(reg).toContain("EURC: { address: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1'");
    expect(reg).toContain("cirBTC: { address: '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0'");
  });

  it('Arc Testnet is removed (Mainnet only)', () => {
    const reg = between('const CHAIN_REGISTRY = {', '};');
    expect(reg).not.toContain('5042002:');
    expect(reg).not.toContain("id: 'Arc_Testnet'");
  });
});

describe('Send Assets — network detection helpers', () => {
  it('isArcChainId accepts only Arc Mainnet', () => {
    const fn = between('function isArcChainId', 'function arcTargetChainId');
    expect(fn).toContain('ARC_MAINNET_ID');
    expect(fn).not.toContain('ARC_TESTNET_ID');
  });

  it('saIsCrossChain compares destination against the ACTIVE chain (not a hardcoded testnet)', () => {
    const fn = between('function saIsCrossChain', 'function saGetDestChainName');
    expect(fn).toContain('saDestChainId !== activeChainId');
    expect(fn).not.toContain('5042002');
  });

  it('saPopulateDestNetworks populates Mainnet-only destinations', () => {
    const fn = between('function saPopulateDestNetworks', 'function saOnDestChange');
    expect(fn).toContain('sa-dest-network');
    expect(fn).toContain('ARC_MAINNET_ID');
    expect(fn).not.toContain('ARC_TESTNET_ID');
  });
});

describe('Send Assets — execution path uses the active Arc chain', () => {
  it('saExecuteSend never hardcodes Arc Testnet for the chain switch', () => {
    const fn = between('async function saExecuteSend()', '// ── Log transaction');
    expect(fn).toContain('isArcChainId(activeChainId)');
    expect(fn).toContain('arcTargetChainId()');
    expect(fn).not.toContain('if (activeChainId !== 5042002)');
  });

  it('SendGuard recognises 0x3600… USDC on both Arc Mainnet and Arc Testnet', () => {
    const guard = between('const SendGuard = (() => {', 'window.SendGuard = SendGuard');
    expect(guard).toContain('ARC_CHAIN_IDS = [5042002, 5042]');
    expect(guard).toContain('!isArcChain(chainId)');
  });

  it('cirBTC in SA_TOKENS resolves from the active chain (no hardcoded testnet fallback)', () => {
    const tokens = between('const SA_TOKENS = {', '};');
    expect(tokens).toContain("address: () => getTokenAddress('cirBTC')");
    expect(tokens).not.toContain('0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF');
  });
});

describe('Destination Gas Check — Arc Mainnet', () => {
  it('adds an exempt Arc Mainnet (5042) gas threshold (USDC = gas)', () => {
    const dgv = between('var THRESHOLDS = {', 'function thresholdFor');
    expect(dgv).toContain('5042:');
    expect(dgv).toContain('exempt: true');
  });

  it('destination gas check resolves chains via the registry (Mainnet included)', () => {
    expect(html).toContain('function chainByChainId');
    expect(html).toContain('DestinationGasValidator');
  });
});

describe('Send Assets — balance reader is chain-aware', () => {
  it('balance reads use getActiveChain (active network), never a fixed testnet RPC', () => {
    const fn = between('async function saRefreshBalance', '// ── Set MAX');
    expect(fn).toContain('getActiveChain()');
    expect(fn).not.toContain("'https://arc-testnet.drpc.org'");
  });

  it('sidebar/header balance (refreshBalance) resolves the active chain', () => {
    const fn = between('async function refreshBalance()', '// ── disconnectWallet');
    expect(fn).toContain('getActiveChain()');
    expect(fn).toContain('chain.rpc');
  });
});
