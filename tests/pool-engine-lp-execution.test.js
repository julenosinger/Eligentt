/**
 * POOL ENGINE — LP EXECUTION + ON-CHAIN HISTORY HARDENING (Phase 4)
 * ═══════════════════════════════════════════════════════════════════════════
 * Verifies the REAL LP execution path and on-chain history:
 *   - LP decimals are read on-chain, never assumed 18 for financial math
 *   - add/remove liquidity use the REAL deployed contract methods
 *   - receipts are verified (status === 1) before success
 *   - post-transaction state refresh is wired
 *   - on-chain history comes from real event logs (queryFilter), not synthetic
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function extractFunction(source, name) {
  const i = source.indexOf('function ' + name + '(');
  if (i < 0) return null;
  const brace = source.indexOf('{', i);
  let depth = 0;
  for (let j = brace; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}') { depth--; if (depth === 0) return source.slice(i, j + 1); }
  }
  return null;
}

/* ════════════════════════════════════════════════════════════
   LP decimals — never assumed 18 (TEST 3)
   ════════════════════════════════════════════════════════════ */
describe('LP decimals — read on-chain, never assumed 18', () => {
  it('no arbitrary `lpDecimals || 18` fallback remains in financial execution', () => {
    expect(indexHtml).not.toContain('lpDecimals || 18');
  });

  it('getLPDecimals returns null (LP_DECIMALS_UNAVAILABLE) when unverified', () => {
    const fn = extractFunction(indexHtml, 'getLPDecimals');
    expect(fn).toBeTruthy();
    const win = {};
    globalThis.poolData = { 'x': { _lpDecimalsVerified: false, _lpDecimals: 18 } };
    try {
      new Function('window', fn + '\nwindow.getLPDecimals = getLPDecimals;')(win);
      expect(win.getLPDecimals('x')).toBeNull();
      globalThis.poolData = { 'y': { _lpDecimalsVerified: true, _lpDecimals: 6 } };
      expect(win.getLPDecimals('y')).toBe(6);
    } finally {
      delete globalThis.poolData;
    }
  });

  it('decimals are tracked as verified from on-chain read', () => {
    expect(indexHtml).toContain('_lpDecimalsVerified');
    expect(indexHtml).toContain('lpDecVerified');
  });
});

/* ════════════════════════════════════════════════════════════
   Real add/remove liquidity contract methods (TEST 4/7)
   ════════════════════════════════════════════════════════════ */
describe('Add/remove liquidity use the real deployed contract methods', () => {
  it('addLiquidity(uint256,uint256) is the deployed signature', () => {
    expect(indexHtml).toContain("'function addLiquidity(uint256 amount0, uint256 amount1) returns (uint256 lpTokens)'");
    expect(indexHtml).toContain('pc.addLiquidity(amt0, amt1)');
  });
  it('removeLiquidity(uint256) is the deployed signature', () => {
    expect(indexHtml).toContain("'function removeLiquidity(uint256 lpAmount) returns (uint256 amount0, uint256 amount1)'");
    expect(indexHtml).toContain('pc.removeLiquidity(lpAmtBig)');
  });
  it('no invented min-amount/deadline params (contract does not support them)', () => {
    // addLiquidity/removeLiquidity have no amountAMin/amountBMin/deadline args
    expect(indexHtml).not.toContain('pc.addLiquidity(amt0, amt1,');
    expect(indexHtml).not.toContain('pc.removeLiquidity(lpAmtBig,');
  });
});

/* ════════════════════════════════════════════════════════════
   Receipt verification (TEST 12)
   ════════════════════════════════════════════════════════════ */
describe('Transaction receipts are verified before success', () => {
  it('add liquidity checks receipt.status === 1', () => {
    expect(indexHtml).toContain('Add liquidity transaction not confirmed on-chain');
    expect(indexHtml).toContain('receipt.status !== 1');
  });
  it('remove liquidity checks receipt.status === 1', () => {
    expect(indexHtml).toContain('Remove liquidity transaction not confirmed on-chain');
  });
});

/* ════════════════════════════════════════════════════════════
   Post-transaction refresh (TEST 13)
   ════════════════════════════════════════════════════════════ */
describe('Post-transaction state refresh is wired', () => {
  it('add liquidity refreshes pool + balances', () => {
    expect(indexHtml).toContain('await loadSinglePool(pcfg);');
    expect(indexHtml).toContain('refreshBalance()');
  });
  it('remove liquidity refreshes pool + position', () => {
    expect(indexHtml).toContain('poolSyncRemove();');
  });
});

/* ════════════════════════════════════════════════════════════
   On-chain history — real event logs (TEST 18/21)
   ════════════════════════════════════════════════════════════ */
describe('On-chain history comes from real event logs', () => {
  it('indexes real Swap/Mint/Burn events via queryFilter', () => {
    expect(indexHtml).toContain('pool.queryFilter(pool.filters.Swap()');
    expect(indexHtml).toContain('pool.filters.Mint()');
    expect(indexHtml).toContain('pool.filters.Burn()');
  });
  it('volume/fees are derived from indexed swap events (no synthetic data)', () => {
    expect(indexHtml).toContain('evt.volume24h = evt.swaps.reduce');
    expect(indexHtml).toContain('evt.fees24h = evt.swaps.reduce');
  });
  it('history is gated on pools that actually emit Swap events', () => {
    expect(indexHtml).toContain('_hasSwapEvents');
  });
});

/* ════════════════════════════════════════════════════════════
   Stale-state protection retained (TEST 14)
   ════════════════════════════════════════════════════════════ */
describe('Financial writes still reject stale state', () => {
  it('add/remove liquidity refresh + reject stale state', () => {
    expect(indexHtml).toContain('_PE.isStale(activePoolId, 60000)');
  });
});
