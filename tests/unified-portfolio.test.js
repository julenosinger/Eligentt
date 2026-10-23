/**
 * tests/unified-portfolio.test.js
 * Unified Portfolio — EVM Wallet + Gateway subcards, asset row injection.
 * All structural tests — no live RPC or wallet required.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';

const html = fs.readFileSync('/home/user/app/index.html', 'utf8');

// ── helpers ──────────────────────────────────────────────────────────────────
function blockAt(text, anchor, size) {
  var idx = text.indexOf(anchor);
  if (idx === -1) return '';
  return text.slice(idx, idx + size);
}
function fnBlock(text, name, size) {
  return blockAt(text, 'function ' + name + '(', size);
}
// Extract a complete function body via brace counting
function extractFn(text, name) {
  var start = text.indexOf('function ' + name + '(');
  if (start === -1) return '';
  var depth = 0; var i = start;
  while (i < text.length) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
    i++;
  }
  return '';
}

// ── UP1: HTML structure ───────────────────────────────────────────────────────
describe('Unified Portfolio — HTML structure', () => {
  it('UP1.1 — ub-up-subcards container present', () => {
    expect(html).toContain('class="ub-up-subcards"');
  });
  it('UP1.2 — EVM Wallet subcard present with correct ID', () => {
    expect(html).toContain('id="ub-up-evm-card"');
    expect(html).toContain('id="ub-up-evm-body"');
  });
  it('UP1.3 — Circle Gateway subcard present with correct ID', () => {
    expect(html).toContain('id="ub-up-gw-card"');
    expect(html).toContain('id="ub-up-gw-body"');
  });
  it('UP1.4 — ub-up-subcards is inside the portfolio header card', () => {
    const headerIdx = html.indexOf('class="ub2-header card"');
    const subcardsIdx = html.indexOf('class="ub-up-subcards"');
    expect(headerIdx).toBeGreaterThan(-1);
    expect(subcardsIdx).toBeGreaterThan(headerIdx);
    // subcards must be before the main grid
    const gridIdx = html.indexOf('class="ub2-grid"');
    expect(subcardsIdx).toBeLessThan(gridIdx);
  });
  it('UP1.5 — Gateway subcard has "Circle Gateway" label', () => {
    const card = blockAt(html, 'id="ub-up-gw-card"', 400);
    expect(card).toContain('Circle Gateway');
  });
  it('UP1.6 — EVM subcard has "EVM Wallet" label', () => {
    const card = blockAt(html, 'id="ub-up-evm-card"', 300);
    expect(card).toContain('EVM Wallet');
  });
  it('UP1.7 — ub-gateway-card (data source) is hidden, not removed', () => {
    expect(html).toContain('id="ub-gateway-card"');
    const gw = blockAt(html, 'id="ub-gateway-card"', 200);
    expect(gw).toContain('display:none');
  });
  it('UP1.8 — original ub-gw-* IDs still present (ubGatewayFetch compat)', () => {
    expect(html).toContain('id="ub-gw-loading"');
    expect(html).toContain('id="ub-gw-error"');
    expect(html).toContain('id="ub-gw-assets"');
    expect(html).toContain('id="ub-gw-refresh-icon"');
    expect(html).toContain('id="ub-gw-updated"');
  });
});

// ── UP2: CSS ─────────────────────────────────────────────────────────────────
describe('Unified Portfolio — CSS', () => {
  it('UP2.1 — .ub-up-subcards defined', () => {
    expect(html).toContain('.ub-up-subcards{');
  });
  it('UP2.2 — .ub-up-subcard defined with flex layout', () => {
    expect(html).toContain('.ub-up-subcard{');
    expect(blockAt(html, '.ub-up-subcard{', 200)).toContain('flex');
  });
  it('UP2.3 — .ub-up-subcard.gw distinguishes Gateway subcard', () => {
    expect(html).toContain('.ub-up-subcard.gw{');
  });
  it('UP2.4 — light mode overrides present', () => {
    expect(html).toContain('[data-theme="light"] .ub-up-subcard{');
    expect(html).toContain('[data-theme="light"] .ub-up-subcard.gw{');
  });
  it('UP2.5 — .ub2-gw-row defined for asset breakdown injection', () => {
    expect(html).toContain('.ub2-gw-row{');
  });
  it('UP2.6 — responsive breakpoint for subcards', () => {
    expect(html).toContain('min-width:100%');
    expect(html).toContain('ub-up-subcard');
  });
});

// ── UP3: JS functions ─────────────────────────────────────────────────────────
describe('Unified Portfolio — JS functions', () => {
  it('UP3.1 — _ubGwLastData variable declared', () => {
    expect(html).toContain('_ubGwLastData');
  });
  it('UP3.2 — _ubUpRenderGwSubcard function exists', () => {
    expect(extractFn(html, '_ubUpRenderGwSubcard')).toBeTruthy();
  });
  it('UP3.3 — _ubUpRenderEvmSubcard function exists', () => {
    expect(extractFn(html, '_ubUpRenderEvmSubcard')).toBeTruthy();
  });
  it('UP3.4 — _ubUpInjectGwRows function exists', () => {
    expect(extractFn(html, '_ubUpInjectGwRows')).toBeTruthy();
  });
  it('UP3.5 — ubGatewayRender stores _ubGwLastData before subcard render', () => {
    const fn = extractFn(html, 'ubGatewayRender');
    const lastIdx = fn.indexOf('_ubGwLastData = data');
    const subcardIdx = fn.indexOf('_ubUpRenderGwSubcard');
    expect(lastIdx).toBeGreaterThan(-1);
    expect(subcardIdx).toBeGreaterThan(lastIdx); // store before render
  });
  it('UP3.6 — ubGatewayRender calls ubFilterAssets to re-render asset rows', () => {
    const fn = extractFn(html, 'ubGatewayRender');
    expect(fn).toContain('ubFilterAssets()');
  });
  it('UP3.7 — ubRenderAll calls _ubUpRenderEvmSubcard', () => {
    const fn = extractFn(html, 'ubRenderAll');
    expect(fn).toContain('_ubUpRenderEvmSubcard');
  });
  it('UP3.8 — ubFilterAssets calls _ubUpInjectGwRows when _ubGwLastData present', () => {
    const fn = extractFn(html, 'ubFilterAssets');
    expect(fn).toContain('_ubGwLastData');
    expect(fn).toContain('_ubUpInjectGwRows');
  });
  it('UP3.9 — _ubUpRenderGwSubcard uses _ubGwAddStr (no parseFloat for totals)', () => {
    const fn = extractFn(html, '_ubUpRenderGwSubcard');
    expect(fn).toContain('_ubGwAddStr');
    expect(fn).not.toContain('parseFloat');
  });
  it('UP3.10 — _ubUpRenderEvmSubcard does NOT touch UB.state.totalUSD', () => {
    const fn = extractFn(html, '_ubUpRenderEvmSubcard');
    expect(fn).not.toContain('totalUSD');
    expect(fn).not.toContain('ubRenderHero');
  });
  it('UP3.11 — _ubUpInjectGwRows does NOT modify UB.state', () => {
    const fn = extractFn(html, '_ubUpInjectGwRows');
    expect(fn).not.toContain('UB.state');
  });
});

// ── UP4: No double-counting ───────────────────────────────────────────────────
describe('Unified Portfolio — no double counting', () => {
  it('UP4.1 — _ubUpRenderEvmSubcard reads UB.state.assets (EVM only)', () => {
    const fn = extractFn(html, '_ubUpRenderEvmSubcard');
    expect(fn).toContain('UB.state.assets');
    expect(fn).not.toContain('_ubGwLastData');
  });
  it('UP4.2 — _ubUpRenderGwSubcard reads only data param (Gateway only)', () => {
    const fn = extractFn(html, '_ubUpRenderGwSubcard');
    expect(fn).not.toContain('UB.state');
    expect(fn).not.toContain('UB.evm');
  });
  it('UP4.3 — ubRenderHero totalUSD not modified by Gateway functions', () => {
    const renderHero = extractFn(html, 'ubRenderHero');
    expect(renderHero).not.toContain('_ubGwLastData');
    expect(renderHero).not.toContain('_ubGwAddStr');
  });
  it('UP4.4 — ubFilterAssets totalUSD from UB.state only (no gateway addition)', () => {
    const fn = extractFn(html, 'ubFilterAssets');
    // total should come from UB.state, never from _ubGwLastData
    const totalIdx = fn.indexOf('UB.state.totalUSD');
    expect(totalIdx).toBeGreaterThan(-1);
    // injection happens after innerHTML = html (purely DOM, not data mutation)
    const htmlSetIdx = fn.indexOf('container.innerHTML = html');
    const injectIdx  = fn.indexOf('_ubUpInjectGwRows');
    expect(injectIdx).toBeGreaterThan(htmlSetIdx);
  });
  it('UP4.5 — ub-hero-total not updated by Gateway subcard render', () => {
    const fn = extractFn(html, '_ubUpRenderGwSubcard');
    expect(fn).not.toContain('ub-hero-total');
  });
});

// ── UP5: State independence ───────────────────────────────────────────────────
describe('Unified Portfolio — source independence', () => {
  it('UP5.1 — Gateway error does not clear EVM body', () => {
    // ubGatewayFetch catch path only sets ub-gw-error, not ub-up-evm-body
    const fetchFn = extractFn(html, 'ubGatewayFetch');
    const catchIdx = fetchFn.indexOf('.catch(');
    const catchBlock = fetchFn.slice(catchIdx, catchIdx + 400);
    expect(catchBlock).not.toContain('ub-up-evm-body');
  });
  it('UP5.2 — ubRefresh failure path does not clear ub-up-gw-body', () => {
    const refreshFn = extractFn(html, 'ubRefresh');
    // ubRefresh only handles EVM state; Gateway is independent
    expect(refreshFn).not.toContain('ub-up-gw-body');
  });
  it('UP5.3 — _ubUpRenderGwSubcard is safe when called before EVM loads', () => {
    const fn = extractFn(html, '_ubUpRenderGwSubcard');
    // Must guard against missing DOM elements
    expect(fn).toContain('if (!card');
  });
  it('UP5.4 — _ubUpInjectGwRows is safe when _ubGwLastData is null', () => {
    const fn = extractFn(html, '_ubUpInjectGwRows');
    expect(fn).toContain('_ubGwLastData');
    // Early return when no data
    const guardIdx = fn.indexOf('if (!_ubGwLastData');
    expect(guardIdx).toBeGreaterThan(-1);
  });
  it('UP5.5 — ub-up-gw-card initially hidden (display:none)', () => {
    const card = blockAt(html, 'id="ub-up-gw-card"', 100);
    expect(card).toContain('display:none');
  });
});
