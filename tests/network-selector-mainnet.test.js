/**
 * Arc Mainnet — global network selector + Swap/Bridge network-context regression
 * ═══════════════════════════════════════════════════════════════════════
 * Verifies:
 *   - Arc Mainnet is exposed in the global network selector.
 *   - The selector derives from the single CHAIN_REGISTRY (no duplicate registry).
 *   - Swap quotes/balances use the ACTIVE chain (never a hardcoded Testnet).
 *   - Local/Tower adapters are gated to Arc Testnet (no Testnet leak on Mainnet).
 *   - LI.FI swap execution validates the untrusted route before signing.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const localSrc = fs.readFileSync(path.join(root, 'shared', 'LocalAdapter.js'), 'utf8');
const towerSrc = fs.readFileSync(path.join(root, 'shared', 'TowerAdapter.js'), 'utf8');

function between(start, end) {
  const i = html.indexOf(start);
  if (i < 0) return '';
  const j = html.indexOf(end, i);
  return html.slice(i, j < 0 ? html.length : j);
}

describe('Global network selector — Arc Mainnet', () => {
  it('exposes a selector list that includes Arc Mainnet (5042) first', () => {
    const fn = between('function getSelectableNetworks', 'function openNetworkSelector');
    expect(fn).toContain('ARC_MAINNET_ID');
    expect(fn).toContain('1, 8453, 42161'); // Ethereum / Base / Arbitrum mainnets
    expect(fn).toContain('showTestnets');
  });

  it('hides Testnets in production (non-localhost)', () => {
    const fn = between('function getSelectableNetworks', 'function openNetworkSelector');
    expect(fn).toContain("hostname === 'localhost'");
    expect(fn).toContain('showTestnets = (activeChainId === ARC_TESTNET_ID)');
  });

  it('derives from CHAIN_REGISTRY (no duplicate network registry)', () => {
    const fn = between('function getSelectableNetworks', 'function openNetworkSelector');
    expect(fn).toContain('CHAIN_REGISTRY[order[i]]');
    expect(fn).not.toContain('CHAINS.forEach');
  });

  it('openNetworkSelector uses the selectable list (not the testnet-only CHAINS)', () => {
    const fn = between('function openNetworkSelector', '// ══════════════════════════════════════════');
    expect(fn).toContain('getSelectableNetworks().forEach');
  });

  it('keeps Testnet available for development', () => {
    const fn = between('function getSelectableNetworks', 'function openNetworkSelector');
    expect(fn).toContain('ARC_TESTNET_ID');
  });
});

describe('Swap — network context follows the active chain', () => {
  it('quotes with the ACTIVE chainId (never a hardcoded Testnet)', () => {
    const q = html.slice(html.indexOf('SwapAggregator.getBestQuote({'), html.indexOf('hasLocalPool: hasLocalPool') + 40);
    expect(q).toContain('chainId: activeChainId');
    expect(q).toContain('fromChainId: activeChainId');
    expect(q).not.toContain('chainId: 5042002');
  });

  it('reads swap balances on the ACTIVE chain RPC (no fixed Testnet provider)', () => {
    const fn = between('async function updateSwapBalancesDisplay', 'function swapTokens');
    expect(fn).toContain('getActiveChain()');
    expect(fn).toContain('getTokenAddress(tIn.sym)');
    expect(fn).not.toContain("getCachedProvider('https://arc-testnet.drpc.org')");
  });

  it('displays and routes LI.FI as a selectable swap provider', () => {
    const fn = between('async function updateSwapRate', 'async function updateSwapBalancesDisplay');
    expect(fn).toContain("selected.source === 'lifi'");
    expect(fn).toContain("source = 'LI.FI'");
  });
});

describe('Swap — Local/Tower adapters are Testnet-gated (no leak on Mainnet)', () => {
  it('LocalAdapter refuses to quote off Arc Testnet', () => {
    expect(localSrc).toContain('_isTestnetActive');
    expect(localSrc).toContain('LOCAL_POOLS_TESTNET_ONLY');
  });

  it('TowerAdapter refuses to quote off Arc Testnet', () => {
    expect(towerSrc).toContain('_isTestnetActive');
    expect(towerSrc).toContain('TOWER_TESTNET_ONLY');
  });
});

describe('Swap — LI.FI execution validates the untrusted route', () => {
  it('validates chain/token/amount/recipient before signing', () => {
    const fn = between('async function swpExecuteLiFi', '// ── Execute Swap');
    expect(fn).toContain('LiFiAdapter.validateRoute');
    expect(fn).toContain('fromChainId: activeChainId');
    expect(fn).toContain('getTokenAddress(tIn.sym)');
    expect(fn).toContain('signer.sendTransaction');
  });

  it('no silent provider substitution: LI.FI → LI.FI, Tower → Tower', () => {
    const fn = between('async function executeSwap', '// ── Execute Swap');
    // executeSwap routes each provider to its own executor
    expect(html.indexOf('swpExecuteLiFi')).toBeGreaterThan(-1);
    expect(html).toContain("SWP._towerQuoteData.source === 'lifi'");
  });
});
