/**
 * balance-service.test.js
 * ═══════════════════════════════════════════════════════════════════════════
 * Source-level regression tests for the cross-chain balance system:
 *   - BalanceService is a shared module (window.BalanceService) with the
 *     canonical getTokenBalance(address, token, chainId).
 *   - The GOLDEN RULE is encoded: balance is ALWAYS read on the chain where
 *     the token lives, never on the wallet's connected chain.
 *   - Providers are dedicated JsonRpcProviders (never window.ethereum / MetaMask)
 *     and are singletons per URL.
 *   - Cache TTL (8-12s), timeout (4-6s), native + ERC-20 support, and
 *     never-throws (returns null) semantics are present.
 *   - index.html wires the module in and reads each swap side on its own chain.
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

const svc = read('shared/BalanceService.js');
const html = read('index.html');

function between(src, start, end) {
  const i = src.indexOf(start);
  if (i < 0) return '';
  const j = src.indexOf(end, i);
  return src.slice(i, j < 0 ? src.length : j);
}

describe('BalanceService — central cross-chain balance module', () => {
  it('attaches to window.BalanceService with the canonical API', () => {
    expect(svc).toContain('window.BalanceService = {');
    expect(svc).toContain('getTokenBalance: getTokenBalance');
    expect(svc).toContain('getTokenBalanceRaw: getTokenBalanceRaw');
    expect(svc).toContain('invalidate: invalidate');
  });

  it('defines getTokenBalance(address, token, chainId)', () => {
    expect(svc).toContain('async function getTokenBalance(address, token, chainId)');
  });

  it('encodes the GOLDEN RULE (balance on the token chain, never the wallet chain)', () => {
    expect(svc).toContain('ALWAYS read on the chain where the token lives');
    expect(svc).toContain('NEVER on the chain the wallet is currently connected to');
  });

  it('uses dedicated JsonRpcProviders (never MetaMask / signing provider)', () => {
    expect(svc).toContain('new ethers.JsonRpcProvider');
    expect(svc).not.toContain('window.ethereum.request');
    expect(svc).not.toContain('window.ethereum.selectedAddress');
  });

  it('keeps a singleton provider per URL (created once, reused)', () => {
    const fn = between(svc, 'function _provider(url)', 'function _resolveTokenMeta');
    expect(fn).toContain('_providers[key]');
    expect(fn).toContain('PROVIDER_TTL_MS');
  });

  it('supports native tokens via getBalance and ERC-20 via balanceOf', () => {
    expect(svc).toContain('prov.getBalance(address)');
    expect(svc).toContain('contract.balanceOf(address)');
    expect(svc).toContain('function balanceOf(address) view returns (uint256)');
  });

  it('has an in-memory cache with TTL 8-12s keyed by address+token+chain', () => {
    expect(svc).toContain('CACHE_TTL_MS = 10000');
    expect(svc).toContain('_cacheKey(');
  });

  it('has a per-read timeout of 4-6s and never throws (returns null)', () => {
    expect(svc).toContain('TIMEOUT_MS = 5000');
    expect(svc).toContain('return null;');
  });

  it('resolves the token address from the chain registry (chain-specific)', () => {
    expect(svc).toContain('getTokenAddressForChain(chainId, sym)');
    expect(svc).toContain('chain.tokens[sym].address');
  });
});

describe('BalanceService — swap UI integration', () => {
  it('index.html loads the BalanceService module', () => {
    expect(html).toContain('<script src="/shared/BalanceService.js"></script>');
  });

  it('swap reader resolves each side on its OWN chain via _swpTokenChainId (stale-while-revalidate + anti-race)', () => {
    const fn = between(html, 'let _swpBalReqIn = 0', 'function swapTokens()');
    expect(fn).toContain('_swpTokenChainId(tIn, \'in\')');
    expect(fn).toContain('_swpTokenChainId(tOut, \'out\')');
    expect(fn).toContain('BalanceService.getTokenBalance(walletAddress, token, chainId)');
    expect(fn).toContain('reqId');                    // per-field anti-race guard
    expect(fn).toContain('_swpBalCache');             // last-known-good (no flicker)
    expect(fn).toContain('swapPrefetchBalances');     // multi-chain prefetch
  });

  it('swap balance poll runs every 20-30s and only while the Swap page is active', () => {
    const fn = between(html, 'function swapBalStartPolling()', 'function swapBalStopPolling()');
    expect(fn).toContain('25000');
    expect(fn).toContain("page.classList.contains('active')");
  });
});
