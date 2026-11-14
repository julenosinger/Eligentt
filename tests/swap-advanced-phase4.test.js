/**
 * Swap — Advanced mode polish, phase 4 (CSS only):
 *  - styled `warn` state, light-theme disabled border, loading sweep for the main action button
 *  - indeterminate bar on the Order details header while an action is in flight
 *  - skeleton shimmer for the chart loading overlay
 * swpSetBtn (labels + state classes) is shared with Standard and must stay untouched.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
const start = html.indexOf('/* ── Advanced mode polish · phase 4');
const end = html.indexOf('\n.swap-route-head{', start);
const block = html.slice(start, end);

describe('phase 4 CSS block', () => {
  it('exists and is bounded', () => {
    expect(start).toBeGreaterThan(-1);
    expect(block.length).toBeGreaterThan(900);
  });
  it('every selector is Advanced-scoped (keyframes aside) and never mentions Standard', () => {
    const body = block.replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/@keyframes [\w-]+\{[^@]*?\}\}/g, '')   // drop keyframes blocks
      .replace(/@media[^{]*\{/g, '');
    const rules = body.split('}').map(r => r.trim()).filter(Boolean);
    expect(rules.length).toBeGreaterThan(8);
    rules.forEach(r => {
      r.slice(0, r.indexOf('{')).split(',').map(x => x.trim()).filter(Boolean).forEach(sel => {
        expect(sel, sel).toMatch(/^(\[data-theme="light"\] )?#page-swap\.swp-advanced\b/);
      });
    });
    expect(block).not.toContain('swp-standard');
  });
  it('warn state is amber and the light disabled border uses the theme token', () => {
    expect(block).toContain('.st-swap-submit.warn{background:rgba(245,158,11,.12)');
    expect(block).toContain('[data-theme="light"] #page-swap.swp-advanced .st-swap-submit.disabled{border-color:var(--border)}');
  });
  it('loading: transparent inner label (no purple box) and a non-interactive sweep overlay', () => {
    expect(block).toContain('.st-swap-submit.loading .swp-btn-loading{position:relative;z-index:1;background:none;color:#000}');
    expect(block).toMatch(/\.st-swap-submit\.loading::after\{[^}]*pointer-events:none/);
  });
  it('in-flight bar is keyed off the real button state via :has() and degrades silently', () => {
    expect(block).toContain('.st-swap-body:has(#swap-btn.loading) .swp-det-toggle::after');
  });
  it('animations are paused for prefers-reduced-motion', () => {
    expect(block).toMatch(/@media \(prefers-reduced-motion:reduce\)\{[\s\S]*animation:none/);
  });
  it('new keyframe names are unique in the document', () => {
    ['swpAdvBtnSweep', 'swpAdvDetBar', 'swpAdvChartSk'].forEach(n =>
      expect(html.match(new RegExp('@keyframes ' + n + '\\b', 'g'))).toHaveLength(1));
  });
});

describe('shared logic and legacy styles untouched', () => {
  it('swpSetBtn still maps states to the same classes and default labels', () => {
    const i = html.indexOf('function swpSetBtn(state, label) {');
    const fn = html.slice(i, i + 3000);
    expect(fn).toContain("btn.classList.add('loading');");
    expect(fn).toContain("btn.classList.add('connect'); btn.disabled = false;");
    expect(fn).toContain("btn.classList.add('warn'); btn.disabled = false;");
    expect(fn).toContain("label || 'Enter an amount'");
    expect(fn).toContain("label || 'Connect Wallet'");
    expect(fn).toContain("label || 'Swap Anyway'");
  });
  it('legacy base rules (also used by Standard) are intact', () => {
    expect(html).toContain('.st-swap-submit.loading{background:#06F7E9;color:#000;cursor:wait}');
    expect(html).toContain('.st-swap-submit.disabled{background:rgba(255,255,255,.02);border:1px solid #1a1f2e;color:var(--muted2);cursor:not-allowed}');
    expect(html).toContain('.swp-btn-loading{\n  background:linear-gradient(135deg,#6d58f7,#a78bfa);');
    expect(html).toContain('.st-chart-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;z-index:5;background:var(--panel-bg4)}');
  });
  it('no JS was added for this phase', () => {
    expect(block).not.toContain('<script');
    const all = (html.match(/swpAdv\w+/g) || []).length;
    const inBlock = (block.match(/swpAdv\w+/g) || []).length;
    expect(all).toBe(inBlock); // names exist only inside the CSS block
  });
});
