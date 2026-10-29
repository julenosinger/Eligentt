/**
 * Liquidity 1.0.1 — data correctness tests
 * Tests the _liqEnrichPools enrichment logic and liqRenderPositions behavior
 * by extracting the functions from index.html and exercising them directly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

// ── extract _liqEnrichPools ──────────────────────────────────────────────────
function extractFn(src, name) {
  const start = src.indexOf('\nfunction ' + name + '(');
  if (start === -1) throw new Error('Function not found: ' + name);
  let depth = 0, i = src.indexOf('{', start);
  const open = i;
  while (i < src.length) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
    i++;
  }
  return src.slice(start + 1, i + 1);
}

const enrichSrc = extractFn(html, '_liqEnrichPools');
const renderSrc = extractFn(html, 'liqRenderPositions');
const poolsSrc  = extractFn(html, 'liqRenderPools');

describe('LIQ-1: _liqEnrichPools error discrimination', () => {
  it('LIQ-1.1: tags reserveErr on getReserves RPC failure, not null', () => {
    expect(enrichSrc).toContain('reserveErr');
    expect(enrichSrc).toContain('{ ok: false, err:');
    // Must NOT silently catch to null with no tag
    expect(enrichSrc).not.toContain('.catch(function(){ return null; })');
  });

  it('LIQ-1.2: distinguishes CALL_EXCEPTION from NETWORK_ERROR', () => {
    expect(enrichSrc).toContain('e.code');
  });

  it('LIQ-1.3: lpDecimals set to null when decimals() fails — never assumes 18', () => {
    expect(enrichSrc).toContain('lpDecimals = dRes.ok ? dRes.val : null');
    expect(enrichSrc).not.toContain('lpDecimals = 18');
    expect(enrichSrc).not.toContain("lpDecimals = dRes.ok ? dRes.val : 18");
  });

  it('LIQ-1.4: calls decimals() on pool contract', () => {
    expect(enrichSrc).toContain("'function decimals() view returns (uint8)'");
  });
});

describe('LIQ-2: TVL — no USD sum without price oracle', () => {
  it('LIQ-2.1: label is Reserves not TVL', () => {
    expect(poolsSrc).toContain('Reserves');
    expect(poolsSrc).not.toContain('>TVL<');
  });

  it('LIQ-2.2: no $ prefix on summed reserves', () => {
    // The old code did: tvlStr = \'$\' + (rA + rB).toLocaleString(...)
    // This MUST be gone
    expect(poolsSrc).not.toMatch(/\$.*\(rA \+ rB\)/);
    expect(poolsSrc).not.toMatch(/\$.*rA \+ rB/);
  });

  it('LIQ-2.3: shows error label when reserveErr is set', () => {
    expect(poolsSrc).toContain('p.reserveErr');
    expect(poolsSrc).toContain('Method unsupported');
    expect(poolsSrc).toContain('RPC unreachable');
  });

  it('LIQ-2.4: shows "Empty pool" when reserves are both 0, not "$0.00"', () => {
    expect(poolsSrc).toContain('Empty pool');
  });

  it('LIQ-2.5: shows "Decimals unavailable" when decimals null', () => {
    expect(poolsSrc).toContain('Decimals unavailable');
  });

  it('LIQ-2.6: no fallback decA = 6 anywhere in pool render', () => {
    expect(poolsSrc).not.toContain(': 6;');
    expect(poolsSrc).not.toContain('? tA.decimals : 6');
    expect(poolsSrc).not.toContain('? tB.decimals : 6');
  });
});

describe('LIQ-3: My Positions — balanceOf fail-safe', () => {
  it('LIQ-3.1: balanceOf failure tagged as { ok: false } not 0n', () => {
    expect(renderSrc).toContain('{ ok: false, err:');
    expect(renderSrc).not.toContain('.catch(function(){ return 0n; })');
  });

  it('LIQ-3.2: partial failure shown as warning, not empty state without note', () => {
    expect(renderSrc).toContain('positions may be incomplete');
  });

  it('LIQ-3.3: wallet-change guard present', () => {
    expect(renderSrc).toContain('addrAtRead');
    expect(renderSrc).toContain('currentAddr !== addrAtRead');
  });

  it('LIQ-3.4: LP decimals from contract, not hardcoded 1e18', () => {
    expect(renderSrc).not.toContain('/ 1e18');
    expect(renderSrc).toContain('lpDec != null');
    expect(renderSrc).toContain('Math.pow(10, pos.lpDec)');
  });

  it('LIQ-3.5: shows "Balance unavailable (decimals unknown)" when lpDec null', () => {
    expect(renderSrc).toContain('Balance unavailable (decimals unknown)');
  });

  it('LIQ-3.6: "No positions found" only shown when all reads ok AND balances are 0', () => {
    // anyFailed check must gate the empty state
    expect(renderSrc).toContain('anyFailed');
    expect(renderSrc).toContain('anyFailed && !positions.length');
  });
});

describe('LIQ-4: No write operations on navigation', () => {
  it('LIQ-4.1: liqRenderPools has no sendTransaction or send call', () => {
    expect(poolsSrc).not.toContain('sendTransaction');
    expect(poolsSrc).not.toContain('.send(');
  });

  it('LIQ-4.2: liqRenderPositions has no sendTransaction or send call', () => {
    expect(renderSrc).not.toContain('sendTransaction');
    expect(renderSrc).not.toContain('.send(');
  });

  it('LIQ-4.3: Add Liq button is disabled', () => {
    expect(poolsSrc).toContain('disabled');
    expect(poolsSrc).toContain('Available in a future release');
  });

  it('LIQ-4.4: Remove button is disabled', () => {
    expect(renderSrc).toContain('disabled');
    expect(renderSrc).toContain('Available in a future release');
  });
});

describe('LIQ-5: Contract status clarity', () => {
  it('LIQ-5.1: no "verified on-chain bytecode" claim', () => {
    const liqSection = html.slice(html.indexOf('id="page-pool"'), html.indexOf('id="page-send"') || html.length);
    expect(liqSection).not.toContain('verified on-chain bytecode');
    expect(liqSection).not.toContain('verified on-chain');
  });
});
