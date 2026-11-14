/**
 * RWA Markets — Phase 1 (presentation only)
 * - RWA badge removed from market cards
 * - hover "Trade →" button (visual hint; click bubbles to the existing card handler)
 * - active filter chips + "Clear all"
 * - no-results state with "Clear filters"
 * Trade/quote/execution logic is untouched.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
const fn = (name, size = 4500) => {
  const i = html.indexOf('function ' + name + '(');
  expect(i).toBeGreaterThan(-1);
  return html.slice(i, i + size);
};

describe('RWA markets card', () => {
  const filter = fn('rwaFilterMarkets', 5500);
  it('no longer renders the per-card RWA badge', () => {
    expect(filter).not.toContain("rwa-card-tag");
    expect(filter).not.toContain("tag.textContent = 'RWA'");
  });
  it('adds a keyboard-accessible Trade button that relies on the existing card click', () => {
    expect(filter).toContain("cta.className = 'rwa-card-cta'");
    expect(filter).toContain("cta.type = 'button'");
    expect(filter).toContain("card.addEventListener('click', function() { rwaSelectMarketToken(t); })");
    expect(filter).not.toMatch(/cta\.addEventListener/);
  });
  it('CTA is hidden until hover/focus and always visible on touch devices', () => {
    expect(html).toMatch(/\.rwa-card-cta\{[^}]*opacity:0/);
    expect(html).toContain('.rwa-card:hover .rwa-card-cta,.rwa-card-cta:focus-visible{opacity:1');
    expect(html).toContain('@media (hover:none){.rwa-card-cta{opacity:.9');
  });
});

describe('RWA active filter chips', () => {
  const chips = fn('_rwaRenderFilterChips', 2600);
  it('container exists before the grid and starts hidden', () => {
    expect(html).toMatch(/<div id="rwa-filter-chips" class="rwa-chips" style="display:none"><\/div>\s*<div id="rwa-markets-grid"/);
  });
  it('chips are built with textContent (user search text never hits innerHTML)', () => {
    expect(chips).toContain('textContent');
    expect(chips).toContain('createElement');
    expect(chips).not.toContain('innerHTML');
  });
  it('covers search, chain and issuer, each removable, plus Clear all', () => {
    expect(chips).toContain("kind: 'search'");
    expect(chips).toContain("kind: 'chain'");
    expect(chips).toContain("kind: 'issuer'");
    expect(chips).toContain("'Clear all'");
    expect(html).toContain('function _rwaClearOneFilter(');
    expect(html).toContain('function rwaClearFilters(');
  });
  it('chips refresh after every filter pass (results and no-results)', () => {
    const filter = fn('rwaFilterMarkets', 5500);
    expect((filter.match(/_rwaRenderFilterChips\(\);/g) || []).length).toBe(2);
  });
});

describe('RWA no-results state', () => {
  it('offers a Clear filters button wired to a global handler', () => {
    expect(html).toContain('<button type="button" class="rwa-empty-btn" onclick="rwaClearFilters()">Clear filters</button>');
    expect(html).toContain('window.rwaClearFilters = rwaClearFilters;');
  });
});

describe('RWA isolation / no regression', () => {
  it('trade, quote and select logic are unchanged', () => {
    const sel = fn('rwaSelectMarketToken', 700);
    expect(sel).toContain("rwaTab('trade')");
    expect(sel).toContain('rwaFetchQuote()');
    expect(html).toContain("var url = '/api/lifi/tokens?chainId=' + chainIds.join(',') + '&tags=rwa';");
  });
  it('new classes stay in the rwa- namespace', () => {
    ['rwa-card-cta', 'rwa-chips', 'rwa-chip', 'rwa-chip-x', 'rwa-chips-clear', 'rwa-empty-btn'].forEach(c => expect(html).toContain('.' + c));
  });
});
