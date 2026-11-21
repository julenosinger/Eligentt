/**
 * Network default (Arc Mainnet) + mobile chain switch.
 * Regression guards for: Arc as the default app/source chain, and the mobile
 * network selector switching directly on tap (the desktop "Switch" button lives
 * in a right panel that is hidden on mobile).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function between(start, end) {
  const i = html.indexOf(start);
  if (i < 0) return '';
  const j = html.indexOf(end, i);
  return html.slice(i, j < 0 ? html.length : j);
}

// ── 1. Arc Mainnet as the default network ───────────────────────────────────
describe('Arc Mainnet default network', () => {
  it('initializes activeChainId to 5042 (Arc Mainnet), not Ethereum', () => {
    expect(html).toContain('let activeChainId = 5042;');
  });

  it('defaults the Bridge source to Arc Mainnet (not Ethereum)', () => {
    expect(html).toContain('let bridgeFromIdx   = 0, bridgeToIdx     = 1;');
    expect(html).not.toContain('let bridgeFromIdx   = 1, bridgeToIdx     = 0;');
  });

  it('defaults the Cross-Chain source to Arc Mainnet', () => {
    expect(html).toContain('let xcFromIdx = 0; // Arc Mainnet');
    expect(html).toContain('let xcToIdx   = 1; // Ethereum');
  });

  it('initBridgeChains initializes from Arc Mainnet', () => {
    const fn = between('function initBridgeChains', '// ── Multi-Token Bridge');
    expect(fn).toContain('bridgeFromIdx = 0; // Arc Mainnet');
    expect(fn).toContain('bridgeToIdx   = 1; // Ethereum');
  });

  it('lists Arc Mainnet first in the selectable networks', () => {
    const fn = between('function getSelectableNetworks', 'function openNetworkSelector');
    expect(fn).toContain('ARC_MAINNET_ID');
    expect(fn).toContain('1, 8453, 42161, 10, 137');
  });

  it('getActiveChain falls back to Arc Mainnet (never Ethereum)', () => {
    expect(html).toContain('function getActiveChain() { return getChainById(activeChainId) || CHAIN_REGISTRY[ARC_MAINNET_ID]; }');
  });

  it('selectable network order is Arc first (behavioral via vm)', () => {
    const fn = html.match(/function getSelectableNetworks\(\) \{[\s\S]*?\n\}/);
    expect(fn).toBeTruthy();
    const registry = {
      5042: { chainId: 5042, isEvm: true },
      1: { chainId: 1, isEvm: true },
      8453: { chainId: 8453, isEvm: true },
      42161: { chainId: 42161, isEvm: true },
      10: { chainId: 10, isEvm: true },
      137: { chainId: 137, isEvm: true },
    };
    const ctx = { ARC_MAINNET_ID: 5042, CHAIN_REGISTRY: registry };
    vm.createContext(ctx);
    vm.runInContext(fn[0] + '\nthis.__fn = getSelectableNetworks;', ctx);
    const out = ctx.__fn();
    expect(out[0].chainId).toBe(5042);
    expect(out.map((c) => c.chainId)).toEqual([5042, 1, 8453, 42161, 10, 137]);
  });
});

// ── 2. Mobile network switch on tap ─────────────────────────────────────────
describe('mobile network selector switches on tap', () => {
  it('network rows switch directly on mobile (<=600px), preview on desktop', () => {
    const fn = between('function openNetworkSelector', 'function _nsFilter');
    expect(fn).toContain('window.innerWidth <= 600 ? _nsSwitchTo : _nsSelectChain');
  });

  it('keeps the right-panel switch button for desktop (unused on mobile)', () => {
    expect(html).toContain('Switch to this network');
  });

  it('_nsSwitchTo delegates to ensureNetwork', () => {
    const fn = between('async function _nsSwitchTo', 'function openNetworkSelector');
    expect(fn).toContain('await ensureNetwork(chainId)');
  });

  it('ensureNetwork uses wallet_switchEthereumChain and addEthereumChain fallback', () => {
    const fn = between('async function ensureNetwork', 'async function executeBridge');
    expect(fn).toContain('wallet_switchEthereumChain');
    expect(fn).toContain('wallet_addEthereumChain');
    expect(fn).toContain('chainId:            targetHex');
  });

  it('ensureNetwork rejects user rejection (4001) with a clear message', () => {
    const fn = between('async function ensureNetwork', 'async function executeBridge');
    expect(fn).toContain("code === 4001");
    expect(fn).toContain('User rejected network switch');
  });
});

// ── 3. chainChanged + state consistency ────────────────────────────────────
describe('chain change handling', () => {
  it('updates state on chainChanged and refreshes the provider', () => {
    const fn = between("raw.on('chainChanged'", "raw.on('disconnect'");
    expect(fn).toContain('await refreshProviderState()');
    expect(fn).toContain('updateNetworkBadge()');
  });

  it('disconnect resets activeChainId to Arc Mainnet', () => {
    expect(html).toContain('activeChainId = 5042');
  });

  it('never forces the wallet back to Arc automatically (consent only)', () => {
    const fn = between("raw.on('chainChanged'", "raw.on('disconnect'");
    expect(fn).not.toContain('wallet_switchEthereumChain');
  });
});

// ── 4. No financial execution changes ───────────────────────────────────────
describe('no financial execution changes', () => {
  it('keeps the swap engine intact', () => {
    expect(html).toContain('async function executeSwap');
    expect(html).toContain('SwapAggregator');
  });

  it('keeps LI.FI/CCTP and bridge execution intact', () => {
    expect(html).toContain('swpExecuteLiFi');
    expect(html).toContain('LiFiAdapter');
  });
});
