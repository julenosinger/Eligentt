/**
 * Swap — Standard on mobile.
 * Root cause: the mobile terminal rule `.st-right-panels{position:fixed !important; bottom:60px; max-height:70vh ...}`
 * (an Advanced bottom sheet) also applied to Standard, which reuses the same element, so the Standard
 * card floated at the bottom of the viewport with a large empty block above it.
 * These checks guard the CSS contract; real layout was validated in a browser (320–1440px).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
const marker = '/* ── Swap · Standard on mobile';
const i = html.indexOf(marker);
const j = html.indexOf('/* ═══════════════════════════════════════════════════════\n   SWAP UI 2.0', i);
const block = html.slice(i, j);

describe('Standard mobile fix — CSS block', () => {
  it('exists, sits inside a single max-width:768px media query', () => {
    expect(i).toBeGreaterThan(-1);
    expect(block).toContain('@media(max-width:768px){');
    expect((block.match(/@media/g) || []).length).toBe(1);
  });
  it('every selector is restricted to #page-swap.swp-standard (nothing global, nothing for Advanced)', () => {
    const body = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, '');
    const rules = body.split('}').map(r => r.trim()).filter(Boolean);
    expect(rules.length).toBe(3);
    rules.forEach(r => expect(r.slice(0, r.indexOf('{')).trim(), r).toMatch(/^#page-swap\.swp-standard\s/));
    expect(block).not.toContain('swp-advanced');
  });
  it('neutralises the bottom sheet for Standard (back to normal flow) with the minimum set of properties', () => {
    expect(block).toContain('#page-swap.swp-standard .st-right-panels{position:static !important;bottom:auto;left:auto;right:auto;max-height:none;z-index:auto;background:transparent;border-top:0;border-radius:0;box-shadow:none;transform:none;transition:none}');
  });
  it('clears the fixed bottom navigation and respects the iOS/Android safe area', () => {
    expect(block).toContain('#page-swap.swp-standard .st-main-area{padding:12px 12px calc(80px + env(safe-area-inset-bottom,0px))}');
  });
  it('the CTA is not sticky inside the page scroller (would hide under the bottom nav)', () => {
    expect(block).toContain('#page-swap.swp-standard .st-swap-submit{position:static}');
  });
  it('no compensating hacks: no negative margins, translateY, fixed heights or JS', () => {
    expect(block).not.toMatch(/margin[^:]*:\s*-/);
    expect(block).not.toMatch(/translate/);
    expect(block).not.toMatch(/[^-]height\s*:\s*\d/);
    expect(block).not.toContain('<script');
  });
});

describe('Advanced bottom sheet is untouched', () => {
  it('the mobile sheet rule and its three snap states are byte-identical', () => {
    expect(html).toContain('.st-right-panels{position:fixed !important;bottom:calc(60px + env(safe-area-inset-bottom,0px));left:0;right:0;width:100% !important;max-height:70vh;z-index:300;background:var(--surface,#0d0f17);border-radius:16px 16px 0 0;border-left:none !important;border-top:1px solid var(--border,#1a1f2e);box-shadow:0 -4px 24px rgba(0,0,0,.5);display:flex;flex-direction:column;overflow:hidden;transform:translateY(0);transition:transform .3s cubic-bezier(.4,0,.2,1),max-height .3s cubic-bezier(.4,0,.2,1);padding:0}');
    expect(html).toContain('.st-right-panels.sheet-collapsed{transform:translateY(calc(100% - 56px))}');
    expect(html).toContain('.st-right-panels.sheet-half{transform:translateY(0);max-height:56vh}');
    expect(html).toContain('.st-right-panels.sheet-full{transform:translateY(0);max-height:calc(100dvh - 96px);max-height:calc(100vh - 96px)}');
  });
  it('the sheet JS (drag, snap, keyboard lift) is unchanged', () => {
    expect(html).toContain('window.stSheetCollapse = function() {');
    expect(html).toContain('window.stSheetHalf = function() {');
    expect(html).toContain('window.stSheetFull = function() {');
    expect(html).toContain("sheet.style.bottom = (lift > 90 && currentState === 'full') ? (lift + 'px') : '';");
  });
  it('existing Standard desktop/tablet rules are unchanged', () => {
    expect(html).toContain('#page-swap.swp-standard .st-main-area{flex:0 0 auto;height:auto;min-height:0;overflow:visible;display:block;padding:28px 16px 48px}');
    expect(html).toContain('#page-swap.swp-standard .st-right-panels{width:100%;max-width:920px;margin:0 auto;border-left:none;overflow:visible;height:auto;flex-direction:row;align-items:flex-start;gap:16px}');
    expect(html).toContain('#page-swap.swp-standard .st-right-panels{flex-direction:column;max-width:480px}');
  });
});
