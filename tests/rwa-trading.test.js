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
  const rwaJS = html.slice(html.indexOf('RWA ADVANCED TRADING \u2014 JavaScript'), html.indexOf('RWA ADVANCED TRADING \u2014 JavaScript') + 55000);

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
    // Use a wider window: a comment was inserted between _rwaInitialized = true
    // and the rwaLoadMarkets() call so 300 chars no longer covers both.
    const block = blockAt(rwaJS, '_rwaInitialized = true', 600);
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
    // Message updated: "No RWA tokens available" (coverage state, not policy block).
    // "No RWA tokens found" was misleading — empty list is an availability issue,
    // not a policy block. Policy is only determinable from a quote response.
    expect(loadBlock).toContain('No RWA tokens available');
  });
  it('handles network error gracefully', () => {
    expect(loadBlock).toContain('Failed to load markets');
  });
});

// ── FIX-MARKETS: tags=rwa forwarded through proxy + no false policy badge ────

describe('FIX-MARKETS — tags=rwa forwarding and accurate empty state', () => {
  const rwaFull2 = html.slice(html.indexOf('RWA ADVANCED TRADING — JavaScript'), html.indexOf('RWA ADVANCED TRADING — JavaScript') + 50000);
  const loadBlock2 = fnBlock(rwaFull2, 'rwaLoadMarkets', 3000);
  const tokensProxy = fs.readFileSync(path.resolve(__dirname, '../functions/api/lifi/tokens.js'), 'utf8');

  it('rwaLoadMarkets requests /api/lifi/tokens with tags=rwa', () => {
    // The URL must include &tags=rwa so LI.FI filters upstream.
    // Without it, LI.FI returns the full catalog with empty tags arrays.
    expect(loadBlock2).toContain('tags=rwa');
  });

  it('proxy accepts ?tags query param and forwards to LI.FI', () => {
    expect(tokensProxy).toContain("url.searchParams.get('tags')");
    expect(tokensProxy).toContain("lifiUrl.searchParams.set('tags'");
  });

  it('proxy passes integrator to LI.FI (Partner Portal policy resolution)', () => {
    expect(tokensProxy).toContain("lifiUrl.searchParams.set('integrator'");
  });

  it('cache key includes tags so rwa and non-rwa responses are separate', () => {
    // Cache key appends /tags=<value> when tagsParam is set, so rwa and
    // non-rwa responses are stored separately. The separator is '/tags='.
    expect(tokensProxy).toContain('/tags=');
    // The tags suffix must be conditional (only when tagsParam is truthy).
    expect(tokensProxy).toContain('tagsParam ?');
  });

  it('empty token list does not call _rwaShowPolicy(unknown)', () => {
    // Empty list = coverage gap, not a policy block. Showing Policy Pending
    // was misleading. The policy bar stays hidden until a quote is attempted.
    // Check: the empty-list branch must NOT contain _rwaShowPolicy('unknown').
    const emptyBranch = blockAt(loadBlock2, 'No RWA tokens available', 400);
    expect(emptyBranch).not.toContain("_rwaShowPolicy('unknown'");
  });

  it('init does not call _rwaShowPolicy before any quote', () => {
    // The showPage hook must hide the policy bar on init, not call showPolicy('unknown').
    const initBlock = blockAt(rwaFull2, '_rwaInitialized = true', 800);
    expect(initBlock).not.toContain("_rwaShowPolicy('unknown'");
    // Policy bar must be explicitly hidden instead
    expect(initBlock).toContain("pbar.style.display = 'none'");
  });

  it('rwaLoadMarkets uses ?chains param that is backward-compatible alias', () => {
    // The proxy now accepts both ?chainId= and ?chains= for backward compat.
    expect(tokensProxy).toContain("url.searchParams.get('chains')");
  });

  it('proxy injects requested tags into token objects (LI.FI omits tags from response)', () => {
    // ROOT CAUSE FIX: LI.FI uses ?tags= as a server-side filter only — it does NOT
    // populate a `tags` field on each token in the response. Without this injection
    // every token arrives with tags:[] and the client filter for indexOf('rwa')===!=-1
    // always fails, producing an empty Markets tab even when the API returned RWA tokens.
    // The proxy must merge the request's tagsParam into each token's tags array.
    expect(tokensProxy).toContain('requestedTags');
    expect(tokensProxy).toContain('mergedTags');
    expect(tokensProxy).toContain('tagsParam.split');
    // Must use Set to deduplicate (so upstream tags + injected tags don't double)
    expect(tokensProxy).toContain('new Set([');
    // Final token must carry the merged tags
    expect(tokensProxy).toContain('tags: mergedTags');
  });

  it('proxy tag injection is conditional — only when tagsParam is truthy', () => {
    // When called without ?tags (Swap/Bridge callers), requestedTags is empty array.
    // This ensures no fabricated tags appear on tokens in the general catalog.
    expect(tokensProxy).toContain('requestedTags = tagsParam ?');
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

// ── P1: tokens.js proxy preserves `tags` field ───────────────────────────────

describe('P1 — tokens.js proxy preserves tags field for RWA discovery', () => {
  const tokensProxy = fs.readFileSync(
    path.resolve(__dirname, '../functions/api/lifi/tokens.js'), 'utf8');

  it('includes tags in the map() output', () => {
    // The normalized token object must carry tags so rwaLoadMarkets can filter.
    expect(tokensProxy).toContain('tags:');
  });
  it('preserves tags as array without fabricating values', () => {
    // Base tags come from t.tags (upstream LI.FI value), normalised via Array.isArray
    // guard. Final value is mergedTags (baseTags + requestedTags via Set dedup).
    // Never an unconditional hardcoded ['rwa'].
    const mapBlock = blockAt(tokensProxy, 'filtered[chainId] = arr.map', 1050);
    expect(mapBlock).toContain('Array.isArray(t.tags)');
    expect(mapBlock).toContain('tags: mergedTags');
    // Must NOT fabricate a hardcoded ['rwa'] literal
    expect(mapBlock).not.toMatch(/tags:\s*\['rwa'\]/);
  });
  it('falls back to empty array when upstream has no tags (no fabrication)', () => {
    const mapBlock = blockAt(tokensProxy, 'filtered[chainId] = arr.map', 600);
    expect(mapBlock).toContain('[]');
    // Must NOT invent an 'rwa' string as a synthetic tag.
    // The only 'rwa' that should appear is inside a comment, not as a string literal
    // assigned to t.tags or returned directly.
    const tagAssignBlock = blockAt(tokensProxy, 'tags:', 80);
    expect(tagAssignBlock).not.toMatch(/tags:\s*\[\s*['"]rwa['"]\s*\]/);
  });
  it('rwaLoadMarkets checks t.tags array for rwa tag', () => {
    const rwaFull = html.slice(
      html.indexOf('RWA ADVANCED TRADING — JavaScript'),
      html.indexOf('RWA ADVANCED TRADING — JavaScript') + 50000
    );
    const loadBlock = fnBlock(rwaFull, 'rwaLoadMarkets', 3000);
    expect(loadBlock).toContain("t.tags.indexOf('rwa')");
    expect(loadBlock).toContain('Array.isArray(t.tags)');
  });
  it('existing getTokens() consumers (LiFiAdapter) are not broken — shape check', () => {
    // LiFiAdapter.getTokens() caches the tokens from the proxy; the added tags
    // field is additive and must not break the shape contract (symbol + address required).
    expect(tokensProxy).toContain(".filter(t => t.symbol && t.address)");
  });
  it('empty tags array is falsy-safe in consumer code', () => {
    // rwaLoadMarkets now uses early-return negation (!t.tags || ...) so tokens
    // without an rwa tag are skipped — semantically equivalent but guard is
    // expressed as !t.tags rather than t.tags &&.
    const rwaFull = html.slice(
      html.indexOf('RWA ADVANCED TRADING — JavaScript'),
      html.indexOf('RWA ADVANCED TRADING — JavaScript') + 50000
    );
    const loadBlock = fnBlock(rwaFull, 'rwaLoadMarkets', 3000);
    // Either form of the guard must be present to prevent tokens without tags from passing.
    const hasPositiveGuard = loadBlock.includes('t.tags &&') || loadBlock.includes('t.tags,') || loadBlock.includes('t.tags)');
    const hasNegativeGuard = loadBlock.includes('!t.tags') || loadBlock.includes('t.tags.indexOf');
    expect(hasPositiveGuard || hasNegativeGuard).toBe(true);
  });
});

// ── P2: LiFiAdapter.getRoutes() propagates unavailableRoutes ─────────────────

describe('P2 — LiFiAdapter.getRoutes() propagates unavailableRoutes to callers', () => {
  const adapter = fs.readFileSync(
    path.resolve(__dirname, '../shared/LiFiAdapter.js'), 'utf8');

  // getRoutes() function body — from declaration to end of function
  const getRoutesBlock = fnBlock(adapter, 'getRoutes', 6000);

  it('getRoutes return value includes unavailableRoutes field', () => {
    // The return statement inside getRoutes must carry unavailableRoutes.
    expect(getRoutesBlock).toContain('unavailableRoutes');
    expect(getRoutesBlock).toContain('res.unavailableRoutes');
  });
  it('unavailableRoutes is read from the proxy response, not fabricated', () => {
    // Must read from res (the proxy response), not hard-code.
    // Anchor on 'var unavailableRoutes' to capture the assignment line.
    const propBlock = blockAt(getRoutesBlock, 'var unavailableRoutes', 200);
    expect(propBlock).toContain('res.unavailableRoutes');
    expect(propBlock).not.toMatch(/unavailableRoutes\s*=\s*\{/); // no inline fabrication
  });
  it('existing callers that only read .routes are not broken', () => {
    // The return is additive — .routes and .count still present.
    const returnBlock = blockAt(getRoutesBlock, 'return { ok: true, routes:', 200);
    expect(returnBlock).toContain('routes: normalized');
    expect(returnBlock).toContain('count: normalized.length');
  });
  it('rwaFetchQuote reads unavailableRoutes from the LiFiAdapter.getRoutes result', () => {
    const rwaFull = html.slice(
      html.indexOf('RWA ADVANCED TRADING — JavaScript'),
      html.indexOf('RWA ADVANCED TRADING — JavaScript') + 50000
    );
    // rwaFetchQuote calls LiFiAdapter.getRoutes and stores result as routeRes,
    // then accesses routeRes.unavailableRoutes.filteredOut.
    const quoteBlock = fnBlock(rwaFull, 'rwaFetchQuote', 7000);
    expect(quoteBlock).toContain('routeRes.unavailableRoutes');
    expect(quoteBlock).toContain('filteredOut');
  });
  it('policy block is differentiated from empty routes (no fabrication of message)', () => {
    const rwaFull = html.slice(
      html.indexOf('RWA ADVANCED TRADING — JavaScript'),
      html.indexOf('RWA ADVANCED TRADING — JavaScript') + 50000
    );
    const quoteBlock = fnBlock(rwaFull, 'rwaFetchQuote', 7000);
    // policyBlock is true only when filteredOut contains reason with 'rwa' or 'policy'
    expect(quoteBlock).toContain('policyBlock');
    // Empty routes without filteredOut shows a generic no-route message, not a policy block
    expect(quoteBlock).toContain('No routes available');
    expect(quoteBlock).toContain('RWA trading is not enabled');
  });
  it('getRoutes returns {ok:false} when proxy returns {ok:false} — callers unaffected', () => {
    // The early return at "if (!res || res.ok !== true..." already handles this.
    // Anchor before the error string so 'ok: false' is within the window.
    const earlyReturn = blockAt(getRoutesBlock, 'return { ok: false, error: (res && res.error) || \'LIFI_ROUTES', 200);
    expect(earlyReturn).toContain('ok: false');
    expect(earlyReturn).toContain('routes: []');
  });
});

// ── P3: BigInt precision consistent between quote and approval ────────────────

describe('P3 — BigInt conversion consistent in approval check (no Math.round)', () => {
  const rwaFull = html.slice(
    html.indexOf('RWA ADVANCED TRADING — JavaScript'),
    html.indexOf('RWA ADVANCED TRADING — JavaScript') + 50000
  );
  // rwaExecuteTrade is ~8000 chars; include enough to reach the approval section
  const execBlock = fnBlock(rwaFull, 'rwaExecuteTrade', 9000);

  it('approval block uses split-string BigInt, not Math.round', () => {
    // Must use the safe string-split conversion (P3-fix), not the old naive path.
    const approvalSection = blockAt(execBlock, 'approvalAddress', 600);
    expect(approvalSection).not.toContain('Math.round');
    expect(approvalSection).not.toContain('Math.pow(10,');
    expect(approvalSection).not.toContain('Math.pow(10, ');
  });
  it('approval block uses same split-integer/fraction pattern as rwaFetchQuote', () => {
    const approvalSection = blockAt(execBlock, 'P3-fix', 500);
    expect(approvalSection).toContain('10n ** BigInt(d)');
    expect(approvalSection).toContain('fracPart');
    expect(approvalSection).toContain('intPart');
  });
  it('rwaFetchQuote quote conversion also uses split-string BigInt (D1-fix still intact)', () => {
    const quoteBlock = fnBlock(rwaFull, 'rwaFetchQuote', 7000);
    expect(quoteBlock).toContain('D1-fix');
    expect(quoteBlock).toContain('10n ** BigInt(d)');
    expect(quoteBlock).not.toContain('BigInt(Math.round(amt * Math.pow(10,');
  });
  it('approval amtRaw is computed from the UI input value, not a hardcoded fallback', () => {
    const approvalSection = blockAt(execBlock, 'amtNum', 400);
    expect(approvalSection).toContain('parseFloat(amtEl.value)');
  });
  it('approval uses token-specific decimals, not hardcoded 6 or 18', () => {
    // _aprvDec reads _rwaFromToken.decimals
    const approvalSection = blockAt(execBlock, '_aprvDec', 200);
    expect(approvalSection).toContain('_rwaFromToken.decimals');
  });
  it('truncates excess decimal places for tokens with fewer decimals (no silent rounding)', () => {
    // fracPart.length > d → fracPart = fracPart.slice(0, d) — truncate, not round
    const approvalSection = blockAt(execBlock, 'P3-fix', 600);
    expect(approvalSection).toContain('fracPart.slice(0, d)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BAL — Trade Terminal balance fetch
// Root cause: _rwaUpdateBalances used `typeof getTokenBalance === 'function'`
// which is always false in-browser (getTokenBalance is Node-only in shared/).
// Fix: direct ethers.Contract + balanceOf using getCachedProvider + CHAIN_REGISTRY.
// ─────────────────────────────────────────────────────────────────────────────
describe('BAL — _rwaUpdateBalances real balanceOf implementation', () => {
  const _rwaStart = html.indexOf('RWA ADVANCED TRADING \u2014 JavaScript');
  const rwaFull  = html.slice(_rwaStart, _rwaStart + 55000);
  const updateFn = fnBlock(rwaFull, '_rwaUpdateBalances', 3500);
  const fetchFn  = fnBlock(rwaFull, '_rwaFetchTokenBalance', 1000);

  it('_rwaFetchTokenBalance function exists', () => {
    expect(fetchFn.length).toBeGreaterThan(50);
  });

  it('uses CHAIN_REGISTRY to get rpcUrl — not hardcoded', () => {
    expect(fetchFn).toContain('CHAIN_REGISTRY[chainId]');
    expect(fetchFn).toContain('.rpc');
    // Must NOT have a hardcoded RPC string inside the function
    expect(fetchFn).not.toMatch(/https?:\/\/[a-z]/);
  });

  it('uses getCachedProvider with the resolved rpcUrl', () => {
    expect(fetchFn).toContain('getCachedProvider(rpcUrl)');
  });

  it('calls balanceOf with the wallet address', () => {
    expect(fetchFn).toContain('balanceOf(wallet)');
  });

  it('uses ethers.Contract with minimal ABI (not a full ERC-20 ABI)', () => {
    expect(fetchFn).toContain('ethers.Contract');
    expect(fetchFn).toContain('_RWA_BAL_ABI');
    // The ABI constant should exist and only declare balanceOf
    const abiConst = blockAt(rwaFull, '_RWA_BAL_ABI', 80);
    expect(abiConst).toContain('balanceOf');
    expect(abiConst).not.toContain('transfer(');
  });

  it('returns null (not throw) when CHAIN_REGISTRY has no rpcUrl for the chain', () => {
    // The function must check rpcUrl and return null gracefully, not throw —
    // throwing causes "Balance: error" in the UI for CORS/no-proxy scenarios.
    const fetchFn900 = fnBlock(rwaFull, '_rwaFetchTokenBalance', 900);
    expect(fetchFn900).toContain('return null');
    expect(fetchFn900).not.toContain('No RPC for chainId');
    expect(fetchFn900).not.toMatch(/throw new Error/);
  });

  it('race-condition guard: bumps sequence counter before async call', () => {
    // _rwaBalSeq.from and _rwaBalSeq.to are incremented synchronously
    expect(updateFn).toContain('++_rwaBalSeq.from');
    expect(updateFn).toContain('++_rwaBalSeq.to');
  });

  it('discards stale response if token changed before RPC returned', () => {
    // After resolution, check that current seq matches captured seq
    expect(updateFn).toContain('_rwaBalSeq.from !== fromSeq');
    expect(updateFn).toContain('_rwaBalSeq.to !== toSeq');
  });

  it('shows loading indicator (…) while fetch is in-flight', () => {
    expect(updateFn).toContain('Balance: …');
  });

  it('shows dash (—) on RPC failure — never "Balance: error" (avoids alarming users for CORS/network issues)', () => {
    // Catch handlers now show '—' not 'error', since external RPCs cause CORS
    // errors that are not user-actionable — a dash is less alarming and accurate.
    expect(updateFn).not.toContain('Balance: error');
    // Both catch handlers must show dash
    const catches = [...updateFn.matchAll(/\.catch\(function[\s\S]{0,200}?\)\s*;/g)].map(m => m[0]);
    catches.forEach(c => expect(c).toContain('Balance: —'));
  });

  it('resets to dash (—) synchronously on every call before async result', () => {
    // The first thing the function does is set text to — before any async
    const topOfFn = updateFn.slice(0, 500);
    expect(topOfFn).toContain('Balance: —');
  });

  it('reads wallet from walletAddress global — no hardcoded address', () => {
    expect(updateFn).toContain('walletAddress');
    expect(updateFn).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });

  it('returns early without error when wallet is disconnected', () => {
    expect(updateFn).toContain('if (!wallet) return');
  });

  it('uses token.decimals from the token object — not hardcoded 18 everywhere', () => {
    // fromDec reads _rwaFromToken.decimals; toDec reads _rwaToToken.decimals
    expect(updateFn).toContain('_rwaFromToken.decimals');
    expect(updateFn).toContain('_rwaToToken.decimals');
  });

  it('formats the raw BigInt with _rwaFmt, not Number() or parseFloat()', () => {
    // _rwaFmt handles BigInt safely; Number(bigint > MAX_SAFE_INTEGER) would lose precision
    const resultBlock = blockAt(updateFn, 'Balance: \' + _rwaFmt', 200);
    expect(resultBlock.length).toBeGreaterThan(10);
    expect(resultBlock).not.toContain('Number(raw)');
    expect(resultBlock).not.toContain('parseFloat(raw)');
  });

  it('uses the from-token chain (_rwaFromChainId) for the from balance call', () => {
    const fromBlock = blockAt(updateFn, 'fromChain', 400);
    expect(fromBlock).toContain('_rwaFromChainId');
  });

  it('uses the to-token chain (_rwaToChainId) for the to balance call', () => {
    const toBlock = blockAt(updateFn, 'toChain', 400);
    expect(toBlock).toContain('_rwaToChainId');
  });

  it('does NOT call the legacy getTokenBalance function', () => {
    // getTokenBalance is a Node-only shared/ function, never a browser global
    expect(updateFn).not.toContain('getTokenBalance(');
  });
});

describe('BAL — wallet event listeners and post-trade refresh', () => {
  const _rwaStart2 = html.indexOf('RWA ADVANCED TRADING \u2014 JavaScript');
  const rwaFull  = html.slice(_rwaStart2, _rwaStart2 + 55000);

  it('registers WALLET_CONNECTED listener in init block', () => {
    const initBlock = blockAt(rwaFull, '_rwaInitialized = true', 900);
    expect(initBlock).toContain("'WALLET_CONNECTED'");
    expect(initBlock).toContain('_rwaUpdateBalances');
  });

  it('registers WALLET_SWITCHED listener in init block', () => {
    const initBlock = blockAt(rwaFull, '_rwaInitialized = true', 900);
    expect(initBlock).toContain("'WALLET_SWITCHED'");
  });

  it('rwaOnChainChange calls _rwaUpdateBalances before rwaFetchQuote', () => {
    const chainChangeFn = fnBlock(rwaFull, 'rwaOnChainChange', 300);
    const updateIdx = chainChangeFn.indexOf('_rwaUpdateBalances');
    const quoteIdx  = chainChangeFn.indexOf('rwaFetchQuote');
    expect(updateIdx).toBeGreaterThan(-1);
    expect(quoteIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeLessThan(quoteIdx);
  });

  it('rwaExecuteTrade calls _rwaUpdateBalances after confirmed receipt', () => {
    const execBlock8k = fnBlock(rwaFull, 'rwaExecuteTrade', 8000);
    // After tx.wait() resolves and status !== failed, balance is refreshed
    const afterReceiptBlock = blockAt(execBlock8k, 'status !== \'failed\'', 200);
    expect(afterReceiptBlock).toContain('_rwaUpdateBalances');
  });
});

// ── FIX-BALANCE: all chains use internal RPC proxy ────────────────────────────
describe('FIX-BALANCE — all chains use same-origin RPC proxies', () => {
  const _rwaStart3 = html.indexOf('RWA ADVANCED TRADING \u2014 JavaScript');
  const rwaFull3   = html.slice(_rwaStart3, _rwaStart3 + 55000);
  const fetchFn    = fnBlock(rwaFull3, '_rwaFetchTokenBalance', 900);

  it('_rwaFetchTokenBalance exists in RWA block', () => {
    expect(fetchFn.length).toBeGreaterThan(50);
  });

  it('returns null when rpcUrl is absent (not throw)', () => {
    // No RPC configured → return null, not throw Error
    const noRpcBlock = blockAt(fetchFn, 'rpcUrl', 80);
    expect(noRpcBlock).toContain('return null');
    expect(noRpcBlock).not.toContain('throw');
  });

  it('does not have the old CORS startsWith guard (all chains have proxy now)', () => {
    // The guard was needed when some chains had external URLs.
    // Now all CHAIN_REGISTRY entries point to /api/rpc/* — no guard needed.
    expect(fetchFn).not.toContain("!rpcUrl.startsWith('/')");
  });

  it('CHAIN_REGISTRY chain 1 uses internal proxy', () => {
    expect(html).toContain("rpc: '/api/rpc/ethereum'");
  });

  it('CHAIN_REGISTRY chain 8453 uses internal proxy', () => {
    expect(html).toContain("rpc: '/api/rpc/base'");
  });

  it('CHAIN_REGISTRY chain 42161 uses internal proxy', () => {
    expect(html).toContain("rpc: '/api/rpc/arbitrum'");
  });

  it('CHAIN_REGISTRY chain 10 uses internal proxy', () => {
    expect(html).toContain("rpc: '/api/rpc/optimism'");
  });

  it('CHAIN_REGISTRY chain 137 uses internal proxy', () => {
    expect(html).toContain("rpc: '/api/rpc/polygon'");
  });

  it('_rwaUpdateBalances handles null result from fetch as dash (not error)', () => {
    const updateFn2 = fnBlock(rwaFull3, '_rwaUpdateBalances', 2500);
    expect(updateFn2).toContain("raw === null");
    expect(updateFn2).not.toContain("'Balance: error'");
    expect(updateFn2).not.toContain('"Balance: error"');
  });
});

describe('FIX-SLIPPAGE — routes.js must NOT forward "auto" string to /advanced/routes', () => {
  const routesSrc = fs.readFileSync(
    path.resolve(__dirname, '../functions/api/lifi/routes.js'), 'utf8'
  );

  it('omits slippage from options when body.slippage is "auto"', () => {
    // /v1/advanced/routes schema: options.slippage must be a number.
    // Sending "auto" causes: /options/slippage must be number error from LI.FI.
    // Fixed by using null sentinel and conditional add: if (slippageNum !== null)
    expect(routesSrc).toContain('null;  // null = omit field');
    expect(routesSrc).not.toMatch(/body\.slippage\s*===\s*'auto'\s*\?\s*'auto'/);
  });

  it('options object is built without slippage field when auto', () => {
    // routeOptions is built first without slippage, then slippage added conditionally
    expect(routesSrc).toContain('if (slippageNum !== null) routeOptions.slippage = slippageNum');
  });

  it('options.slippage is never set to the string "auto"', () => {
    // The options object must never contain slippage: 'auto'
    expect(routesSrc).not.toMatch(/slippage:\s*'auto'/);
    expect(routesSrc).not.toMatch(/slippage:\s*"auto"/);
  });

  it('still accepts numeric slippage from explicit bps', () => {
    expect(routesSrc).toContain('Number.isFinite(Number(body.slippage))');
  });
});

// ── FIX-BALANCE-ADDRESS: _resolveAddr resolves null address via CHAIN_REGISTRY ─
describe('FIX-BALANCE-ADDRESS — _resolveAddr resolves null address via CHAIN_REGISTRY', () => {
  const _rwaStart4 = html.indexOf('RWA ADVANCED TRADING \u2014 JavaScript');
  const rwaFull4   = html.slice(_rwaStart4, _rwaStart4 + 55000);
  const updateFn   = fnBlock(rwaFull4, '_rwaUpdateBalances', 3000);

  it('_resolveAddr helper exists inside _rwaUpdateBalances', () => {
    expect(updateFn).toContain('function _resolveAddr');
  });

  it('_resolveAddr returns tok.address when present', () => {
    expect(updateFn).toContain('if (tok && tok.address) return tok.address');
  });

  it('_resolveAddr falls back to CHAIN_REGISTRY[chainId].tokens lookup', () => {
    expect(updateFn).toContain('CHAIN_REGISTRY[chainId]');
    expect(updateFn).toContain('reg.tokens[tok.symbol.toUpperCase()]');
  });

  it('_resolveAddr returns null (not throw) when registry entry absent', () => {
    expect(updateFn).toContain('return entry ? entry.address : null');
  });

  it('FROM balance block no longer gates on _rwaFromToken.address being truthy', () => {
    // Old code: if (_rwaFromToken && _rwaFromToken.address) { ... }
    // New code: _resolveAddr resolves address even when tok.address is null
    expect(updateFn).not.toContain('_rwaFromToken.address)');
  });

  it('init block calls _rwaUpdateBalances immediately on first visit', () => {
    // Previously only called via WALLET_CONNECTED / WALLET_SWITCHED events.
    // If wallet already connected when tab opens, those events never fire again.
    const initBlock = blockAt(rwaFull4, '_rwaInitialized = true', 800);
    expect(initBlock).toContain('_rwaUpdateBalances()');
  });

  it('CHAIN_REGISTRY chain 1 has canonical Ethereum USDC address', () => {
    // Must NOT be Arc USDC (0x3600...) for chain 1 balance reads to work.
    expect(html).toContain("'0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'");
  });
});
