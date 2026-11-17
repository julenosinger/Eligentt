/**
 * swap-token-logo-contract.test.js
 * ═══════════════════════════════════════════════════════════════════════════
 * PERMANENT token-logo regression protection (Phase 1.4.4).
 *
 * Exercises the ACTUAL production resolver (_swpTokenLogo from index.html), the
 * CSP image-source allowlist (public/_headers), and the LI.FI metadata
 * normalization (functions/api/lifi/tokens.js). No duplicate test-only copy.
 *
 * Contract under test:
 *   - LI.FI logoURI is the PRIMARY source of truth and is never replaced.
 *   - Native ETH, verified registry logos (by address), then a neutral
 *     per-symbol badge are the ONLY fallbacks.
 *   - Token identity is canonical (chainId + address), never symbol alone.
 *   - The CSP img-src must allow the LI.FI logo CDNs (root cause of the
 *     recurring letter-avatar regression).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const headers = fs.readFileSync(path.join(root, 'public/_headers'), 'utf8');
const lifiTokens = fs.readFileSync(path.join(root, 'functions/api/lifi/tokens.js'), 'utf8');

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ETH_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const ARC_EURC = '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1';
const ARC_CIRBTC = '0x171a4217b86a807a64eb94757db6849fb4bdbaa0';
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1'; // Arbitrum WETH

const CHAIN_REGISTRY = {
  5042:  { nativeCurrency: { symbol: 'USDC' } },
  1:     { nativeCurrency: { symbol: 'ETH' } },
  8453:  { nativeCurrency: { symbol: 'ETH' } },
  42161: { nativeCurrency: { symbol: 'ETH' } },
  10:    { nativeCurrency: { symbol: 'ETH' } },
  137:   { nativeCurrency: { symbol: 'MATIC' } },
};

// Minimal chain-aware native classifier mirroring _swpTokenIsNative.
function isNative(t, chainId) {
  const addr = (t && t.address) ? String(t.address).toLowerCase() : '';
  const sym = String((t && t.symbol) || '').toUpperCase();
  const nat = (CHAIN_REGISTRY[Number(chainId)] && CHAIN_REGISTRY[Number(chainId)].nativeCurrency && CHAIN_REGISTRY[Number(chainId)].nativeCurrency.symbol) || '';
  if (!addr || addr === ZERO_ADDRESS || addr === ETH_SENTINEL) return !!nat && sym === String(nat).toUpperCase();
  return false;
}
function escHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function buildTokenLogo() {
  const start = html.indexOf('function _swpSymbolHue(sym)');
  const end = html.indexOf('async function renderTokenList', start);
  if (start === -1 || end === -1) throw new Error('logo resolver block not found');
  const block = html.slice(start, end);
  const fn = new Function('CHAIN_REGISTRY', '_swpTokenIsNative', 'escHtml', block + '\nreturn _swpTokenLogo;');
  return fn(CHAIN_REGISTRY, isNative, escHtml);
}

const tokenLogo = buildTokenLogo();

describe('LI.FI metadata normalization (source of truth preserved)', () => {
  it('the CF tokens proxy copies logoURI verbatim (never drops it)', () => {
    expect(lifiTokens).toContain('logoURI: t.logoURI || null');
    expect(lifiTokens).not.toContain("logoURI: null"); // not hardcoded away
  });
});

describe('CSP image-source allowlist (root-cause gate)', () => {
  it('img-src allows the LI.FI logo CDNs', () => {
    for (const d of ['raw.githubusercontent.com', 'static.debank.com', 'assets.coingecko.com', 'arbiscan.io']) {
      expect(headers).toContain(d);
    }
  });
  it('does NOT broadly weaken img-src to blanket https:', () => {
    expect(headers).not.toMatch(/img-src[^;]*https:\s*;/); // no bare "https:" scheme in img-src
  });
});

describe('_swpTokenLogo — LI.FI logoURI is primary', () => {
  it('valid LI.FI logoURI is used (never replaced by registry or badge)', () => {
    const out = tokenLogo({ address: ARC_USDC, symbol: 'USDC', logoURI: 'https://static.debank.com/usdc.png' }, 5042);
    expect(out).toContain('https://static.debank.com/usdc.png');
    expect(out).toContain('tok-item-logo');
  });
  it('missing logoURI falls back to the verified registry (by address)', () => {
    const out = tokenLogo({ address: ARC_USDC, symbol: 'USDC', logoURI: null }, 5042);
    expect(out).toContain('/assets/tokens/usdc-coin.svg');
  });
  it('invalid logoURI (javascript:) is rejected and falls back', () => {
    const out = tokenLogo({ address: ARC_USDC, symbol: 'USDC', logoURI: 'javascript:alert(1)' }, 5042);
    expect(out).not.toContain('javascript:');
    expect(out).toContain('/assets/tokens/usdc-coin.svg');
  });
});

describe('_swpTokenLogo — canonical identity (chainId + address)', () => {
  it('Arc USDC/EURC/cirBTC preserve their verified identity', () => {
    expect(tokenLogo({ address: ARC_USDC, symbol: 'USDC' }, 5042)).toContain('usdc-coin.svg');
    expect(tokenLogo({ address: ARC_EURC, symbol: 'EURC' }, 5042)).toContain('eurc-coin.svg');
    expect(tokenLogo({ address: ARC_CIRBTC, symbol: 'cirBTC' }, 5042)).toContain('cirBTC_Icon.png');
  });
  it('native ETH (zero address) is distinct from wrapped ETH (real address)', () => {
    const nativeEth = tokenLogo({ address: ZERO_ADDRESS, symbol: 'ETH', logoURI: null }, 42161);
    const weth = tokenLogo({ address: WETH, symbol: 'WETH', logoURI: null }, 42161);
    expect(nativeEth).toContain('/assets/tokens/eth.svg');      // native → eth.svg
    expect(weth).not.toContain('/assets/tokens/eth.svg');       // WETH is NOT native
  });
  it('same-symbol tokens on different chains resolve independently (no symbol collision)', () => {
    // Arc USDC (0x3600…) has a registry logo; an unknown-address USDC does not.
    expect(tokenLogo({ address: ARC_USDC, symbol: 'USDC' }, 5042)).toContain('usdc-coin.svg');
    const unknown = tokenLogo({ address: '0x00000000000000000000000000000000000000ff', symbol: 'USDC' }, 8453);
    expect(unknown).not.toContain('usdc-coin.svg');
    expect(unknown).toContain('tok-item-icon');
  });
  it('unknown token with no logo uses the neutral per-symbol badge (not a coin logo)', () => {
    const out = tokenLogo({ address: '0x00000000000000000000000000000000000000aa', symbol: 'ARGUS' }, 5042);
    expect(out).toContain('tok-item-icon');
    expect(out).toContain('A'); // first letter, deterministic hue
  });
});

describe('_swpTokenLogo — rendering safety', () => {
  it('image error is one-shot (hides img, shows fallback; no retry loop)', () => {
    const out = tokenLogo({ address: ARC_USDC, symbol: 'USDC', logoURI: 'https://x/y.png' }, 5042);
    expect(out).toContain("onerror=\"this.style.display='none';this.nextElementSibling.style.display='flex'\"");
    expect(out).not.toContain('onerror=' + 'this.src='); // no retry/reload of src
  });
  it('every resolved logo carries the original symbol as alt text (identity preserved)', () => {
    const out = tokenLogo({ address: ARC_EURC, symbol: 'EURC', logoURI: 'https://x/e.png' }, 5042);
    expect(out).toContain('alt="EURC"');
  });
  it('the resolver is pure (no shared mutable state → async cannot swap logos)', () => {
    const a = tokenLogo({ address: ARC_USDC, symbol: 'USDC', logoURI: 'https://x/a.png' }, 5042);
    const b = tokenLogo({ address: ARC_EURC, symbol: 'EURC', logoURI: 'https://x/b.png' }, 5042);
    expect(a).toContain('https://x/a.png');
    expect(b).toContain('https://x/b.png');
    // Rendering b must not mutate a's output.
    expect(tokenLogo({ address: ARC_USDC, symbol: 'USDC', logoURI: 'https://x/a.png' }, 5042)).toBe(a);
  });
});

describe('Compiled bundle + integration', () => {
  it('renderItem uses the canonical resolver (chainId passed through)', () => {
    expect(html).toContain('const logoHtml = _swpTokenLogo(t, chainId)');
  });
  it('the resolver block is present in the source (for the production bundle)', () => {
    expect(html).toContain('function _swpTokenLogo(t, chainId)');
    expect(html).toContain('var _SWP_VERIFIED_LOGOS');
  });
});
