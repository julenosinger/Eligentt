/**
 * bridge-hardening.test.js
 * Bridge Multi-Token 1.0.1 — Hardening tests.
 *
 * Tests: CCTP EURC per-chain eligibility, missing token addresses, expired
 * quotes, token/chain mismatch at pre-sign, decimal handling, allowance paths,
 * and no-route blocking with clear messaging.
 *
 * All tests are static source-code assertions (no runtime, no wallet, no network).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const html = readFileSync(join(__dirname, '../index.html'), 'utf8');
const bkrSrc = readFileSync(join(__dirname, '../shared/bridgeKitRouter.js'), 'utf8');

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Instantiate BridgeKitRouter in a fake window and return it. */
function makeBKR() {
  const win = {};
  new Function('window', bkrSrc)(win);
  return win.BridgeKitRouter;
}

// ── 1. EURC CCTP eligibility — per-chain address check ────────────────────────
describe('EURC CCTP eligibility — per-chain address validation', () => {
  it('EURC_CCTP_CHAINS is exported', () => {
    const R = makeBKR();
    expect(R.EURC_CCTP_CHAINS).toBeDefined();
    expect(typeof R.EURC_CCTP_CHAINS).toBe('object');
  });

  it('isEurcCctpChain is exported', () => {
    const R = makeBKR();
    expect(typeof R.isEurcCctpChain).toBe('function');
  });

  it('Arc (5042) and Base (8453) are in EURC_CCTP_CHAINS', () => {
    const R = makeBKR();
    expect(R.isEurcCctpChain(5042)).toBe(true);
    expect(R.isEurcCctpChain(8453)).toBe(true);
  });

  it('Ethereum (1), Arbitrum (42161), Optimism (10), Polygon (137) are NOT in EURC_CCTP_CHAINS', () => {
    const R = makeBKR();
    expect(R.isEurcCctpChain(1)).toBe(false);
    expect(R.isEurcCctpChain(42161)).toBe(false);
    expect(R.isEurcCctpChain(10)).toBe(false);
    expect(R.isEurcCctpChain(137)).toBe(false);
  });

  it('isEligible(EURC, Arc→Ethereum) returns false — Ethereum has no EURC address', () => {
    const R = makeBKR();
    expect(R.isEligible(5042, 1, 'EURC')).toBe(false);
  });

  it('isEligible(EURC, Ethereum→Arc) returns false — Ethereum has no EURC address', () => {
    const R = makeBKR();
    expect(R.isEligible(1, 5042, 'EURC')).toBe(false);
  });

  it('isEligible(EURC, Arc→Arbitrum) returns false', () => {
    const R = makeBKR();
    expect(R.isEligible(5042, 42161, 'EURC')).toBe(false);
  });

  it('isEligible(EURC, Arc→Optimism) returns false', () => {
    const R = makeBKR();
    expect(R.isEligible(5042, 10, 'EURC')).toBe(false);
  });

  it('isEligible(EURC, Arc→Polygon) returns false', () => {
    const R = makeBKR();
    expect(R.isEligible(5042, 137, 'EURC')).toBe(false);
  });

  it('isEligible(EURC, Arc→Base) returns true — both are in EURC_CCTP_CHAINS', () => {
    const R = makeBKR();
    expect(R.isEligible(5042, 8453, 'EURC')).toBe(true);
  });

  it('isEligible(EURC, Base→Arc) returns true', () => {
    const R = makeBKR();
    expect(R.isEligible(8453, 5042, 'EURC')).toBe(true);
  });

  it('EURC same-chain is not eligible even when both are EURC chains', () => {
    const R = makeBKR();
    expect(R.isEligible(5042, 5042, 'EURC')).toBe(false);
  });

  it('USDC eligibility is unaffected by EURC_CCTP_CHAINS (all CCTP chains still work)', () => {
    const R = makeBKR();
    expect(R.isEligible(1, 5042, 'USDC')).toBe(true);
    expect(R.isEligible(5042, 1, 'USDC')).toBe(true);
    expect(R.isEligible(5042, 8453, 'USDC')).toBe(true);
    expect(R.isEligible(1, 10, 'USDC')).toBe(true);
    expect(R.isEligible(42161, 137, 'USDC')).toBe(true);
  });
});

