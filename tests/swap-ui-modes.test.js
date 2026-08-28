/**
 * SWAP V2 — Standard/Advanced modes + provider comparison (bestQuote vs bestExecutableQuote).
 * ═══════════════════════════════════════════════════════════════════════
 * Proves: (a) the mode controller is a pure presentation state machine,
 * (b) the provider comparison renders SwapAggregator quotes deterministically and
 * separates "best executable" (what runs) from "reference only" (never promised),
 * and (c) the existing execution/quote infrastructure is preserved (no duplication,
 * no hardcoded Tower winner, Tower unavailable never breaks the local pool).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const modeSrc = fs.readFileSync(path.join(root, 'shared', 'swapUiModes.js'), 'utf8');
const aggSrc = fs.readFileSync(path.join(root, 'shared', 'SwapAggregator.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function evalModule(src) {
  const win = {};
  const fn = new Function('window', src);
  fn.call(null, win);
  return win;
}

function modes() { return evalModule(modeSrc).SwapUiModes; }
function agg() { return evalModule(aggSrc).SwapAggregator; }

function q(source, over) {
  return Object.assign({
    source, ok: true, tokenIn: 'USDC', tokenOut: 'EURC',
    amountInRaw: 1000000n, expectedOutRaw: 1000000n, minOutRaw: 995000n,
    feeBps: 30, provider: null, executable: false,
  }, over || {});
}

describe('SwapUiModes — mode state machine', () => {
  it('defaults to standard', () => { expect(modes().getMode()).toBe('standard'); });
  it('setMode advanced → advanced (no page navigation)', () => {
    const m = modes(); expect(m.setMode('advanced')).toBe('advanced'); expect(m.getMode()).toBe('advanced');
  });
  it('setMode standard → standard', () => {
    const m = modes(); m.setMode('advanced'); expect(m.setMode('standard')).toBe('standard');
  });
  it('invalid mode falls back to standard', () => {
    const m = modes(); m.setMode('banana'); expect(m.getMode()).toBe('standard');
  });
});

describe('SwapUiModes — provider comparison (executable vs reference)', () => {
  it('Tower best executable → BEST ROUTE on Tower, Executable tag', () => {
    const m = modes();
    const h = m.buildComparisonHtml({
      bestExecutable: { source: 'tower' },
      quotes: [
        q('local', { expectedOutRaw: 990000n, executable: true }),
        q('tower', { expectedOutRaw: 1000000n, executable: true }),
      ],
    }, { tokenOut: 'EURC', tokenOutDecimals: 6 });
    expect(h).toContain('BEST ROUTE');
    expect(h).toContain('✓ Executable');
    expect(h.indexOf('BEST ROUTE')).toBeLessThan(h.indexOf('Tower'));
    expect(h.indexOf('Tower')).toBeLessThan(h.indexOf('Elligentt'));
  });

  it('Elligentt best executable → BEST ROUTE on Elligentt', () => {
    const m = modes();
    const h = m.buildComparisonHtml({
      bestExecutable: { source: 'local' },
      quotes: [
        q('tower', { expectedOutRaw: 990000n, executable: true }),
        q('local', { expectedOutRaw: 1000000n, executable: true }),
      ],
    }, { tokenOut: 'EURC', tokenOutDecimals: 6 });
    expect(h).toContain('BEST ROUTE');
    expect(h.indexOf('BEST ROUTE')).toBeLessThan(h.indexOf('Elligentt'));
    expect(h.indexOf('Elligentt')).toBeLessThan(h.indexOf('Tower'));
  });

  it('Tower higher expectedOut but NOT executable → "Reference only", local BEST ROUTE', () => {
    const m = modes();
    const h = m.buildComparisonHtml({
      bestExecutable: { source: 'local' },
      quotes: [
        q('tower', { expectedOutRaw: 1001400n, executable: false, calldata: null }),
        q('local', { expectedOutRaw: 998200n, executable: true }),
      ],
    }, { tokenOut: 'EURC', tokenOutDecimals: 6 });
    expect(h).toContain('Reference only');
    expect(h).toContain('BEST ROUTE');
    // Best route badge must be on Elligentt (executable), not Tower (reference).
    expect(h.indexOf('BEST ROUTE')).toBeLessThan(h.indexOf('Elligentt'));
    // Executable rows come before reference rows.
    expect(h.indexOf('Elligentt')).toBeLessThan(h.indexOf('Tower'));
  });

  it('Tower unavailable → discreet "unavailable", local still executable', () => {
    const m = modes();
    const h = m.buildComparisonHtml({
      bestExecutable: { source: 'local' },
      quotes: [
        { source: 'tower', ok: false, error: 'TOWER_UNAVAILABLE' },
        q('local', { expectedOutRaw: 1000000n, executable: true }),
      ],
    }, { tokenOut: 'EURC' });
    expect(h).toContain('BEST ROUTE');
    expect(h).toContain('Elligentt');
    expect(h).toContain('Tower');
    expect(h).toContain('unavailable');
  });

  it('both unavailable → "No quotes available" (never a global error)', () => {
    const m = modes();
    const h = m.buildComparisonHtml({
      ok: false, bestExecutable: null,
      quotes: [
        { source: 'tower', ok: false },
        { source: 'local', ok: false },
      ],
    }, { tokenOut: 'EURC' });
    expect(h).toContain('No quotes available');
    expect(h).not.toContain('BEST ROUTE');
  });

  it('invalid quote (non-positive expectedOutRaw) is filtered out', () => {
    const m = modes();
    const h = m.buildComparisonHtml({
      bestExecutable: { source: 'local' },
      quotes: [
        q('tower', { expectedOutRaw: 0n, minOutRaw: 0n }),
        q('local', { expectedOutRaw: 1000000n, executable: true }),
      ],
    }, { tokenOut: 'EURC' });
    expect(h).not.toContain('Tower');
    expect(h).toContain('Elligentt');
  });

  it('ordering uses BigInt (not float) for expectedOutRaw', () => {
    const m = modes();
    const big = 1000000000000000000000n;
    const small = 999999999999999999999n;
    const h = m.buildComparisonHtml({
      bestExecutable: { source: 'tower' },
      quotes: [
        q('local', { expectedOutRaw: small, executable: true }),
        q('tower', { expectedOutRaw: big, executable: true }),
      ],
    }, { tokenOut: 'EURC' });
    expect(h.indexOf('Tower')).toBeLessThan(h.indexOf('Elligentt'));
  });

  it('output label includes the target token symbol', () => {
    const m = modes();
    const h = m.buildComparisonHtml({
      bestExecutable: { source: 'local' },
      quotes: [q('local', { expectedOutRaw: 1000000n, executable: true })],
    }, { tokenOut: 'EURC' });
    expect(h).toContain('EURC');
  });

  it('no hardcoded Tower winner in the renderer', () => {
    expect(modeSrc).not.toContain('if (tower)');
  });
});

describe('SwapAggregator — bestQuote vs bestExecutableQuote', () => {
  const opts = { tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 1000000n, slippageBps: 50, chainId: 5042002 };

  beforeEach(() => { delete globalThis.TowerAdapter; delete globalThis.LocalAdapter; });
  afterEach(() => { delete globalThis.TowerAdapter; delete globalThis.LocalAdapter; });

  it('hasLocalPool → Tower (higher) is bestQuote/reference, local is bestExecutable', async () => {
    globalThis.TowerAdapter = { getQuote: async () => q('tower', { expectedOutRaw: 1001400n, minOutRaw: 1001393n, calldata: '0xabcd', to: '0x2de8906a641d65d490bc60a4179d961d59742bcb' }) };
    globalThis.LocalAdapter = { getQuote: async () => q('local', { expectedOutRaw: 998200n, minOutRaw: 993209n, executable: true }) };
    const r = await agg().getBestQuote(Object.assign({}, opts, { hasLocalPool: true }));
    expect(r.best.source).toBe('tower');           // bestQuote (reference)
    expect(r.bestExecutable.source).toBe('local');  // bestExecutableQuote (what runs)
    expect(r.executable).toBe(true);
  });

  it('no local pool + valid Tower calldata → Tower is bestExecutable', async () => {
    globalThis.TowerAdapter = { getQuote: async () => q('tower', { expectedOutRaw: 1001400n, minOutRaw: 1001393n, calldata: '0xabcd', to: '0x2de8906a641d65d490bc60a4179d961d59742bcb' }) };
    globalThis.LocalAdapter = { getQuote: async () => ({ source: 'local', ok: false }) };
    const r = await agg().getBestQuote(Object.assign({}, opts, { hasLocalPool: false }));
    expect(r.bestExecutable.source).toBe('tower');
  });

  it('no local pool + Tower calldata missing → NO_EXECUTABLE_ROUTE', async () => {
    globalThis.TowerAdapter = { getQuote: async () => q('tower', { expectedOutRaw: 1001400n, minOutRaw: 1001393n, calldata: null, to: null }) };
    globalThis.LocalAdapter = { getQuote: async () => ({ source: 'local', ok: false }) };
    const r = await agg().getBestQuote(Object.assign({}, opts, { hasLocalPool: false }));
    expect(r.bestExecutable).toBeNull();
    expect(r.executable).toBe(false);
    expect(r.reason).toBe('NO_EXECUTABLE_ROUTE');
  });

  it('pickBestExecutable ignores non-executable (reference-only) quotes', () => {
    const a = agg();
    const r = a.pickBestExecutable([
      q('tower', { expectedOutRaw: 1010000n, minOutRaw: 1005000n, executable: false }),
      q('local', { expectedOutRaw: 1000000n, minOutRaw: 995000n, executable: true }),
    ]);
    expect(r.ok).toBe(true);
    expect(r.best.source).toBe('local');
  });

  it('pickBestExecutable → NO_EXECUTABLE_ROUTE when nothing executable', () => {
    const a = agg();
    const r = a.pickBestExecutable([
      q('tower', { expectedOutRaw: 1010000n, executable: false }),
      q('local', { expectedOutRaw: 1000000n, executable: false }),
    ]);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('NO_EXECUTABLE_ROUTE');
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
  });

  it('Standard mode hides chart + market bar; Advanced keeps the full terminal', () => {
    expect(html).toContain('#page-swap.swp-standard .st-chart-section{display:none}');
    expect(html).toContain('#page-swap.swp-standard .st-market-bar{display:none}');
  });

  it('execution uses bestExecutableQuote (never the reference bestQuote)', () => {
    expect(html).toContain('agg.bestExecutable');
    expect(html).toContain('hasLocalPool: !!(route && !route.noLiq)');
    expect(html).toContain('SWP.aggBestExecutable = agg.bestExecutable');
  });

  it('execution is not duplicated — canonical swap modules preserved', () => {
    for (const f of ['swapMath.js', 'poolEngine.js', 'poolRouter.js', 'poolExecutor.js', 'swapIsolation.js', 'TowerAdapter.js', 'LocalAdapter.js', 'SwapAggregator.js']) {
      expect(fs.existsSync(path.join(root, 'shared', f))).toBe(true);
    }
    for (const f of ['swapMath.js', 'poolEngine.js', 'poolRouter.js', 'poolExecutor.js']) {
      expect(html).toContain('/shared/' + f);
    }
  });
});
