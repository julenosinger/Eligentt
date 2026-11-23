/**
 * light-premium-tokens.test.js
 * ═══════════════════════════════════════════════════════════════════════════
 * Light Mode Premium 2.0 — isolation + accessibility guards.
 *
 *  - every rule in the Premium layer is scoped to Light Mode and excludes Unified Balance
 *  - the dark token block is untouched
 *  - the palette keeps text contrast at WCAG AA for the roles it is used in
 *  - the layer is presentation only (no scripts, no !important beyond the documented one)
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(path.resolve(__dirname, '..'), 'index.html'), 'utf8');

const START = html.lastIndexOf('/*', html.indexOf('LIGHT MODE PREMIUM 2.0 — semantic token layer'));
const END = html.indexOf('body{display:flex;flex-direction:column;overflow-y:auto;}', START);
const layer = html.slice(START, END);
const SCOPE = 'html[data-theme="light"]:not(:has(#page-unified-balance.active))';

function rules(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  clean.replace(/([^{}]+)\{([^{}]*)\}/g, (_, sel, body) => { out.push({ sel: sel.trim(), body }); return ''; });
  return out;
}

describe('Premium layer — isolation', () => {
  const rs = rules(layer);

  it('the layer exists and has rules', () => {
    expect(START).toBeGreaterThan(0);
    expect(END).toBeGreaterThan(START);
    expect(rs.length).toBeGreaterThan(10);
  });

  it('every selector is Light-only and excludes Unified Balance', () => {
    rs.forEach(({ sel }) => {
      sel.split(',').forEach((part) => {
        expect(part.trim().startsWith(SCOPE), `unscoped selector: ${part.trim().slice(0, 80)}`).toBe(true);
      });
    });
  });

  it('never targets the dark theme or the bare :root', () => {
    expect(layer).not.toMatch(/data-theme="dark"/);
    expect(layer).not.toMatch(/(^|\n)\s*:root/);
  });

  it('is presentation only: no scripts, no url(), no @import', () => {
    expect(layer).not.toMatch(/<script|url\(|@import|javascript:/i);
  });

  it('the only !important is the documented Source tray override', () => {
    const imp = rs.filter((r) => /!important/.test(r.body));
    expect(imp.length).toBe(1);
    expect(imp[0].sel).toContain('#sa-origin-bar');
    expect(layer).toContain('hard-codes its dark tray inline');
  });

  it('does not use universal or bare element selectors', () => {
    rs.forEach(({ sel }) => {
      const tail = sel.split(',').map((p) => p.trim().slice(SCOPE.length).trim());
      tail.forEach((t) => {
        expect(t === '' || /^[.#]/.test(t), `too broad: ${t}`).toBe(true);
        expect(t).not.toMatch(/(^|\s)\*(\s|$)/);
      });
    });
  });
});

describe('Dark tokens and previous Light tokens stay untouched', () => {
  it('dark block still holds its original values', () => {
    const dark = html.slice(html.indexOf(':root,[data-theme="dark"]{'), html.indexOf('[data-theme="light"]{'));
    expect(dark).toContain('--bg:#0b0d12;--surface:#111318;--card:#161a24;--card2:#1c2130;');
    expect(dark).toContain('--text:#dde2f0;--muted:#606880;--muted2:#8892aa;');
    expect(dark).not.toContain('--lt-');
  });

  it('previous Light block (used by Unified Balance) is preserved', () => {
    const light = html.slice(html.indexOf('[data-theme="light"]{'), html.indexOf('html,body{height:100%'));
    expect(light).toContain('--bg:#f0f2f7;--surface:#ffffff;--card:#ffffff;--card2:#f4f6fb;');
    expect(light).toContain('--text:#1a1f2e;--muted:#6b7280;--muted2:#4b5563;');
  });
});

describe('Palette (reference values + accessibility)', () => {
  const lum = (h) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const tok = (name) => (layer.match(new RegExp('--' + name + ':(#[0-9A-Fa-f]{6})')) || [])[1];

  it('declares the approved surfaces', () => {
    expect(tok('bg')).toBe('#F8F5F0');
    expect(tok('card')).toBe('#FFFFFF');
    expect(tok('surface')).toBe('#FFFFFF');
    expect(tok('border')).toBe('#E1E6EE');
    expect(tok('text')).toBe('#14213D');
    expect(tok('input-bg')).toBe('#F8FAFC');
  });

  const surfaces = ['card', 'bg'];
  it('body text, secondary and muted text meet AA on cards and canvas', () => {
    surfaces.forEach((s) => {
      expect(ratio(tok('text'), tok(s))).toBeGreaterThanOrEqual(7);
      expect(ratio(tok('muted2'), tok(s))).toBeGreaterThanOrEqual(4.5);
      expect(ratio(tok('muted'), tok(s))).toBeGreaterThanOrEqual(4.5);
    });
    expect(ratio(tok('muted'), tok('input-bg'))).toBeGreaterThanOrEqual(4.5);
  });

  it('teal text and financial blue meet AA on white, canvas and the selected tint', () => {
    [tok('card'), tok('bg'), '#E6F7F4'].forEach((s) => expect(ratio(tok('teal'), s)).toBeGreaterThanOrEqual(4.5));
    [tok('card'), tok('bg')].forEach((s) => expect(ratio(tok('blue'), s)).toBeGreaterThanOrEqual(4.5));
    expect(ratio('#FFFFFF', tok('blue'))).toBeGreaterThanOrEqual(4.5);
  });

  it('status colors stay readable on white', () => {
    ['green', 'yellow', 'red'].forEach((c) => expect(ratio(tok(c), tok('card'))).toBeGreaterThanOrEqual(4.5));
  });
});
