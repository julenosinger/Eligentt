/**
 * RWA Advanced Trading — structural + regression tests
 * Validates:
 *   1. Nav item and page HTML structure
 *   2. CSS scoping (rwa- namespace only)
 *   3. JS functions present and correctly scoped
 *   4. Policy handling (allowed / blocked / unknown states)
 *   5. Token picker, quote fetch, route comparison, confirm modal
 *   6. History persistence, dedup, status update, filter
 *   7. XSS safety (safe DOM construction, no unsafe innerHTML)
 *   8. Explorer URL validation
 *   9. Scope isolation (no modifications to Swap/Bridge/Send/etc)
 *  10. showPage hook (rwa lazy-load)
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');

// ── helpers ──────────────────────────────────────────────────────────────────

function fnBlock(src, name, size) {
  var idx = src.indexOf('function ' + name + '(');
  if (idx === -1) idx = src.indexOf('async function ' + name + '(');
  if (idx === -1) return '';
  return src.slice(idx, idx + (size || 3000));
}

function blockAt(src, anchor, size) {
  var idx = src.indexOf(anchor);
  if (idx === -1) return '';
  return src.slice(idx, idx + (size || 3000));
}

// ── N1: Nav item ─────────────────────────────────────────────────────────────

describe('N1 — Nav item', () => {
  it('nav-rwa item exists with showPage("rwa")', () => {
    expect(html).toContain('id="nav-rwa"');
    expect(html).toContain("showPage('rwa')");
  });
  it('nav-rwa has correct icon and label', () => {
    const block = blockAt(html, 'id="nav-rwa"', 200);
    expect(block).toContain('ti-chart-candle');
    expect(block).toContain('RWA');
  });
  it('nav-rwa has Pro badge', () => {
    const block = blockAt(html, 'id="nav-rwa"', 400);
    expect(block).toContain('Pro');
  });
});

// ── N2: Page HTML structure ───────────────────────────────────────────────────

describe('N2 — Page HTML structure', () => {
  it('page-rwa div exists with class page', () => {
    expect(html).toContain('id="page-rwa"');
    // The page uses rwa-shell as inner container; the outer div has id=page-rwa
    const block = blockAt(html, 'id="page-rwa"', 200);
    expect(block).toContain('rwa-shell');
  });
  it('rwa-shell container exists', () => {
    expect(html).toContain('class="rwa-shell"');
  });
  it('all 5 sub-tabs exist', () => {
    expect(html).toContain('id="rwa-tab-markets"');
    expect(html).toContain('id="rwa-tab-trade"');
    expect(html).toContain('id="rwa-tab-routes"');
    expect(html).toContain('id="rwa-tab-portfolio"');
    expect(html).toContain('id="rwa-tab-history"');
  });
  it('all 5 panels exist', () => {
    expect(html).toContain('id="rwa-panel-markets"');
    expect(html).toContain('id="rwa-panel-trade"');
    expect(html).toContain('id="rwa-panel-routes"');
    expect(html).toContain('id="rwa-panel-portfolio"');
    expect(html).toContain('id="rwa-panel-history"');
  });
  it('token picker overlay exists', () => {
    expect(html).toContain('id="rwa-picker-overlay"');
    expect(html).toContain('id="rwa-picker-list"');
    expect(html).toContain('id="rwa-picker-search"');
  });
  it('confirm modal overlay exists', () => {
    expect(html).toContain('id="rwa-confirm-overlay"');
    expect(html).toContain('id="rwa-confirm-body"');
    expect(html).toContain('id="rwa-confirm-ok-btn"');
  });
  it('policy badge and bar exist', () => {
    expect(html).toContain('id="rwa-policy-badge"');
    expect(html).toContain('id="rwa-policy-bar"');
    expect(html).toContain('id="rwa-policy-dot"');
    expect(html).toContain('id="rwa-policy-msg"');
  });
  it('trade terminal inputs exist', () => {
    expect(html).toContain('id="rwa-amount-in"');
    expect(html).toContain('id="rwa-amount-out"');
    expect(html).toContain('id="rwa-from-sym"');
    expect(html).toContain('id="rwa-to-sym"');
    expect(html).toContain('id="rwa-from-bal"');
    expect(html).toContain('id="rwa-to-bal"');
  });
  it('history filter buttons exist', () => {
    expect(html).toContain('id="rwa-hf-all"');
    expect(html).toContain('id="rwa-hf-pending"');
    expect(html).toContain('id="rwa-hf-done"');
    expect(html).toContain('id="rwa-hf-failed"');
  });
});

// ── N3: CSS scoping ───────────────────────────────────────────────────────────

describe('N3 — CSS scoping', () => {
  // Extract the RWA style block
  const rwaStyleStart = html.indexOf('RWA ADVANCED TRADING — scoped CSS');
  const rwaStyleEnd = html.indexOf('</style>', rwaStyleStart);
  const rwaCSS = rwaStyleStart > -1 ? html.slice(rwaStyleStart, rwaStyleEnd) : '';

  it('RWA CSS block exists', () => {
    expect(rwaCSS).toBeTruthy();
    expect(rwaCSS.length).toBeGreaterThan(100);
  });
  it('all selectors in RWA CSS use #page-rwa or .rwa- prefix', () => {
    // Extract all selector-looking lines (start with # or .)
    const lines = rwaCSS.split('\n').map(s => s.trim())
      .filter(s => (s.startsWith('#') || s.startsWith('.')) && s.includes('{'));
    const violations = lines.filter(line => {
      // Allow #page-rwa and .rwa-* only; also allow @media rules
      return !line.startsWith('#page-rwa') && !line.startsWith('.rwa-') && !line.startsWith('@');
    });
    expect(violations).toHaveLength(0);
  });
  it('no global CSS class names leaked (.card, .page, .modal etc)', () => {
    // These global names must not appear as CSS rules in the RWA block
    expect(rwaCSS).not.toMatch(/^\.card\s*{/m);
    expect(rwaCSS).not.toMatch(/^\.modal\s*{/m);
    expect(rwaCSS).not.toMatch(/^\.page\s*{/m);
  });
});

// ── N4: JS functions present ──────────────────────────────────────────────────

describe('N4 — JS functions present', () => {
  const rwaJsStart = html.indexOf('RWA ADVANCED TRADING — JavaScript');
  const rwaJS = rwaJsStart > -1 ? html.slice(rwaJsStart, rwaJsStart + 50000) : '';

  it('RWA JS block exists', () => {
    expect(rwaJS.length).toBeGreaterThan(1000);
  });

  const fns = [
    'rwaTab', 'rwaRefresh', 'rwaLoadMarkets', 'rwaFilterMarkets',
    'rwaOpenPicker', 'rwaClosePicker', 'rwaPickerFilter',
    'rwaOnAmountChange', 'rwaFetchQuote', 'rwaConfirmTrade',
    'rwaExecuteTrade', 'rwaRenderHistory', 'rwaHistFilter',
    'rwaLoadPortfolio', 'rwaSelectMarketToken', '_rwaRecord',
    '_rwaUpdateStatus', '_rwaLocalLoad', '_rwaLocalSave',
    '_rwaShowPolicy', '_rwaRenderRoutes',
  ];
  fns.forEach(function(fn) {
    it('function ' + fn + ' is defined', () => {
      expect(rwaJS).toContain('function ' + fn + '(');
    });
  });
});

// ── N5: Policy handling ───────────────────────────────────────────────────────

describe('N5 — Policy handling', () => {
  const rwaJS = html.slice(html.indexOf('RWA ADVANCED TRADING — JavaScript'), html.indexOf('RWA ADVANCED TRADING — JavaScript') + 50000);

  it('_rwaShowPolicy handles allowed/blocked/unknown', () => {
    expect(rwaJS).toContain("status === 'allowed'");
    expect(rwaJS).toContain("status === 'blocked'");
    expect(rwaJS).toContain('RWA Enabled');
    expect(rwaJS).toContain('RWA Blocked');
  });
  it('rwaFetchQuote detects policy block from error message', () => {
    const block = fnBlock(rwaJS, 'rwaFetchQuote', 5000);
    expect(block).toContain("indexOf('RWA')");
    expect(block).toContain("indexOf('policy')");
  });
  it('policy block shows Partner Portal message', () => {
    const block = fnBlock(rwaJS, 'rwaFetchQuote', 5000);
    expect(block).toContain('Partner Portal');
  });
  it('empty routes shows no-route message (not a generic error)', () => {
    const block = fnBlock(rwaJS, 'rwaFetchQuote', 5000);
    expect(block).toContain('No routes available');
  });
});

// ── N6: Quote and route fetch ─────────────────────────────────────────────────

describe('N6 — Quote and route fetch', () => {
  const rwaJS = html.slice(html.indexOf('RWA ADVANCED TRADING — JavaScript'), html.indexOf('RWA ADVANCED TRADING — JavaScript') + 50000);
  const quoteBlock = fnBlock(rwaJS, 'rwaFetchQuote', 7000);

  it('uses LiFiAdapter.getRoutes (not a custom fetch)', () => {
    expect(quoteBlock).toContain('LiFiAdapter.getRoutes');
  });
  it('passes walletAddress as fromAddress AND toAddress', () => {
    expect(quoteBlock).toContain('fromAddress: walletAddress');
    expect(quoteBlock).toContain('toAddress:   walletAddress');
  });
  it('passes integrator via LiFiAdapter (not duplicated inline)', () => {
    // integrator must NOT be hardcoded inside rwaFetchQuote — it comes from LiFiAdapter
    expect(quoteBlock).not.toContain("integrator: 'elligentt'");
  });
  it('amount converted to BigInt with precision-safe string-split method (D1)', () => {
    // D1-fix: must NOT use Math.round for BigInt conversion (precision loss)
    expect(quoteBlock).not.toContain('BigInt(Math.round(');
    // Must use the string-split approach instead
    expect(quoteBlock).toContain('BigInt(intPart)');
    expect(quoteBlock).toContain('BigInt(fracPart)');
  });
  it('calls getStepTransaction before signing', () => {
    const execBlock = fnBlock(rwaJS, 'rwaExecuteTrade', 8000);
    expect(execBlock).toContain('LiFiAdapter.getStepTransaction');
  });
  it('validates route before signing via LiFiAdapter.validateRoute', () => {
    const execBlock = fnBlock(rwaJS, 'rwaExecuteTrade', 8000);
    expect(execBlock).toContain('LiFiAdapter.validateRoute');
  });
  it('rejects signing on validation failure', () => {
    const execBlock = fnBlock(rwaJS, 'rwaExecuteTrade', 8000);
    expect(execBlock).toContain('vResult.ok');
    expect(execBlock).toContain('Route validation failed');
  });
});

// ── N7: History safety ────────────────────────────────────────────────────────

describe('N7 — History safety', () => {
  const rwaJS = html.slice(html.indexOf('RWA ADVANCED TRADING — JavaScript'), html.indexOf('RWA ADVANCED TRADING — JavaScript') + 50000);

  it('_rwaRecord deduplicates by txHash', () => {
    const block = fnBlock(rwaJS, '_rwaRecord', 500);
    expect(block).toContain('txHash === opts.txHash');
    expect(block).toContain('return;');
  });
  it('_rwaRecord limits array to 200 entries', () => {
    const block = fnBlock(rwaJS, '_rwaLocalSave', 300);
    expect(block).toContain('.slice(0, 200)');
  });
  it('rwaRenderHistory uses createElement+textContent (not innerHTML with data)', () => {
    const block = fnBlock(rwaJS, 'rwaRenderHistory', 4000);
    // Must use DOM methods for row content
    expect(block).toContain('createElement');
    expect(block).toContain('textContent');
    // Must NOT pass history data directly into innerHTML
    expect(block).not.toMatch(/innerHTML\s*=\s*.*e\.(label|txHash|fromSym|toSym|tool)/);
  });
  it('explorer links validated via _rwaSafeTxHash and _rwaSafeExplorer', () => {
    const block = fnBlock(rwaJS, 'rwaRenderHistory', 4000);
    expect(block).toContain('_rwaSafeTxHash');
    expect(block).toContain('_rwaSafeExplorer');
  });
  it('_rwaSafeTxHash validates 0x+64hex only', () => {
    const block = fnBlock(rwaJS, '_rwaSafeTxHash', 200);
    expect(block).toContain('0x[0-9a-fA-F]{64}');
  });
  it('_rwaSafeExplorer returns only allowlisted domains', () => {
    const block = fnBlock(rwaJS, '_rwaSafeExplorer', 200);
    expect(block).toContain('_RWA_CHAINS');
    // Must not accept arbitrary user input as explorer
    expect(block).not.toContain('explorer ||');
  });
  it('explorer link uses rel=noopener noreferrer', () => {
    const block = fnBlock(rwaJS, 'rwaRenderHistory', 4000);
    expect(block).toContain('noopener noreferrer');
  });
});

// ── N8: XSS safety ───────────────────────────────────────────────────────────

describe('N8 — XSS safety', () => {
  const rwaJS = html.slice(html.indexOf('RWA ADVANCED TRADING — JavaScript'), html.indexOf('RWA ADVANCED TRADING — JavaScript') + 50000);

  it('_rwaEsc function exists and escapes HTML entities', () => {
    expect(rwaJS).toContain('function _rwaEsc(');
    expect(rwaJS).toContain("replace(/&/g,'&amp;')");
    expect(rwaJS).toContain("replace(/</g,'&lt;')");
  });
  it('rwaFilterMarkets uses createElement, not innerHTML with token data', () => {
    const block = fnBlock(rwaJS, 'rwaFilterMarkets', 4000);
    expect(block).toContain('createElement');
    expect(block).toContain('textContent');
    // Must not inject symbol/name/address raw into innerHTML
    expect(block).not.toMatch(/innerHTML\s*=.*t\.(symbol|name|address)/);
  });
  it('confirm modal uses createElement+textContent for user data', () => {
    const block = fnBlock(rwaJS, 'rwaConfirmTrade', 3000);
    expect(block).toContain('createElement');
    expect(block).toContain('textContent');
    // Must not pass raw wallet address into innerHTML
    expect(block).not.toMatch(/innerHTML.*walletAddress/);
  });
  it('error messages from API shown via textContent, not innerHTML', () => {
    // _rwaSetQuoteErr uses textContent
    const block = fnBlock(rwaJS, '_rwaSetQuoteErr', 300);
    expect(block).toContain('textContent');
    expect(block).not.toContain('innerHTML');
  });
});

// ── N9: Scope isolation ───────────────────────────────────────────────────────

describe('N9 — Scope isolation (no changes to other modules)', () => {
  const rwaJS = html.slice(html.indexOf('RWA ADVANCED TRADING — JavaScript'), html.indexOf('RWA ADVANCED TRADING — JavaScript') + 50000);

  it('rwa JS does not modify swapHistRender or swpAddHistory', () => {
    expect(rwaJS).not.toContain('swpAddHistory');
    expect(rwaJS).not.toContain('swpHistRender');
  });
  it('rwa JS does not modify brgHistRender or addToHistory', () => {
    expect(rwaJS).not.toContain('brgHistRender');
    expect(rwaJS).not.toContain('addToHistory');
  });
  it('rwa JS does not modify saExecute or executeSwap', () => {
    expect(rwaJS).not.toContain('saExecute');
    expect(rwaJS).not.toContain('executeSwap');
  });
  it('rwa JS wraps showPage correctly and delegates to original', () => {
    expect(rwaJS).toContain('_origShowPage(id)');
    expect(rwaJS).toContain("id === 'rwa'");
  });
  it('rwa JS uses IIFE — no global variable leaks', () => {
    expect(rwaJS).toContain('(function ()');
    expect(rwaJS).toContain('})();');
  });
  it('all rwa globals explicitly assigned to window.*', () => {
    expect(rwaJS).toContain('window.rwaTab = rwaTab');
    expect(rwaJS).toContain('window.rwaExecuteTrade = rwaExecuteTrade');
  });
});

// ── N10: showPage hook ────────────────────────────────────────────────────────

describe('N10 — showPage lazy-load hook', () => {
  const rwaJS = html.slice(html.indexOf('RWA ADVANCED TRADING — JavaScript'), html.indexOf('RWA ADVANCED TRADING — JavaScript') + 50000);

  it('hook initializes only once (_rwaInitialized guard)', () => {
    expect(rwaJS).toContain('_rwaInitialized');
    expect(rwaJS).toContain('!_rwaInitialized');
  });
  it('hook calls rwaLoadMarkets on first visit', () => {
    const block = blockAt(rwaJS, '_rwaInitialized = true', 300);
    expect(block).toContain('rwaLoadMarkets()');
  });
  it('hook delegates to _origShowPage for all pages', () => {
    expect(rwaJS).toContain('_origShowPage(id)');
  });
});

// ── N11: LI.FI token endpoint used for discovery ─────────────────────────────

describe('N11 — Token discovery via LI.FI proxy', () => {
  const rwaJS = html.slice(html.indexOf('RWA ADVANCED TRADING — JavaScript'), html.indexOf('RWA ADVANCED TRADING — JavaScript') + 50000);
  const loadBlock = fnBlock(rwaJS, 'rwaLoadMarkets', 3000);

  it('uses /api/lifi/tokens proxy (not a public API call)', () => {
    expect(loadBlock).toContain('/api/lifi/tokens');
    expect(loadBlock).not.toContain('https://li.fi');
    expect(loadBlock).not.toContain('api.li.fi');
  });
  it('filters tokens by rwa tag', () => {
    expect(loadBlock).toContain("indexOf('rwa')");
  });
  it('handles empty token list gracefully', () => {
    expect(loadBlock).toContain('No RWA tokens found');
  });
  it('handles network error gracefully', () => {
    expect(loadBlock).toContain('Failed to load markets');
  });
});

// ── AUDIT TESTS — D1-D7 fixes ─────────────────────────────────────────────────

const rwaFull = html.slice(html.indexOf('RWA ADVANCED TRADING — JavaScript'), html.indexOf('RWA ADVANCED TRADING — JavaScript') + 50000);

describe('A1 — D1: amtRaw precision fix (no Math.round for BigInt conversion)', () => {
  const quoteBlock = fnBlock(rwaFull, 'rwaFetchQuote', 3000);

  it('does not use Math.round for BigInt amount conversion', () => {
    // The unsafe pattern was: BigInt(Math.round(amt * Math.pow(10, decimals)))
    // The fix splits int/frac parts to avoid Number precision loss.
    expect(quoteBlock).not.toContain('BigInt(Math.round(amt * Math.pow(10, decimals)))');
  });
  it('uses string-split BigInt conversion for amtRaw', () => {
    expect(quoteBlock).toContain("var dot = s.indexOf('.')");
    expect(quoteBlock).toContain('BigInt(intPart)');
    expect(quoteBlock).toContain('BigInt(fracPart)');
  });
  it('handles integer amounts (no decimal point)', () => {
    expect(quoteBlock).toContain("if (dot === -1) return BigInt(s)");
  });
  it('truncates fractional part to decimals precision (no rounding)', () => {
    expect(quoteBlock).toContain('fracPart.length > d');
    expect(quoteBlock).toContain("fracPart = fracPart.slice(0, d)");
  });
});

describe('A2 — D2: policy block detected from unavailableRoutes.filteredOut', () => {
  const quoteBlock = fnBlock(rwaFull, 'rwaFetchQuote', 5000);

  it('reads unavailableRoutes.filteredOut from routeRes', () => {
    expect(quoteBlock).toContain('routeRes.unavailableRoutes');
    expect(quoteBlock).toContain('filteredOut');
  });
  it('detects RWA policy block by case-insensitive string match (not exact sentence)', () => {
    // Per LI.FI docs: reason text is human-readable, must NOT match exact sentence.
    expect(quoteBlock).toContain("r.indexOf('rwa') !== -1 || r.indexOf('policy') !== -1");
  });
  it('calls _rwaShowPolicy("blocked") when filteredOut contains rwa/policy reason', () => {
    expect(quoteBlock).toContain("_rwaShowPolicy('blocked'");
  });
  it('does NOT call _rwaShowPolicy("blocked") only for generic empty routes', () => {
    // Generic empty-route path shows a different error, not policy-blocked.
    expect(quoteBlock).toContain('The asset may not be eligible');
  });
  it('surfaces the filteredOut reason to the user', () => {
    expect(quoteBlock).toContain('LI.FI declined RWA paths');
  });
});

describe('A3 — D3: validateRoute uses resolved token addresses', () => {
  const execBlock = fnBlock(rwaFull, 'rwaExecuteTrade', 5000);

  it('resolves _vtFromAddr before calling validateRoute', () => {
    expect(execBlock).toContain('_vtFromAddr');
    expect(execBlock).toContain('getTokenAddressForChain(_rwaFromChainId');
  });
  it('resolves _vtToAddr before calling validateRoute', () => {
    expect(execBlock).toContain('_vtToAddr');
    expect(execBlock).toContain('getTokenAddressForChain(_rwaToChainId');
  });
  it('passes resolved addresses to validateRoute context', () => {
    const vBlock = blockAt(execBlock, 'LiFiAdapter.validateRoute(', 400);
    expect(vBlock).toContain('fromToken:   _vtFromAddr');
    expect(vBlock).toContain('toToken:     _vtToAddr');
  });
  it('does not pass raw _rwaFromToken.address directly to validateRoute', () => {
    const vBlock = blockAt(execBlock, 'LiFiAdapter.validateRoute(', 400);
    expect(vBlock).not.toContain('_rwaFromToken.address');
    expect(vBlock).not.toContain('_rwaToToken.address');
  });
});

describe('A5 — D5: cross-chain status stays pending until dest confirmed', () => {
  // rwaExecuteTrade is ~7000 chars; use 8000 to reach the tx.wait block
  const execBlock = fnBlock(rwaFull, 'rwaExecuteTrade', 8000);

  it('captures chain IDs before async tx.wait()', () => {
    expect(execBlock).toContain('_execFromChain = _rwaFromChainId');
    expect(execBlock).toContain('_execToChain   = _rwaToChainId');
  });
  it('detects cross-chain case inside tx.wait callback', () => {
    const waitBlock = blockAt(execBlock, 'tx.wait().then', 1200);
    expect(waitBlock).toContain('isCrossChain');
    expect(waitBlock).toContain('Number(_execFromChain) !== Number(_execToChain)');
  });
  it('sets status to pending (not done) for cross-chain on source receipt', () => {
    const waitBlock = blockAt(execBlock, 'tx.wait().then', 1200);
    expect(waitBlock).toContain("isCrossChain");
    // Cross-chain branch: source receipt → 'pending', not 'done'
    expect(waitBlock).toContain("'pending'");
    expect(waitBlock).not.toMatch(/isCrossChain[\s\S]{0,50}receipt\.status === 1 \? 'done'/);
  });
  it('shows informational toast for cross-chain pending status', () => {
    const waitBlock = blockAt(execBlock, 'tx.wait().then', 1200);
    expect(waitBlock).toContain('Waiting for cross-chain completion');
  });
});

describe('A6 — D6: quote freshness enforced in rwaConfirmTrade', () => {
  const confirmBlock = fnBlock(rwaFull, 'rwaConfirmTrade', 2000);
  // rwaFetchQuote is ~6200 chars; use 7000 to capture the _quoteFetchedAt stamp near the end
  const quoteBlock   = fnBlock(rwaFull, 'rwaFetchQuote', 7000);

  it('stamps _quoteFetchedAt on _rwaCurrentQuote in rwaFetchQuote', () => {
    expect(quoteBlock).toContain('_rwaCurrentQuote._quoteFetchedAt = Date.now()');
  });
  it('defines _RWA_QUOTE_TTL_MS constant', () => {
    expect(rwaFull).toContain('_RWA_QUOTE_TTL_MS');
  });
  it('checks _quoteFetchedAt in rwaConfirmTrade before opening modal', () => {
    expect(confirmBlock).toContain('_quoteFetchedAt');
    expect(confirmBlock).toContain('_RWA_QUOTE_TTL_MS');
  });
  it('nulls _rwaCurrentQuote and re-fetches when quote is stale', () => {
    expect(confirmBlock).toContain('_rwaCurrentQuote = null');
    expect(confirmBlock).toContain('rwaFetchQuote()');
  });
  it('shows warn toast for stale quote', () => {
    expect(confirmBlock).toContain('Quote expired');
  });
});

describe('A7 — D7: proxy routes.js propagates unavailableRoutes', () => {
  const routesProxy = fs.readFileSync(
    path.resolve(__dirname, '../functions/api/lifi/routes.js'), 'utf8');

  it('returns unavailableRoutes field in proxy response', () => {
    expect(routesProxy).toContain('unavailableRoutes');
    expect(routesProxy).toContain('data.unavailableRoutes');
  });
  it('propagates unavailableRoutes from LI.FI upstream', () => {
    // Use the routes-specific return (not the GET availability check)
    const returnBlock = blockAt(routesProxy, 'return json({ ok: true, routes', 300);
    expect(returnBlock).toContain('unavailableRoutes');
  });
  it('does not hard-code filteredOut reason text (keeps it opaque)', () => {
    // The proxy must not interpret the reason — it passes it through verbatim.
    expect(routesProxy).not.toContain('Path contains RWA token');
  });
});
