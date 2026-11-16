/**
 * instant-balance-logos.test.js
 * ═══════════════════════════════════════════════════════════════════════════
 * Phase 1.4.3 behavioral tests:
 *   - Instant display (stale-while-revalidate display cache in FastBalanceEngine).
 *   - Token logo integrity (canonical logo resolution + removal of the
 *     decorate() single-letter→coin bug).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const engineSrc = fs.readFileSync(path.join(root, 'shared/FastBalanceEngine.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const ADDR = '0x0000000000000000000000000000000000000001';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ARC_USDC = '0x3600000000000000000000000000000000000000';

function loadEngine({ balanceService }) {
  const window = {};
  const ethers = { formatUnits: (v, d) => (Number(v) / Math.pow(10, Number(d))).toString() };
  const BS = balanceService || { getTokenBalance: () => Promise.resolve(null) };
  const fn = new Function(
    'window', 'BalanceService', 'ethers', 'fetch', 'setTimeout', 'clearTimeout',
    engineSrc + '\nreturn window.FastBalanceEngine;'
  );
  return fn(window, BS, ethers, () => Promise.resolve({ json: () => Promise.resolve({ ok: false }) }), setTimeout, clearTimeout);
}

describe('Instant display — stale-while-revalidate cache', () => {
  it('getCachedBalance returns null before any read', () => {
    const engine = loadEngine({});
    expect(engine.getCachedBalance(ADDR, { address: ZERO_ADDRESS, symbol: 'ETH', decimals: 18 }, 8453)).toBeNull();
  });

  it('getCachedBalance returns the confirmed value after a successful read (without refetching)', async () => {
    let calls = 0;
    const engine = loadEngine({ balanceService: { getTokenBalance: () => { calls++; return Promise.resolve('1.2345'); } } });
    await engine.getTokenBalance(ADDR, { address: ZERO_ADDRESS, symbol: 'ETH', decimals: 18 }, 8453);
    expect(calls).toBe(1);
    // Second read is cached (display-only, no new underlying call).
    expect(engine.getCachedBalance(ADDR, { address: ZERO_ADDRESS, symbol: 'ETH', decimals: 18 }, 8453)).toBe('1.2345');
  });

  it('cache is isolated by wallet, chain and token identity', async () => {
    const engine = loadEngine({ balanceService: { getTokenBalance: () => Promise.resolve('1') } });
    await engine.getTokenBalance(ADDR, { address: ZERO_ADDRESS, symbol: 'ETH', decimals: 18 }, 8453);
    expect(engine.getCachedBalance(ADDR, { address: ZERO_ADDRESS, symbol: 'ETH', decimals: 18 }, 42161)).toBeNull(); // diff chain
    expect(engine.getCachedBalance('0x0000000000000000000000000000000000000002', { address: ZERO_ADDRESS, symbol: 'ETH', decimals: 18 }, 8453)).toBeNull(); // diff wallet
  });

  it('reset() clears the display cache', async () => {
    const engine = loadEngine({ balanceService: { getTokenBalance: () => Promise.resolve('1') } });
    await engine.getTokenBalance(ADDR, { address: ZERO_ADDRESS, symbol: 'ETH', decimals: 18 }, 8453);
    engine.reset();
    expect(engine.getCachedBalance(ADDR, { address: ZERO_ADDRESS, symbol: 'ETH', decimals: 18 }, 8453)).toBeNull();
  });

  it('Arc (5042) never populates the non-Arc display cache', async () => {
    const engine = loadEngine({ balanceService: { getTokenBalance: () => Promise.resolve('5') } });
    await engine.getTokenBalance(ADDR, { address: ARC_USDC, symbol: 'USDC', decimals: 6 }, 5042);
    expect(engine.getCachedBalance(ADDR, { address: ARC_USDC, symbol: 'USDC', decimals: 6 }, 5042)).toBeNull();
  });
});

describe('Token logo integrity', () => {
  it('renderItem uses the canonical _swpTokenLogo resolver (not raw logoURI)', () => {
    expect(html).toContain('function _swpTokenLogo(t, chainId)');
    expect(html).toContain('const logoHtml = _swpTokenLogo(t, chainId)');
  });

  it('native ETH gets the Ethereum diamond (not the WETH logoURI from LI.FI)', () => {
    expect(html).toContain('_SWP_ETH_DIAMOND');
    expect(html).toContain("toUpperCase() === 'ETH'");
  });

  it('known assets (USDC/EURC/cirBTC) use local trusted logos', () => {
    expect(html).toContain("USDC:   '/assets/tokens/usdc.svg'");
    expect(html).toContain("EURC:   '/assets/tokens/eurc.svg'");
    expect(html).toContain("CIRBTC: '/assets/tokens/btc.svg'");
  });

  it('the decorate() MutationObserver no longer touches .tok-item-icon (single-letter→coin bug fixed)', () => {
    // The SEL selector must NOT include .tok-item-icon, so an arbitrary token's
    // first-letter fallback can never be rewritten into the USDC/EURC/BTC logo.
    const selMatch = html.match(/var SEL = '([^']+)'/);
    expect(selMatch).toBeTruthy();
    expect(selMatch[1]).not.toContain('.tok-item-icon');
  });

  it('unknown tokens use a neutral per-symbol badge (deterministic hue), not a coin logo', () => {
    expect(html).toContain('function _swpSymbolHue(sym)');
    expect(html).toContain('background:hsl(' + "'" + ' + hue + ');
  });
});
