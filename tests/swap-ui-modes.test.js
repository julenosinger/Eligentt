/**
 * SWAP V2 — Standard/Advanced modes + provider comparison.
 * ═══════════════════════════════════════════════════════════════════════
 * Proves: (a) the mode controller is a pure presentation state machine,
 * (b) the provider comparison renders the SwapAggregator quotes deterministically
 * (winner by expectedOutRaw BigInt, then minOutRaw, then feeBps), and (c) the
 * existing execution/quote infrastructure is preserved (no duplication, no
 * hardcoded Tower winner, Tower unavailable never breaks the local pool).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const modeSrc = fs.readFileSync(path.join(root, 'shared', 'swapUiModes.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function evalModes() {
  const win = {};
  const fn = new Function('window', modeSrc);
  fn.call(null, win);
  return win.SwapUiModes;
}

function q(source, over) {
  return Object.assign({
    source, ok: true, tokenIn: 'USDC', tokenOut: 'EURC',
    amountInRaw: 1000000n, expectedOutRaw: 1000000n, minOutRaw: 995000n,
    feeBps: 30, provider: null,
  }, over || {});
}

describe('SwapUiModes — mode state machine', () => {
  it('defaults to standard', () => {
    const m = evalModes();
    expect(m.getMode()).toBe('standard');
  });

  it('setMode advanced → advanced (no page navigation)', () => {
    const m = evalModes();
    expect(m.setMode('advanced')).toBe('advanced');
    expect(m.getMode()).toBe('advanced');
  });

  it('setMode standard → standard', () => {
    const m = evalModes();
    m.setMode('advanced');
    expect(m.setMode('standard')).toBe('standard');
  });

  it('invalid mode falls back to standard', () => {
    const m = evalModes();
    m.setMode('banana');
    expect(m.getMode()).toBe('standard');
  });
});

describe('SwapUiModes — provider comparison (deterministic winner)', () => {
  it('Tower winner → BEST PRICE on Tower, Tower listed first', () => {
    const m = evalModes();
    const h = m.buildComparisonHtml({
      best: { source: 'tower' },
      quotes: [
        q('local', { expectedOutRaw: 990000n, minOutRaw: 985050n }),
        q('tower', { expectedOutRaw: 1000000n, minOutRaw: 995000n }),
      ],
    }, { tokenOut: 'EURC', tokenOutDecimals: 6 });
    expect(h).toContain('BEST PRICE');
    expect(h.indexOf('BEST PRICE')).toBeLessThan(h.indexOf('Tower'));
    expect(h.indexOf('Tower')).toBeLessThan(h.indexOf('Elligentt'));
  });

  it('Elligentt (local) winner → BEST PRICE on Elligentt', () => {
    const m = evalModes();
    const h = m.buildComparisonHtml({
      best: { source: 'local' },
      quotes: [
        q('tower', { expectedOutRaw: 990000n, minOutRaw: 985050n }),
        q('local', { expectedOutRaw: 1000000n, minOutRaw: 995000n }),
      ],
    }, { tokenOut: 'EURC', tokenOutDecimals: 6 });
    expect(h).toContain('BEST PRICE');
    expect(h.indexOf('BEST PRICE')).toBeLessThan(h.indexOf('Elligentt'));
    expect(h.indexOf('Elligentt')).toBeLessThan(h.indexOf('Tower'));
  });

  it('Tower unavailable → discreet "unavailable", local still wins', () => {
    const m = evalModes();
    const h = m.buildComparisonHtml({
      best: { source: 'local' },
      quotes: [
        { source: 'tower', ok: false, error: 'TOWER_UNAVAILABLE' },
        q('local', { expectedOutRaw: 1000000n }),
      ],
    }, { tokenOut: 'EURC' });
    expect(h).toContain('BEST PRICE');
    expect(h).toContain('Elligentt');
    expect(h).toContain('Tower');
    expect(h).toContain('unavailable');
  });

  it('both unavailable → "No quotes available" (never a global error)', () => {
    const m = evalModes();
    const h = m.buildComparisonHtml({
      ok: false, best: null,
      quotes: [
        { source: 'tower', ok: false },
        { source: 'local', ok: false },
      ],
    }, { tokenOut: 'EURC' });
    expect(h).toContain('No quotes available');
    expect(h).not.toContain('BEST PRICE');
  });

  it('invalid quote (non-positive expectedOutRaw) is filtered out', () => {
    const m = evalModes();
    const h = m.buildComparisonHtml({
      best: { source: 'local' },
      quotes: [
        q('tower', { expectedOutRaw: 0n, minOutRaw: 0n }),
        q('local', { expectedOutRaw: 1000000n }),
      ],
    }, { tokenOut: 'EURC' });
    expect(h).not.toContain('Tower');
    expect(h).toContain('Elligentt');
    expect(h).toContain('BEST PRICE');
  });

  it('winner determined by expectedOutRaw using BigInt (not float)', () => {
    const m = evalModes();
    const big = 1000000000000000000000n;
    const small = 999999999999999999999n;
    const h = m.buildComparisonHtml({
      best: { source: 'tower' },
      quotes: [
        q('local', { expectedOutRaw: small, minOutRaw: small }),
        q('tower', { expectedOutRaw: big, minOutRaw: big }),
      ],
    }, { tokenOut: 'EURC' });
    // BigInt comparison keeps Tower (the genuinely larger output) first.
    expect(h.indexOf('Tower')).toBeLessThan(h.indexOf('Elligentt'));
    expect(h.indexOf('BEST PRICE')).toBeLessThan(h.indexOf('Tower'));
  });

  it('tie in expectedOutRaw → higher minOutRaw wins', () => {
    const m = evalModes();
    const h = m.buildComparisonHtml({
      best: { source: 'local' },
      quotes: [
        q('tower', { expectedOutRaw: 1000000n, minOutRaw: 990000n }),
        q('local', { expectedOutRaw: 1000000n, minOutRaw: 995000n }),
      ],
    }, { tokenOut: 'EURC' });
    expect(h.indexOf('BEST PRICE')).toBeLessThan(h.indexOf('Elligentt'));
  });

  it('output label includes the target token symbol', () => {
    const m = evalModes();
    const h = m.buildComparisonHtml({
      best: { source: 'local' },
      quotes: [q('local', { expectedOutRaw: 1000000n })],
    }, { tokenOut: 'EURC' });
    expect(h).toContain('EURC');
  });
});

describe('index.html — Swap V2 structural invariants', () => {
  it('mode toggle is present and drives SwapUiModes', () => {
    expect(html).toContain('id="swp-mode-toggle"');
    expect(html).toContain("SwapUiModes.setMode('standard')");
    expect(html).toContain("SwapUiModes.setMode('advanced')");
  });

  it('provider comparison card is present inside the swap panel', () => {
    expect(html).toContain('id="swp-comparison-card"');
    expect(html).toContain('id="swp-comparison-list"');
  });

  it('swapUiModes.js is loaded as a module', () => {
    expect(html).toContain('/shared/swapUiModes.js');
    expect(fs.existsSync(path.join(root, 'shared', 'swapUiModes.js'))).toBe(true);
  });

  it('Standard mode hides chart + market bar; Advanced keeps the full terminal', () => {
    expect(html).toContain('#page-swap.swp-standard .st-chart-section{display:none}');
    expect(html).toContain('#page-swap.swp-standard .st-market-bar{display:none}');
  });

  it('updateSwapRate stores aggregator quotes and renders the comparison', () => {
    expect(html).toContain('SWP.aggQuotes = agg.quotes');
    expect(html).toContain('SwapUiModes.renderComparison');
  });

  it('execution is not duplicated — canonical swap modules preserved', () => {
    for (const f of ['swapMath.js', 'poolEngine.js', 'poolRouter.js', 'poolExecutor.js', 'swapIsolation.js', 'TowerAdapter.js', 'LocalAdapter.js', 'SwapAggregator.js']) {
      expect(fs.existsSync(path.join(root, 'shared', f))).toBe(true);
    }
    for (const f of ['swapMath.js', 'poolEngine.js', 'poolRouter.js', 'poolExecutor.js']) {
      expect(html).toContain('/shared/' + f);
    }
    // No hardcoded Tower winner in the comparison renderer.
    expect(modeSrc).not.toContain("if (tower)");
  });
});
