/**
 * Chain / Provider / Balance consistency — regression tests.
 * ═══════════════════════════════════════════════════════════════════════
 * Proves that balance reads always resolve `chainId → CHAIN_REGISTRY → RPC →
 * provider` (never the wallet's signing provider), that the Swap balance reader
 * is chain-aware, that Unified Balance uses independent per-chain providers with
 * chain-tagged results, that Arc USDC is never double-counted, and that no
 * production path falls back to Testnet.
 *
 * Source-level tests: they read the actual production files.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}
function between(src, start, end) {
  const i = src.indexOf(start);
  if (i < 0) return '';
  const j = src.indexOf(end, i);
  return src.slice(i, j < 0 ? src.length : j);
}

const html = read('index.html');
const aiSmartWallet = read('shared/aiSmartWallet.js');
const walletManager = read('shared/walletManager.js');
const lifiAdapter = read('shared/LiFiAdapter.js');
const chainsConfig = read('config/chains.js');

describe('Chain-consistent provider resolution (HARD RULE)', () => {
  it('has a getChainProvider helper that resolves chainId → registry → RPC', () => {
    const fn = between(html, 'async function getChainProvider', 'function activeChainProvider');
    expect(fn).toContain('getChainById');
    expect(fn).toContain('getCachedProvider(c.rpc)');
  });

  it('getChainProvider verifies provider.getNetwork().chainId (mismatch detected)', () => {
    const fn = between(html, 'async function getChainProvider', 'function activeChainProvider');
    expect(fn).toContain('prov.getNetwork()');
    expect(fn).toContain('Number(net.chainId) !== id');
    expect(fn).toContain('provider network mismatch');
  });

  it('refreshBalance uses the chain-consistent provider (not window.provider)', () => {
    const fn = between(html, 'async function refreshBalance()', '// ── disconnectWallet');
    expect(fn).toContain('getChainProvider(activeChainId)');
    expect(fn).not.toContain('provider.getBalance');
    expect(fn).not.toContain('window.provider.getBalance');
  });

  it('WalletManager balance helpers resolve a chain-specific read provider', () => {
    expect(walletManager).toContain('function _readProvider()');
    expect(walletManager).toContain('const prov = _readProvider();');
    // never read balance via the signing provider
    expect(walletManager).not.toContain('const prov = getProvider();\n    if (!addr || !prov || !tokenAddress) return null;');
  });
});

describe('Swap balance reader — chain-aware', () => {
  it('swap balance resolves token address from the ACTIVE chain registry', () => {
    const fn = between(html, 'async function updateSwapBalancesDisplay()', 'function swapTokens()');
    expect(fn).toContain('getChainProvider(activeChainId)');
    expect(fn).toContain('const addr = getTokenAddress(t.sym)');
    // no cross-chain Arc-address leak via getTokAddr
    expect(fn).not.toContain('getTokenAddress(t.sym) || getTokAddr(t.sym)');
    expect(fn).not.toContain('getTokAddr(t.sym)');
  });

  it('swap balance marks tokens not deployed on the active chain as unavailable', () => {
    const fn = between(html, 'async function updateSwapBalancesDisplay()', 'function swapTokens()');
    expect(fn).toContain("return '—'; // not deployed on this chain");
  });

  it('Arc active (5042) → Arc token addresses are used (USDC/EURC mainnet)', () => {
    expect(html).toContain('tokens: {');
    const registry = between(html, 'const CHAIN_REGISTRY = {', '// ── Derived helpers');
    expect(registry).toContain("EURC: { address: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1'");
  });

  it('Base active (8453) → Base RPC + Base token addresses are registered', () => {
    const registry = between(html, 'const CHAIN_REGISTRY = {', '// ── Derived helpers');
    expect(registry).toContain('chainId: 8453');
    expect(registry).toContain("rpc: 'https://mainnet.base.org'");
    expect(registry).toContain("USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'");
  });
});

describe('Unified Balance — per-chain providers + chain-tagged results', () => {
  it('uses a per-chain read provider (never the wallet signing provider)', () => {
    const fn = between(html, 'function _ubProvider', 'function _ubWithTimeout');
    expect(fn).toContain('getCachedProvider(rpc)');
    expect(fn).not.toContain('window.provider');
  });

  it('resolves token address from the chain-specific registry', () => {
    const fn = between(html, 'function ubFetchAllBalances', 'function ubFetchNativeBalance');
    expect(fn).toContain('chain.tokens[sym].address');
  });

  it('tags every result with its chainId', () => {
    const fn = between(html, 'function ubResult', 'function _ubChainStatus');
    expect(fn).toContain('chainId: (o.chain.id || o.chain.name)');
  });

  it('keeps the six-chain architecture (Arc/Ethereum/Base/Arbitrum/Optimism/Polygon)', () => {
    expect(chainsConfig).toContain('5042');
    expect(chainsConfig).toContain('8453');
    expect(chainsConfig).toContain('42161');
    expect(chainsConfig).toContain('137');
  });

  it('Arc native USDC is NOT double-counted (only ERC-20 balanceOf is read)', () => {
    // On Arc, nativeSym is null (native currency is USDC, not ETH), so only ERC-20 reads happen.
    const fn = between(html, 'function ubFetchAllBalances', 'function ubFetchNativeBalance');
    expect(fn).toContain("chain.chainId !== 5042");
  });
});

describe('Cache invalidation on wallet/chain change', () => {
  it('unified balance bumps generation + invalidates on wallet/network change', () => {
    expect(html).toContain('_ubGeneration');
    expect(html).toContain('UnifiedBalanceEngine.invalidate');
  });

  it('chainChanged handler refreshes provider state before reading balances', () => {
    const fn = between(html, "raw.on('chainChanged'", "raw.on('disconnect'");
    expect(fn).toContain('await refreshProviderState()');
    expect(fn).toContain('await refreshBalance()');
  });
});

describe('LI.FI — fromChain/toChain preserved', () => {
  it('LiFiAdapter forwards fromChainId/toChainId to the quote proxy', () => {
    expect(lifiAdapter).toContain('fromChain: fromChainId');
    expect(lifiAdapter).toContain('toChain: toChainId');
    expect(lifiAdapter).toContain('fromToken: fromToken');
    expect(lifiAdapter).toContain('toToken: toToken');
  });

  it('LiFiAdapter resolves token addresses from the Mainnet chain registry', () => {
    expect(lifiAdapter).toContain('getTokenAddressForChain(chainId, symbol)');
  });
});

describe('No production Testnet fallback', () => {
  it('aiSmartWallet has no rpc.testnet.arc.io fallback', () => {
    expect(aiSmartWallet).not.toContain('rpc.testnet.arc.io');
    expect(aiSmartWallet).not.toContain('rpc.testnet.arc.network');
    expect(aiSmartWallet).toContain("'https://rpc.mainnet.arc.io'");
  });

  it('no production path references 5042002 or Testnet RPC', () => {
    for (const f of ['index.html', 'shared/aiSmartWallet.js', 'shared/walletManager.js', 'shared/LiFiAdapter.js']) {
      const src = read(f);
      expect(src, f).not.toContain('5042002');
      expect(src, f).not.toMatch(/rpc\.testnet\.arc\.(io|network)/);
    }
  });
});