// ── 2. No silent fallback — missing token address returns empty routes ─────────
describe('_fetchBridgeRoutes: no silent fallback when token missing on chain', () => {
  it('returns [] when selected source token has no address on source chain (not a silent switch to USDC)', () => {
    const fn = html.slice(
      html.indexOf('async function _fetchBridgeRoutes'),
      html.indexOf('// ── Route panel rendering')
    );
    // Must return [] (not fall back to USDC) when fromMeta is null
    expect(fn).toContain('if (!fromMeta) return []');
  });

  it('returns [] when selected destination token has no address on destination chain', () => {
    const fn = html.slice(
      html.indexOf('async function _fetchBridgeRoutes'),
      html.indexOf('// ── Route panel rendering')
    );
    expect(fn).toContain('if (!toMeta)   return []');
  });

  it('does NOT contain the old silent USDC fallback pattern', () => {
    const fn = html.slice(
      html.indexOf('async function _fetchBridgeRoutes'),
      html.indexOf('// ── Route panel rendering')
    );
    // The old code was: if (!fromMeta) { fromSym = 'USDC'; fromMeta = ... }
    // This must no longer exist — it silently swapped assets.
    expect(fn).not.toMatch(/if \(!fromMeta\) \{ fromSym = 'USDC'/);
    expect(fn).not.toMatch(/if \(!toMeta\) \{ toSym = 'USDC'/);
  });
});

// ── 3. No-route explanation message is specific ────────────────────────────────
describe('_fetchBridgeQuote: specific no-route messages', () => {
  it('shows specific token/chain explanation when routes are empty', () => {
    const fn = html.slice(
      html.indexOf('async function _fetchBridgeQuote'),
      html.indexOf('// Store routes. NO auto-selection')
    );
    // Must reference the token name in the error message, not just "No routes available"
    expect(fn).toContain('is not available on');
    expect(fn).toContain('_noRouteFromSym');
    expect(fn).toContain('_noRouteToSym');
  });

  it('uses _noRouteMsg variable to display the specific reason', () => {
    const fn = html.slice(
      html.indexOf('async function _fetchBridgeQuote'),
      html.indexOf('// Store routes. NO auto-selection')
    );
    expect(fn).toContain('_noRouteMsg');
  });
});

// ── 4. Routes stamped with fetch-time token/chain for pre-sign mismatch check ──
describe('Route stamping: _fetchBridgeRoutes stores fetch context on every route', () => {
  it('stamps _fetchFromSym on every route', () => {
    const fn = html.slice(
      html.indexOf('async function _fetchBridgeRoutes'),
      html.indexOf('// ── Route panel rendering')
    );
    expect(fn).toContain('r._fetchFromSym = fromSym');
  });

  it('stamps _fetchToSym on every route', () => {
    const fn = html.slice(
      html.indexOf('async function _fetchBridgeRoutes'),
      html.indexOf('// ── Route panel rendering')
    );
    expect(fn).toContain('r._fetchToSym   = toSym');
  });

  it('stamps _fetchFromChainId and _fetchToChainId on every route', () => {
    const fn = html.slice(
      html.indexOf('async function _fetchBridgeRoutes'),
      html.indexOf('// ── Route panel rendering')
    );
    expect(fn).toContain('r._fetchFromChainId = fromChain.chainId');
    expect(fn).toContain('r._fetchToChainId   = toChain.chainId');
  });
});

// ── 5. Pre-sign token/chain mismatch check in executeBridgeOrTurbo ─────────────
describe('executeBridgeOrTurbo: pre-sign token/chain mismatch guard', () => {
  const fn = html.slice(
    html.indexOf('function executeBridgeOrTurbo()'),
    html.indexOf('// ── Fallback: no routes loaded')
  );

  it('checks _fetchFromSym against current token before execution', () => {
    expect(fn).toContain('route._fetchFromSym');
    expect(fn).toContain('_currentFromSym');
  });

  it('checks _fetchToSym against current destination token', () => {
    expect(fn).toContain('route._fetchToSym');
    expect(fn).toContain('_currentToSym');
  });

  it('checks _fetchFromChainId and _fetchToChainId against current chain selection', () => {
    expect(fn).toContain('route._fetchFromChainId');
    expect(fn).toContain('route._fetchToChainId');
  });

  it('calls _brsClearRoutes + updateBridgeEst on mismatch (never executes stale route)', () => {
    expect(fn).toContain('Token or network changed since route was loaded');
    expect(fn).toContain('_brsClearRoutes()');
    expect(fn).toContain('updateBridgeEst()');
  });

  it('mismatch guard fires BEFORE quote expiry check', () => {
    // Mismatch guard must appear before the quoteAge check
    const mismatchIdx = fn.indexOf('route._fetchFromSym');
    const expireIdx   = fn.indexOf('quoteAge');
    expect(mismatchIdx).toBeGreaterThan(-1);
    expect(expireIdx).toBeGreaterThan(-1);
    expect(mismatchIdx).toBeLessThan(expireIdx);
  });
});

// ── 6. CCTP badge in picker uses isEligible (not just isCCTPToken) ────────────
describe('Token picker: CCTP badge uses isEligible for per-chain accuracy', () => {
  it('picker badge logic uses BridgeKitRouter.isEligible', () => {
    const fn = html.slice(html.indexOf('function _bridgeOpenTokenPicker'), html.indexOf('function _bridgePickToken'));
    expect(fn).toContain('BridgeKitRouter.isEligible');
  });

  it('picker badge logic does NOT use BridgeKitRouter.isCCTPToken alone for the badge', () => {
    // isCCTPToken alone is insufficient — it would mark EURC as CCTP-eligible on Ethereum.
    // The badge must go through isEligible which validates the full chain pair.
    const fn = html.slice(html.indexOf('function _bridgeOpenTokenPicker'), html.indexOf('function _bridgePickToken'));
    // The isEligible call must be present; a lone isCCTPToken call (without isEligible) must not gate the badge.
    // It's OK if isCCTPToken is referenced elsewhere in the function for other purposes.
    const badgeBlock = fn.slice(fn.indexOf('cctpBadge'), fn.indexOf('html +='));
    expect(badgeBlock).toContain('isEligible');
  });

  it('picker badge uses the other-side chain for the full pair check', () => {
    const fn = html.slice(html.indexOf('function _bridgeOpenTokenPicker'), html.indexOf('function _bridgePickToken'));
    expect(fn).toContain('_otherChain');
    expect(fn).toContain('_otherChainId');
  });
});

// ── 7. Decimal handling for different ERC-20 decimals ─────────────────────────
describe('Decimal handling: different ERC-20 decimal counts', () => {
  it('_fetchBridgeRoutes uses Math.pow(10, fromDecimals) for amountInRaw — no hardcoded 1e6', () => {
    const fn = html.slice(
      html.indexOf('async function _fetchBridgeRoutes'),
      html.indexOf('// ── Route panel rendering')
    );
    expect(fn).toContain('Math.pow(10, fromDecimals)');
    expect(fn).not.toContain('* 1e6');
    expect(fn).not.toContain('* 1000000');
  });

  it('cirBTC (8 decimals) is listed in CHAIN_REGISTRY for Arc', () => {
    // Arc has cirBTC with 8 decimals
    expect(html).toContain("cirBTC: { address: '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0', decimals: 8 }");
  });

  it('_brsFromLiFiRoute uses divisor from passed toDecimals, not hardcoded 1e6', () => {
    const fn = html.slice(html.indexOf('function _brsFromLiFiRoute'), html.indexOf('function _brsFromLiFi('));
    expect(fn).not.toContain('/ 1e6');
    expect(fn).toContain('divisor');
    expect(fn).toContain('Math.pow(10');
  });

  it('executeBridgeViaLiFi computes amountInRaw with _lifiFromDec, not hardcoded 1e6', () => {
    // Use a wider slice — _lifiFromDec is declared after the token address resolution.
    const fn = html.slice(
      html.indexOf('async function executeBridgeViaLiFi()'),
      html.indexOf('async function executeBridgeViaLiFi()') + 3000
    );
    expect(fn).toContain('_lifiFromDec');
    expect(fn).toContain('Math.pow(10, _lifiFromDec)');
    expect(fn).not.toContain('* 1e6');
  });
});

// ── 8. Token address identity — no address reuse across chains ────────────────
describe('Token address identity: correct address per chain in CHAIN_REGISTRY', () => {
  it('Arc USDC address is unique (not shared with Ethereum)', () => {
    const ARC_USDC    = '0x3600000000000000000000000000000000000000';
    const ETH_USDC    = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    expect(ARC_USDC).not.toBe(ETH_USDC);
    expect(html).toContain(ARC_USDC);
    expect(html).toContain(ETH_USDC);
  });

  it('Arc EURC address is unique (not shared with Base)', () => {
    const ARC_EURC  = '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1';
    const BASE_EURC = '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42';
    expect(ARC_EURC).not.toBe(BASE_EURC);
    expect(html).toContain(ARC_EURC);
    expect(html).toContain(BASE_EURC);
  });

  it('Ethereum CHAIN_REGISTRY entry has NO EURC token (none deployed)', () => {
    // Extract the Ethereum CHAIN_REGISTRY entry
    const ethEntry = html.slice(
      html.indexOf('id: \'Ethereum\', name: \'Ethereum\''),
      html.indexOf('isEvm: true,', html.indexOf('id: \'Ethereum\', name: \'Ethereum\'')) + 20
    );
    expect(ethEntry).not.toContain('EURC');
  });

  it('Arbitrum CHAIN_REGISTRY entry has NO EURC token', () => {
    const arbEntry = html.slice(
      html.indexOf('id: \'Arbitrum\''),
      html.indexOf('isEvm: true,', html.indexOf('id: \'Arbitrum\'')) + 20
    );
    expect(arbEntry).not.toContain('EURC');
  });

  it('Optimism CHAIN_REGISTRY entry has NO EURC token', () => {
    const opEntry = html.slice(
      html.indexOf('id: \'Optimism\''),
      html.indexOf('isEvm: true,', html.indexOf('id: \'Optimism\'')) + 20
    );
    expect(opEntry).not.toContain('EURC');
  });

  it('Polygon CHAIN_REGISTRY entry has NO EURC token', () => {
    const polyEntry = html.slice(
      html.indexOf('id: \'Polygon\''),
      html.indexOf('isEvm: true,', html.indexOf('id: \'Polygon\'')) + 20
    );
    expect(polyEntry).not.toContain('EURC');
  });
});

// ── 9. Quote expiry check ─────────────────────────────────────────────────────
describe('Quote expiry: stale LI.FI quotes are rejected before execution', () => {
  const fn = html.slice(
    html.indexOf('function executeBridgeOrTurbo()'),
    html.indexOf('// ── Fallback: no routes loaded')
  );

  it('checks quoteAge against a time threshold for lifi routes', () => {
    expect(fn).toContain('quoteAge');
    expect(fn).toContain('_fetchedAt');
    expect(fn).toContain('160000');
  });

  it('fetches fresh route on expiry (does not execute expired quote)', () => {
    expect(fn).toContain('Quote expired. Fetching a fresh route');
    expect(fn).toContain('_brsClearRoutes()');
  });
});

// ── 10. _bridgePickToken invalidates quote immediately ────────────────────────
describe('Token change: quote is invalidated on token selection', () => {
  const fn = html.slice(html.indexOf('function _bridgePickToken'), html.indexOf('function _bridgeClosePicker'));

  it('_bridgePickToken calls _brsClearRoutes() to null _selectedBridgeRoute', () => {
    expect(fn).toContain('_brsClearRoutes()');
  });

  it('_bridgePickToken calls updateBridgeEst() to trigger a fresh quote', () => {
    expect(fn).toContain('updateBridgeEst()');
  });

  it('token state is updated BEFORE clearing routes', () => {
    const tokenAssignIdx = fn.indexOf('bridgeFromToken = t.sym');
    const clearIdx       = fn.indexOf('_brsClearRoutes()');
    const tokenToIdx     = fn.indexOf('bridgeToToken = t.sym');
    // Either from or to token is set before the clear
    const assignIdx = Math.min(tokenAssignIdx < 0 ? Infinity : tokenAssignIdx,
                               tokenToIdx     < 0 ? Infinity : tokenToIdx);
    expect(assignIdx).toBeLessThan(clearIdx);
  });
});

// ── 11. _bridgeAvailableTokens: only tokens with valid addresses on the chain ──
describe('_bridgeAvailableTokens: only shows tokens with valid addresses', () => {
  it('function exists in index.html', () => {
    expect(html).toContain('function _bridgeAvailableTokens');
  });

  it('filters tokens using address presence check', () => {
    const fn = html.slice(html.indexOf('function _bridgeAvailableTokens'), html.indexOf('function _bridgeGetTokenMeta'));
    // Must check for address existence — something like token.address or meta.address
    expect(fn).toMatch(/address/);
  });

  it('does not show tokens with missing or empty address', () => {
    const fn = html.slice(html.indexOf('function _bridgeAvailableTokens'), html.indexOf('function _bridgeGetTokenMeta'));
    // Must filter — not just return all tokens unconditionally
    expect(fn).toMatch(/filter|if.*address|\.address/);
  });
});

// ── 12. getTokenAddressForChain used in executeBridgeViaLiFi ──────────────────
describe('executeBridgeViaLiFi: correct token address resolved per chain', () => {
  const fn = html.slice(
    html.indexOf('async function executeBridgeViaLiFi()'),
    html.indexOf('async function executeBridgeViaLiFi()') + 1500
  );

  it('resolves srcToken via getTokenAddressForChain using selected token symbol', () => {
    expect(fn).toContain('getTokenAddressForChain(fromChain.chainId, _lifiFromSym)');
  });

  it('resolves dstToken via getTokenAddressForChain using selected token symbol', () => {
    expect(fn).toContain('getTokenAddressForChain(toChain.chainId,   _lifiToSym)');
  });

  it('blocks execution when srcToken or dstToken is not found', () => {
    expect(fn).toContain('not available on this route');
  });
});

// ── 13. BridgeKitRouter.isEligible guards CCTP execution in executeBridgeViaCCTP ──
describe('executeBridgeViaCCTP: CCTP eligibility guard prevents invalid execution', () => {
  const fn = html.slice(
    html.indexOf('async function executeBridgeViaCCTP()'),
    html.indexOf('async function executeBridgeViaLiFi()')
  );

  it('calls BridgeKitRouter.isEligible before proceeding', () => {
    expect(fn).toContain('BridgeKitRouter.isEligible');
  });

  it('falls through to LI.FI when CCTP is not eligible for selected token', () => {
    expect(fn).toContain('executeBridgeViaLiFi()');
  });

  it('uses the current bridgeFromToken (not hardcoded USDC) for the eligibility check', () => {
    // The isEligible guard reads `token` (which is set to bridgeFromToken).
    // Check the whole CCTP function contains the token variable in the eligibility guard block.
    const eligIdx = fn.indexOf('BridgeKitRouter.isEligible');
    expect(eligIdx).toBeGreaterThan(-1);
    // The `token` variable (set from bridgeFromToken) must appear near the isEligible call
    // (within 300 chars before or after).
    const surroundingBlock = fn.slice(Math.max(0, eligIdx - 200), eligIdx + 300);
    expect(surroundingBlock).toMatch(/token/);
  });
});

// ── 14. Regression: BridgeKitRouter version still present ────────────────────
describe('BridgeKitRouter: module integrity preserved', () => {
  it('version is still exported', () => {
    expect(bkrSrc).toContain("version: '1.0.0'");
  });

  it('CHAINS map still has all 6 entries', () => {
    const R = makeBKR();
    expect(Object.keys(R.CHAINS).length).toBe(6);
  });

  it('bridge() and retry() are still exported', () => {
    const R = makeBKR();
    expect(typeof R.bridge).toBe('function');
    expect(typeof R.retry).toBe('function');
  });

  it('estimate() is still exported', () => {
    const R = makeBKR();
    expect(typeof R.estimate).toBe('function');
  });

  it('route() still returns lifi for non-CCTP tokens', () => {
    const R = makeBKR();
    expect(R.route(5042, 8453, 'cirBTC').provider).toBe('lifi');
    expect(R.route(5042, 8453, 'ETH').provider).toBe('lifi');
  });

  it('route() still returns cctp for USDC on CCTP pairs', () => {
    const R = makeBKR();
    expect(R.route(5042, 8453, 'USDC').provider).toBe('cctp');
    expect(R.route(1, 5042, 'USDC').provider).toBe('cctp');
  });

  it('route() returns lifi for EURC on non-EURC-CCTP chains', () => {
    const R = makeBKR();
    // Ethereum has no EURC — must route via LI.FI
    expect(R.route(1, 5042, 'EURC').provider).toBe('lifi');
    expect(R.route(5042, 1, 'EURC').provider).toBe('lifi');
    expect(R.route(5042, 42161, 'EURC').provider).toBe('lifi');
  });

  it('route() returns cctp for EURC on Arc↔Base', () => {
    const R = makeBKR();
    expect(R.route(5042, 8453, 'EURC').provider).toBe('cctp');
    expect(R.route(8453, 5042, 'EURC').provider).toBe('cctp');
  });
});

// ── 1.2: LiFiAdapter token address object fix ─────────────────────────────
// html is the module-level const (readFileSync at top of this file).
// Slice between the two async functions using index arithmetic.
const _fetchRoutesStart = html.indexOf('async function _fetchBridgeRoutes(');
const _fetchQuoteStart  = html.indexOf('async function _fetchBridgeQuote(');
const _fnFetchRoutes    = _fetchRoutesStart >= 0 && _fetchQuoteStart > _fetchRoutesStart
  ? html.slice(_fetchRoutesStart, _fetchQuoteStart) : '';

describe('_fetchBridgeRoutes passes address objects to LiFiAdapter (1.2 fix)', () => {
  it('builds _lifiTokenIn with fromMeta.address', () => {
    expect(_fnFetchRoutes).toContain('_lifiTokenIn');
    expect(_fnFetchRoutes).toContain('fromMeta.address');
  });

  it('builds _lifiTokenOut with toMeta.address', () => {
    expect(_fnFetchRoutes).toContain('_lifiTokenOut');
    expect(_fnFetchRoutes).toContain('toMeta.address');
  });

  it('passes _lifiTokenIn as tokenIn to LiFiAdapter.getRoutes', () => {
    expect(_fnFetchRoutes).toContain('tokenIn:      _lifiTokenIn');
    expect(_fnFetchRoutes).toContain('tokenOut:     _lifiTokenOut');
  });

  it('also passes address objects to LiFiAdapter.getQuote fallback', () => {
    expect(_fnFetchRoutes).toContain('tokenIn:     _lifiTokenIn');
    expect(_fnFetchRoutes).toContain('tokenOut:    _lifiTokenOut');
  });

  it('never passes a bare symbol string as tokenIn or tokenOut to LiFiAdapter from _fetchBridgeRoutes', () => {
    // Confirm no `tokenIn: fromSym` or `tokenOut: toSym` pattern anywhere in the function
    // (the old 1.1 pattern that relied on TOKEN_REGISTRY fallback).
    const noSymbolTokenIn  = !_fnFetchRoutes.includes('tokenIn:      fromSym') && !_fnFetchRoutes.includes("tokenIn: 'USDC'");
    const noSymbolTokenOut = !_fnFetchRoutes.includes('tokenOut:     toSym')   && !_fnFetchRoutes.includes("tokenOut: 'USDC'");
    expect(noSymbolTokenIn).toBe(true);
    expect(noSymbolTokenOut).toBe(true);
  });
});

// ── 1.2: executeBridgeViaLiFi uses address objects + _lifiToMeta ───────────
const _fnExecLiFiStart  = html.indexOf('async function executeBridgeViaLiFi(');
// _cctpPendingMints comes right after executeBridgeViaLiFi in the source.
const _fnExecLiFiEnd    = html.indexOf('function _cctpPendingMints(', _fnExecLiFiStart);
const _fnExecLiFi       = _fnExecLiFiStart >= 0 && _fnExecLiFiEnd > _fnExecLiFiStart
  ? html.slice(_fnExecLiFiStart, _fnExecLiFiEnd) : '';

describe('executeBridgeViaLiFi passes address objects to LiFiAdapter.getQuote (1.2 fix)', () => {
  it('declares _lifiToMeta alongside _lifiFromMeta', () => {
    expect(_fnExecLiFi).toContain('_lifiToMeta');
    expect(_fnExecLiFi).toContain('_bridgeGetTokenMeta(toChain.chainId,');
  });

  it('passes { address: srcToken, symbol: _lifiFromSym } as tokenIn', () => {
    expect(_fnExecLiFi).toContain('address: srcToken');
    expect(_fnExecLiFi).toContain('symbol: _lifiFromSym');
  });

  it('passes { address: dstToken, symbol: _lifiToSym } as tokenOut', () => {
    expect(_fnExecLiFi).toContain('address: dstToken');
    expect(_fnExecLiFi).toContain('symbol: _lifiToSym');
  });

  it('never passes bare _lifiFromSym or _lifiToSym as the whole tokenIn/tokenOut', () => {
    const noBareSym = !_fnExecLiFi.includes('tokenIn: _lifiFromSym') && !_fnExecLiFi.includes('tokenOut: _lifiToSym');
    expect(noBareSym).toBe(true);
  });
});
