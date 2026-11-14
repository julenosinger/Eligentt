/**
 * Batch Payments — light theme surfaces (CSS only).
 * Guards: light overrides exist, are scoped to #page-batch, dark rules untouched.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';

const src = fs.readFileSync('index.html', 'utf8');
const lightRules = src.split('\n').filter(l => l.startsWith('[data-theme="light"] #page-batch'));
const lightCss = lightRules.join('\n');

describe('Batch Payments light theme surfaces', () => {
  it('overrides table inputs, selects, split-bill inputs and generic inputs', () => {
    ['.ms-table-input', '.ms-chain-select', '.ms-token-select', '.bp-split-input', '.cinput']
      .forEach(sel => expect(lightCss).toContain(sel));
  });
  it('uses light surface tokens, not translucent black', () => {
    expect(lightCss).toContain('var(--card2)');
    expect(lightCss).not.toMatch(/rgba\(0,\s*0,\s*0,\s*\.(1|2)\d*\)/);
  });
  it('native select popup is light in light theme', () => {
    expect(lightCss).toContain('color-scheme:light');
  });
  it('every light override is scoped to #page-batch (no global leak)', () => {
    lightRules.forEach(l => expect(l.startsWith('[data-theme="light"] #page-batch')).toBe(true));
    expect(src).not.toMatch(/\n\[data-theme="light"\] \.ms-(table-input|chain-select|token-select)/);
  });
  it('sender bar uses a themable variable with the original dark fallback', () => {
    expect(src).toContain('background:var(--ms-sender-bg,rgba(0,0,0,.12))');
    expect(lightCss).toContain('--ms-sender-bg:var(--card2)');
  });
  it('dark-theme rules are unchanged', () => {
    expect(src).toContain('.ms-table-input{\n  background:rgba(0,0,0,.15);');
    expect(src).toContain('.ms-chain-select{\n  background:rgba(0,0,0,.2);');
    expect(src).toContain('.bp-split-input{flex:1;background:rgba(0,0,0,.2);');
    expect(src).toContain('.cinput{width:100%;background:rgba(0,0,0,.2);');
    expect(src).toContain('.ms-chain-select, .ms-token-select { color-scheme: dark; }');
  });
  it('no recipient/send logic touched by the change', () => {
    ['function renderTable(', 'function removeRow(', 'function setAllRecipientsChain(']
      .forEach(fn => expect(src).toContain(fn));
  });
});

// ── Billing (#page-invoices) light-theme surfaces ─────────────────────────────
describe('Billing light theme — #page-invoices .cinput', () => {
  const rule = (sel) => {
    const i = src.indexOf(sel);
    expect(i).toBeGreaterThan(-1);
    return src.slice(i, src.indexOf('}', i) + 1);
  };
  it('inputs/selects/textareas use light surface tokens', () => {
    const r = rule('[data-theme="light"] #page-invoices .cinput{');
    expect(r).toContain('var(--card2)');
    expect(r).toContain('var(--border)');
    expect(r).not.toMatch(/rgba\(0,\s*0,\s*0/);
  });
  it('focus state and native select popup are light', () => {
    expect(rule('[data-theme="light"] #page-invoices .cinput:focus{')).toContain('var(--blue)');
    expect(rule('[data-theme="light"] #page-invoices select.cinput{')).toContain('color-scheme:light');
    expect(rule('[data-theme="light"] #page-invoices select.cinput option{')).toContain('var(--select-opt-bg)');
  });
  it('global .cinput (dark) is unchanged and every new rule is light+billing scoped', () => {
    expect(src).toContain(".cinput{width:100%;background:rgba(0,0,0,.2);border:1px solid var(--border)");
    const rules = src.match(/^.*#page-invoices .*$/gm).filter(l => l.includes('data-theme="light"'));
    expect(rules.length).toBeGreaterThanOrEqual(4);
    rules.forEach(l => expect(l.startsWith('[data-theme="light"] #page-invoices')).toBe(true));
  });
});

// ── Batch light theme: stats strip frame + table surface ──────────────────────
describe('Batch light theme — stats strip and table surface', () => {
  const rule = (sel) => {
    const i = src.indexOf(sel);
    expect(i).toBeGreaterThan(-1);
    return src.slice(i, src.indexOf('}', i) + 1);
  };
  it('stats strip frame uses the surface token (no --border frame) in light only', () => {
    expect(rule('[data-theme="light"] #page-batch .stats-row{')).toContain('var(--surface)');
    expect(rule('[data-theme="light"] #page-batch .stats-row .stat-box+.stat-box{')).toContain('border-left:1px solid var(--border)');
  });
  it('table wrapper is a light surface in light only; base rules untouched', () => {
    expect(rule('[data-theme="light"] #page-batch .ms-table-wrap{')).toContain('var(--surface)');
    expect(src).toContain('.stats-row{display:flex;gap:1px;background:var(--border);flex-shrink:0}');
  });
});

// ── Bridge Destination Readiness panel (light) ────────────────────────────────
describe('Bridge light theme — Destination Readiness panel', () => {
  it('light override uses surface tokens, scoped to the bridge panel', () => {
    const sel = '[data-theme="light"] #page-bridge #dgv-panel-bridge{';
    const i = src.indexOf(sel);
    expect(i).toBeGreaterThan(-1);
    const r = src.slice(i, src.indexOf('}', i) + 1);
    expect(r).toContain('var(--card2)');
    expect(r).toContain('var(--border)');
    expect(r).not.toMatch(/rgba\(0,\s*0,\s*0/);
  });
  it('dark base rule for the panel is unchanged', () => {
    expect(src).toContain("#page-bridge #dgv-panel-bridge{margin:0;border-radius:0 0 10px 10px;border-top:1px solid rgba(255,255,255,0.06);border-left:none;border-right:none;border-bottom:none;background:rgba(0,0,0,0.18)}");
  });
});
