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
// Extract a complete var assignment (array or object) via bracket counting
function extractVar(text, varName) {
  var start = text.indexOf('var ' + varName);
  if (start === -1) return '';
  // find the opening bracket
  var eq = text.indexOf('=', start);
  if (eq === -1) return '';
  var open = text.indexOf('[', eq);
  var openB = text.indexOf('{', eq);
  if (open === -1 && openB === -1) return '';
  var opener, closer;
  if (open === -1 || (openB !== -1 && openB < open)) { opener = '{'; closer = '}'; open = openB; }
  else { opener = '['; closer = ']'; }
  var depth = 0, i = open;
  while (i < text.length) {
    if (text[i] === opener) depth++;
    else if (text[i] === closer) { depth--; if (depth === 0) { return text.slice(start, i + 1) + ';'; } }
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

// ── UP6: Deposit button in new Gateway subcard ────────────────────────────────
describe('Unified Portfolio — Deposit button in Gateway subcard', () => {
  const renderFn = extractFn(html, '_ubUpRenderGwSubcard');

  it('UP6.1 — _ubUpRenderGwSubcard builds ub-gw-dep-btn buttons', () => {
    expect(renderFn).toContain('ub-gw-dep-btn');
  });

  it('UP6.2 — deposit button calls ubGwDepOpen with correct token', () => {
    expect(renderFn).toContain('ubGwDepOpen(');
    // Token is passed as the variable a.token
    expect(renderFn).toContain('a.token');
  });

  it('UP6.3 — deposit button present for success state (assetRows truthy)', () => {
    // The depBtn var is created in the else-if(assetRows) branch
    const successBranch = renderFn.slice(
      renderFn.indexOf('} else if (assetRows)'),
      renderFn.indexOf('} else {', renderFn.indexOf('} else if (assetRows)'))
    );
    expect(successBranch).toContain('ub-gw-dep-btn');
    expect(successBranch).toContain('ubGwDepOpen');
  });

  it('UP6.4 — deposit button present for loading/unknown state', () => {
    // The depBtnEmpty var is created in the else branch
    const elseBranch = renderFn.slice(
      renderFn.indexOf('} else {\n') > -1
        ? renderFn.indexOf('} else {\n')
        : renderFn.lastIndexOf('} else {'),
      renderFn.lastIndexOf('}')
    );
    expect(elseBranch).toContain('ub-gw-dep-btn');
  });

  it('UP6.5 — deposit button present for error state (errMsg branch)', () => {
    const errBranch = renderFn.slice(
      renderFn.indexOf('if (errMsg)'),
      renderFn.indexOf('} else if (assetRows)')
    );
    expect(errBranch).toContain('ub-gw-dep-btn');
    expect(errBranch).toContain('ubGwDepOpen');
  });

  it('UP6.6 — ubGwDepOpen is defined and opens the modal', () => {
    const depOpenFn = extractFn(html, 'ubGwDepOpen');
    expect(depOpenFn).toBeTruthy();
    expect(depOpenFn).toContain('ub-gw-dep-overlay');
    expect(depOpenFn).toContain('open');
  });

  it('UP6.7 — modal #ub-gw-dep-overlay still present (not removed)', () => {
    expect(html).toContain('id="ub-gw-dep-overlay"');
  });

  it('UP6.8 — deposit modal confirm button calls ubGwDepExecute', () => {
    const modal = blockAt(html, 'id="ub-gw-dep-overlay"', 3500);
    expect(modal).toContain('ubGwDepExecute');
  });

  it('UP6.9 — no duplicate ubGwDepOpen definitions', () => {
    const count = (html.match(/function ubGwDepOpen\(/g) || []).length;
    expect(count).toBe(1);
  });

  it('UP6.10 — no duplicate ub-gw-dep-confirm IDs', () => {
    const count = (html.match(/id="ub-gw-dep-confirm"/g) || []).length;
    expect(count).toBe(1);
  });

  it('UP6.11 — .ub-gw-dep-btn CSS class is defined (not inlined)', () => {
    expect(html).toContain('.ub-gw-dep-btn{');
  });

  it('UP6.12 — light theme override for .ub-gw-dep-btn present', () => {
    expect(html).toContain('[data-theme="light"] .ub-gw-dep-btn{');
  });

  // Functional: extract and execute _ubUpRenderGwSubcard with mock data
  it('UP6.13 — functional: rendered HTML contains dep button for USDC', () => {
    const src = html;
    // Extract helpers needed by _ubUpRenderGwSubcard
    const fmtSrc   = extractFn(src, '_ubGwFmt');
    const addSrc   = extractFn(src, '_ubGwAddStr');
    const assetsSrc = extractVar(src, '_UB_GW_ASSETS');
    const renderSrc = extractFn(src, '_ubUpRenderGwSubcard');

    // All four pieces are required — no fallback
    expect(renderSrc,  'renderSrc must be extracted').toBeTruthy();
    expect(fmtSrc,     'fmtSrc must be extracted').toBeTruthy();
    expect(addSrc,     'addSrc must be extracted').toBeTruthy();
    expect(assetsSrc.includes('_UB_GW_ASSETS'), 'assetsSrc must include _UB_GW_ASSETS').toBe(true);

    // Patch the render source so that document.getElementById is
    // replaced with a local mock — no global `document` needed.
    const mockedRender = renderSrc
      .replace(/document\.getElementById\(/g, '__mockGetById(');

    // Build a self-contained factory inside new Function (node env, no DOM)
    const factory = new Function(
      // 1. helpers
      assetsSrc + '\n' +
      fmtSrc    + '\n' +
      addSrc    + '\n' +

      // 2. lightweight DOM mock (local vars, capture body.innerHTML)
      'var _capturedRows = "";\n' +
      'var _mockBody     = { innerHTML: "" };\n' +
      'var _mockFooter   = { textContent: "" };\n' +
      'var _mockCard     = { style: {}, innerHTML: "" };\n' +
      'function __mockGetById(id) {\n' +
      '  if (id === "ub-up-gw-card")   return _mockCard;\n' +
      '  if (id === "ub-up-gw-body")   return _mockBody;\n' +
      '  if (id === "ub-up-gw-footer") return _mockFooter;\n' +
      '  return null;\n' +
      '}\n' +
      // Capture the rows string before it is written to the mock body
      mockedRender.replace(
        'body.innerHTML = rows ||',
        '_capturedRows = rows; body.innerHTML = rows ||'
      ) + '\n' +

      // 3. test invocation with explicit mock data
      'var _mockData = {\n' +
      '  USDC: [{ domain: 26, depositor: "0xTEST", balance: "9.079400" }],\n' +
      '  errors: {}\n' +
      '};\n' +
      '_ubUpRenderGwSubcard(_mockData);\n' +
      'return _capturedRows;'
    );

    // Execute — any error here is a real failure, NOT a fallback
    const renderedRows = factory();

    // The rendered HTML must contain the deposit button
    expect(renderedRows).toContain('ubGwDepOpen');
    expect(renderedRows).toContain('ub-gw-dep-btn');
    // The deposit button for USDC must pass the correct token
    expect(renderedRows).toContain("ubGwDepOpen('USDC')");
  });

  it('UP6.14 — functional: rendered HTML contains dep button for cirBTC with 8 decimals', () => {
    const src = html;
    const fmtSrc    = extractFn(src, '_ubGwFmt');
    const addSrc    = extractFn(src, '_ubGwAddStr');
    const assetsSrc = extractVar(src, '_UB_GW_ASSETS');
    const renderSrc = extractFn(src, '_ubUpRenderGwSubcard');

    expect(renderSrc,  'renderSrc required').toBeTruthy();
    expect(fmtSrc,     'fmtSrc required').toBeTruthy();
    expect(addSrc,     'addSrc required').toBeTruthy();

    const mockedRender = renderSrc.replace(
      /document\.getElementById\(/g, '__mockGetById('
    );

    const factory = new Function(
      assetsSrc + '\n' + fmtSrc + '\n' + addSrc + '\n' +
      'var _cap = ""; var _mb = { innerHTML: "" }; var _mf = { textContent: "" }; var _mc = { style: {}, innerHTML: "" };\n' +
      'function __mockGetById(id) {\n' +
      '  if (id==="ub-up-gw-card") return _mc;\n' +
      '  if (id==="ub-up-gw-body") return _mb;\n' +
      '  if (id==="ub-up-gw-footer") return _mf;\n' +
      '  return null;\n' +
      '}\n' +
      mockedRender.replace('body.innerHTML = rows ||', '_cap = rows; body.innerHTML = rows ||') + '\n' +
      // cirBTC has 8 decimals: 0.00012345 BTC
      'var _d = { cirBTC: [{ domain: 26, depositor: "0xTEST", balance: "0.00012345" }], errors: {} };\n' +
      '_ubUpRenderGwSubcard(_d);\n' +
      'return _cap;'
    );

    const rows = factory();
    expect(rows).toContain("ubGwDepOpen('cirBTC')");
    expect(rows).toContain('ub-gw-dep-btn');
    // cirBTC balance should not lose the 8th decimal
    expect(rows).toContain('0.00012345');
  });

  it('UP6.15 — functional: error state still renders deposit button', () => {
    const src = html;
    const fmtSrc    = extractFn(src, '_ubGwFmt');
    const addSrc    = extractFn(src, '_ubGwAddStr');
    const assetsSrc = extractVar(src, '_UB_GW_ASSETS');
    const renderSrc = extractFn(src, '_ubUpRenderGwSubcard');

    expect(renderSrc).toBeTruthy();

    const mockedRender = renderSrc.replace(/document\.getElementById\(/g, '__mockGetById(');

    const factory = new Function(
      assetsSrc + '\n' + fmtSrc + '\n' + addSrc + '\n' +
      'var _cap = ""; var _mb = { innerHTML: "" }; var _mf = { textContent: "" }; var _mc = { style: {}, innerHTML: "" };\n' +
      'function __mockGetById(id) {\n' +
      '  if (id==="ub-up-gw-card") return _mc;\n' +
      '  if (id==="ub-up-gw-body") return _mb;\n' +
      '  if (id==="ub-up-gw-footer") return _mf;\n' +
      '  return null;\n' +
      '}\n' +
      mockedRender.replace('body.innerHTML = rows ||', '_cap = rows; body.innerHTML = rows ||') + '\n' +
      // errors present, no balance data
      'var _d = { USDC: [], errors: { USDC: "RPC timeout" } };\n' +
      '_ubUpRenderGwSubcard(_d);\n' +
      'return _cap;'
    );

    const rows = factory();
    // Even in error state, deposit button must be present
    expect(rows).toContain('ub-gw-dep-btn');
    expect(rows).toContain('ubGwDepOpen');
  });
});
