/**
 * Swap — Advanced mode polish, phase 2 (presentation only):
 *  - de-duplicated wallet/network chips in the Advanced top bar (desktop)
 *  - market bar stats rendered as compact cards (desktop)
 * Every rule is scoped to #page-swap.swp-advanced and responsive rules are left alone.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
const start = html.indexOf('/* ── Advanced mode polish · phase 2');
const end = html.indexOf('/* ── Advanced mode polish · phase 3', start);
const block = html.slice(start, end);

describe('Advanced phase 2 CSS block', () => {
  it('exists and is bounded', () => {
    expect(start).toBeGreaterThan(-1);
    expect(block.length).toBeGreaterThan(400);
  });
  it('every selector is scoped to #page-swap.swp-advanced and never mentions Standard', () => {
    const rules = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, '').split('}').map(r => r.trim()).filter(Boolean);
    expect(rules.length).toBeGreaterThan(5);
    rules.forEach(r => {
      r.slice(0, r.indexOf('{')).split(',').map(x => x.trim()).filter(Boolean).forEach(sel => {
        expect(sel, sel).toMatch(/^#page-swap\.swp-advanced\b/);
      });
    });
    expect(block).not.toContain('swp-standard');
  });
  it('wallet/network de-dup is desktop-only (mobile keeps its header chips)', () => {
    expect(block).toMatch(/@media\(min-width:769px\)\{\s*#page-swap\.swp-advanced \.st-header \.st-net-pill,\s*#page-swap\.swp-advanced \.st-header \.st-wallet-btn\{display:none\}/);
  });
  it('keeps the dynamic page-header chips (real address / active chain) and the settings gear', () => {
    expect(block).not.toContain('swp-std');
    expect(block).not.toContain('st-settings-btn');
    expect(html).toContain('id="swp-std-wallet-label"');
    expect(html).toContain('id="swp-std-network"');
    expect(html).toContain('onclick="swpToggleSettings()" title="Swap settings"');
  });
  it('market cards are desktop-only and do not override display (responsive hide rules still win)', () => {
    expect(block).toContain('@media(min-width:961px)');
    const cards = block.slice(block.indexOf('@media(min-width:961px)'));
    expect(cards).not.toMatch(/display\s*:/);
    expect(cards).toContain('.st-market-stat');
    expect(cards).toContain('border-radius:8px');
    expect(cards).toContain('var(--panel-bg2)');
  });
});

describe('Responsive + shared base rules unchanged', () => {
  it('original market bar / stat rules and breakpoints are intact', () => {
    expect(html).toContain('.st-market-bar{display:flex;align-items:center;gap:0;height:34px;');
    expect(html).toContain('.st-market-stat{display:flex;flex-direction:column;align-items:flex-start;justify-content:center;padding:0 14px;height:100%;border-right:1px solid #1a1f2e;');
    expect(html).toContain('@media(max-width:960px){.st-right-panels{width:340px}.st-market-stat{display:none}');
    expect(html).toContain('.st-market-stat{min-width:52px;padding:0 7px;display:none}');
  });
  it('the Advanced header markup and its wallet sync hooks are untouched', () => {
    expect(html).toContain('<span id="st-wallet-label">Connect Wallet</span>');
    expect(html).toContain('<div class="st-net-pill" onclick="openNetworkSelector()" style="cursor:pointer"><div class="pulse"></div>Arc Mainnet</div>');
    expect(html).toContain("var stLbl = document.getElementById('st-wallet-label');");
    expect(html).toContain("const lbl = document.getElementById('swp-std-wallet-label');");
  });
  it('Standard rules are intact', () => {
    expect(html).toContain('#page-swap.swp-standard .st-market-bar{display:none}');
    expect(html).toContain('#page-swap.swp-standard .swp-std-header{display:flex}');
  });
});
