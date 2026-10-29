/**
 * Liquidity 1.0.2 — data correctness tests (extends 1.0.1)
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

  it('LIQ-3.4: uses ethers.formatUnits instead of unsafe Number(BigInt)/1e18', () => {
    expect(renderSrc).not.toContain('/ 1e18');
    expect(renderSrc).not.toContain('Number(BigInt(pos.lpBal))');
    expect(renderSrc).toContain('ethers.formatUnits');
  });

  it('LIQ-3.5: shows "Unavailable (decimals unknown)" when lpDec null', () => {
    expect(renderSrc).toContain('Unavailable (decimals unknown)');
  });

  it('LIQ-3.6: anyFailed warning shown even when positions exist (partial failure)', () => {
    expect(renderSrc).toContain('anyFailed');
    // warn shown both when positions.length === 0 AND when positions exist
    expect(renderSrc).toContain('partialBanner');
  });

  it('LIQ-3.7: _liqValidateDec rejects negative, non-integer, and out-of-range decimals', () => {
    expect(renderSrc).toContain('_liqValidateDec');
    expect(renderSrc).toContain('d >= 0 && d <= 36');
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

describe('LIQ-6: 1.0.2 — chain guard, formatUnits, retry cleanup', () => {
  it('LIQ-6.1: chainId guard checks for Arc Mainnet 5042', () => {
    expect(renderSrc).toContain('ARC_MAINNET_CHAIN_ID');
    expect(renderSrc).toContain('5042');
    expect(renderSrc).toContain('Wrong network');
  });

  it('LIQ-6.2: stale guard checks both wallet AND provider', () => {
    expect(renderSrc).toContain('providerAtRead');
    expect(renderSrc).toContain('currentProvider !== providerAtRead');
  });

  it('LIQ-6.3: _liqSetPosWarn updates existing warning node instead of appending duplicate', () => {
    expect(renderSrc).toContain('_liqSetPosWarn');
    expect(renderSrc).toContain('existing.textContent = msg');
  });

  it('LIQ-6.4: _liqClearPosWarn removes warning on confirmed-zero success', () => {
    expect(renderSrc).toContain('_liqClearPosWarn');
  });

  it('LIQ-6.5: NETWORK_ERROR maps to specific RPC message in catch', () => {
    expect(renderSrc).toContain('NETWORK_ERROR');
    expect(renderSrc).toContain('RPC unreachable');
  });

  it('LIQ-6.6: partial failure banner shown at top of positions list when anyFailed', () => {
    expect(renderSrc).toContain('partialBanner');
    expect(renderSrc).toContain('list may be incomplete');
  });

  it('LIQ-6.7: no USD TVL sum in pool render', () => {
    expect(poolsSrc).not.toContain("'$'");
    expect(poolsSrc).not.toContain('"$"');
    expect(poolsSrc).not.toContain('+ rB)');
  });
});
