/**
 * Swap — Advanced mode polish, phase 3:
 *  - "Order details" collapsible card (Rate / Impact / Min / Fee / Route + rate history)
 *  - pair controls (market-bar select + quick pills) kept in sync
 * The toggle is hidden everywhere except Advanced; collapsing is CSS-only.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
const start = html.indexOf('/* ── Advanced mode polish · phase 3');
const end = html.indexOf('/* ── Advanced mode polish · phase 4', start);
const block = html.slice(start, end);

describe('phase 3 CSS', () => {
  it('block exists', () => {
    expect(start).toBeGreaterThan(-1);
    expect(block.length).toBeGreaterThan(500);
  });
  it('toggle is hidden by default and only shown in Advanced; every other rule is Advanced-scoped', () => {
    const rules = block.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map(r => r.trim()).filter(Boolean);
    const unscoped = rules.filter(r => !/^#page-swap\.swp-advanced\b/.test(r));
    expect(unscoped).toEqual(['.swp-det-toggle{display:none']);
    expect(block).not.toContain('swp-standard');
  });
  it('collapse only hides rows 3+ and the rate-history card (Rate + Price Impact stay visible)', () => {
    expect(block).toContain('#swp-rate-bar.swp-det-collapsed .st-swap-detail-row:nth-child(n+3){display:none}');
    expect(block).toContain('#swp-rate-bar.swp-det-collapsed ~ #swp-chart-wrap{display:none}');
  });
  it('joins toggle, rows and chart into one card (negative margin matches the 5px flex gap)', () => {
    expect(html).toContain('.st-swap-body{flex:1;overflow-y:auto;padding:6px 8px;display:flex;flex-direction:column;gap:5px}');
    expect(block).toContain('.swp-det-toggle + #swp-rate-bar{margin-top:-5px;');
    expect(block).toContain('#swp-rate-bar ~ #swp-chart-wrap{margin:-5px 0 4px;');
  });
});

describe('phase 3 markup + JS', () => {
  it('toggle is an accessible button wired to swpToggleOrderDetails and placed before the details card', () => {
    const m = html.match(/<button type="button" class="swp-det-toggle" id="swp-det-toggle" aria-expanded="true" aria-controls="swp-rate-bar" onclick="swpToggleOrderDetails\(\)">[\s\S]*?<\/button>\s*<!-- Rate Details -->\s*<div class="st-swap-details" id="swp-rate-bar">/);
    expect(m).not.toBeNull();
  });
  it('all original detail value ids and the chart wrapper are untouched', () => {
    ['swap-rate', 'swp-impact-val', 'swp-min-received', 'swp-fee-val', 'swp-route-pool', 'swp-chart-wrap', 'swp-chart-svg'].forEach(id =>
      expect(html).toContain('id="' + id + '"'));
    expect(html).toContain('<div class="swp-chart-wrap" id="swp-chart-wrap" style="display:none">');
  });
  it('swpToggleOrderDetails only toggles a class + aria-expanded (no quote/route logic)', () => {
    const i = html.indexOf('function swpToggleOrderDetails()');
    expect(i).toBeGreaterThan(-1);
    const fn = html.slice(i, html.indexOf('\n}\n', i) + 3);
    expect(fn).toContain("classList.toggle('swp-det-collapsed'");
    expect(fn).toContain("setAttribute('aria-expanded'");
    expect(fn).not.toMatch(/fetch|updateSwapRate|SWP\.|executeSwap|innerHTML/);
  });
  it('pair controls stay in sync in both directions (idempotent re-render calls only)', () => {
    expect(html).toContain('stPopulatePairPills(); stPopulatePairs(); }, 300);');
    expect(html).toContain('stUpdateMarket(); stPopulatePairs(); stPopulatePairPills(); }, 300);');
  });
  it('original pair entry points and Standard rules are intact', () => {
    expect(html).toContain('onchange="stOnPairChange(this.value)"');
    expect(html).toContain('onclick="stSwitchPair(0)"');
    expect(html).toContain('#page-swap.swp-standard .st-pair-switch{display:none}');
  });
});

describe('no function-name collisions', () => {
  it('the pre-existing swpToggleDetails is defined exactly once and still untouched', () => {
    expect(html.match(/function swpToggleDetails\(\)/g)).toHaveLength(1);
    expect(html.match(/function swpToggleOrderDetails\(\)/g)).toHaveLength(1);
  });
});
