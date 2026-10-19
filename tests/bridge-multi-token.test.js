/**
 * bridge-multi-token.test.js
 * Multi-Token Bridge 1.0 — static analysis tests.
 *
 * Validates that the Bridge tab supports multi-token selection without
 * regressing existing USDC/CCTP flows.  All tests are pure source-code
 * assertions (no runtime, no wallet, no network).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const html = readFileSync(join(__dirname, '../index.html'), 'utf8');
const bridgeKitRouterSrc = readFileSync(join(__dirname, '../shared/bridgeKitRouter.js'), 'utf8');
const lifiAdapterSrc     = readFileSync(join(__dirname, '../shared/LiFiAdapter.js'), 'utf8');

// ── 1. State variables ──────────────────────────────────────────────────────
describe('Multi-token Bridge state', () => {
  it('declares bridgeFromToken and bridgeToToken state vars', () => {
    expect(html).toContain('let bridgeFromToken');
    expect(html).toContain('bridgeToToken');
  });

  it('defaults both tokens to USDC (backward compatible)', () => {
    const match = html.match(/let bridgeFromToken\s*=\s*['"]USDC['"]/);
    expect(match).not.toBeNull();
    const match2 = html.match(/bridgeToToken\s*=\s*['"]USDC['"]/);
    expect(match2).not.toBeNull();
  });
});

// ── 2. Token selector HTML ──────────────────────────────────────────────────
describe('Bridge token selector HTML', () => {
  it('from-side token selector has id bridge-from-token-sel', () => {
    expect(html).toContain('id="bridge-from-token-sel"');
  });

  it('to-side token selector has id bridge-to-token-sel', () => {
    expect(html).toContain('id="bridge-to-token-sel"');
  });

  it('from-side icon has id bridge-from-token-icon', () => {
    expect(html).toContain('id="bridge-from-token-icon"');
  });

  it('to-side icon has id bridge-to-token-icon', () => {
    expect(html).toContain('id="bridge-to-token-icon"');
  });

  it('from-side token name has id bridge-from-token-name', () => {
    expect(html).toContain('id="bridge-from-token-name"');
  });

  it('to-side token name has id bridge-to-token-name', () => {
    expect(html).toContain('id="bridge-to-token-name"');
  });

  it('output amount symbol span has id bridge-amount-out-sym', () => {
    expect(html).toContain('id="bridge-amount-out-sym"');
  });

  it('from-balance token symbol span has id bridge-from-bal-sym', () => {
    expect(html).toContain('id="bridge-from-bal-sym"');
  });

  it('to-balance token symbol span has id bridge-to-bal-sym', () => {
    expect(html).toContain('id="bridge-to-bal-sym"');
  });

  it('token selectors open the picker on click', () => {
    expect(html).toContain('_bridgeOpenTokenPicker(\'from\')');
    expect(html).toContain('_bridgeOpenTokenPicker(\'to\')');
  });
});

// ── 3. Token picker functions ───────────────────────────────────────────────
describe('Bridge token picker functions', () => {
  it('_bridgeAvailableTokens is defined', () => {
    expect(html).toContain('function _bridgeAvailableTokens');
  });

  it('_bridgeGetTokenMeta is defined', () => {
    expect(html).toContain('function _bridgeGetTokenMeta');
  });

  it('_bridgeOpenTokenPicker is defined', () => {
    expect(html).toContain('function _bridgeOpenTokenPicker');
  });

  it('_bridgePickToken is defined', () => {
    expect(html).toContain('function _bridgePickToken');
  });

  it('_bridgeClosePicker is defined', () => {
    expect(html).toContain('function _bridgeClosePicker');
  });

  it('_bridgeUpdateTokenSelectors is defined', () => {
    expect(html).toContain('function _bridgeUpdateTokenSelectors');
  });

  it('picker modal HTML is present', () => {
    expect(html).toContain('id="bridge-token-picker"');
    expect(html).toContain('id="btp-list"');
    expect(html).toContain('id="btp-title"');
  });

  it('picker modal has a backdrop that closes on click', () => {
    expect(html).toContain('_bridgeClosePicker()');
  });

  it('CCTP badge shown for CCTP-eligible tokens in picker', () => {
    const fn = html.slice(html.indexOf('function _bridgeOpenTokenPicker'), html.indexOf('function _bridgePickToken'));
    // Badge uses isEligible (checks per-chain EURC support) rather than just isCCTPToken.
    expect(fn).toContain('BridgeKitRouter.isEligible');
    expect(fn).toContain('CCTP');
  });
});

// ── 4. _fetchBridgeRoutes uses selected tokens ──────────────────────────────
describe('_fetchBridgeRoutes multi-token routing', () => {
  const fn = html.slice(
    html.indexOf('async function _fetchBridgeRoutes'),
    html.indexOf('// ── Route panel rendering')
  );

  it('reads bridgeFromToken and bridgeToToken (not hardcoded USDC)', () => {
    expect(fn).toContain('bridgeFromToken');
    expect(fn).toContain('bridgeToToken');
    // Should NOT hardcode 'USDC' as the only token option in the LI.FI call
    // (may still contain 'USDC' as a fallback string, but the primary path must use the vars)
    expect(fn).toContain('fromSym');
    expect(fn).toContain('toSym');
  });

  it('resolves decimals per token from _bridgeGetTokenMeta', () => {
    expect(fn).toContain('_bridgeGetTokenMeta');
    expect(fn).toContain('fromDecimals');
    expect(fn).toContain('toDecimals');
  });

  it('computes amountInRaw using fromDecimals (not hardcoded 1e6)', () => {
    expect(fn).toContain('fromDecimals');
    expect(fn).toContain('Math.pow(10, fromDecimals)');
  });

  it('passes resolved token address objects to LiFiAdapter.getRoutes (not raw symbols)', () => {
    // 1.2: _lifiTokenIn / _lifiTokenOut carry { address, symbol, decimals }
    // so _resolveTokenAddr in LiFiAdapter uses the correct per-chain address.
    expect(fn).toContain('_lifiTokenIn');
    expect(fn).toContain('_lifiTokenOut');
    expect(fn).toContain('fromMeta.address');
    expect(fn).toContain('toMeta.address');
    expect(fn).toContain('fromSym');
    expect(fn).toContain('toSym');
  });

  it('uses BridgeKitRouter.isEligible (not just route) for CCTP decision', () => {
    expect(fn).toContain('BridgeKitRouter.isEligible');
  });

  it('CCTP path uses the actual selected token (fromSym)', () => {
    const cctpBlock = fn.slice(fn.indexOf('Provider 2: CCTP'), fn.indexOf('if (seq !== _bridgeRoutesSeq)'));
    expect(cctpBlock).toContain('fromSym');
  });
});

// ── 5. Route normalization uses dynamic decimals ────────────────────────────
describe('Route normalization decimal handling', () => {
  it('_brsFromLiFiRoute accepts a toDecimals parameter', () => {
    const fn = html.slice(html.indexOf('function _brsFromLiFiRoute'), html.indexOf('function _brsFromLiFi('));
    expect(fn).toContain('toDecimals');
    expect(fn).toContain('divisor');
    // Must NOT hardcode 1e6 for output
    expect(fn).not.toContain('/ 1e6');
  });

  it('_brsFromLiFi accepts a toDecimals parameter', () => {
    const fn = html.slice(html.indexOf('function _brsFromLiFi('), html.indexOf('// Normalize a BridgeKitRouter'));
    expect(fn).toContain('toDecimals');
    expect(fn).not.toContain('/ 1e6');
  });
});

// ── 6. brSelectRoute uses dynamic token symbol ──────────────────────────────
describe('brSelectRoute multi-token display', () => {
  const fn = html.slice(html.indexOf('function brSelectRoute(idx)'), html.indexOf('// Clear routes'));

  it('shows correct token symbol in "You Receive" field', () => {
    expect(fn).toContain('bridgeToToken');
    expect(fn).toContain('toSym');
    // Must not hardcode USDC in the receive display
    expect(fn).not.toMatch(/bridge-receive.*USDC/);
  });

  it('shows correct token symbol in Bridge button label', () => {
    expect(fn).toContain('bridgeFromToken');
  });
});

// ── 7. executeBridgeOrTurbo uses selected token ─────────────────────────────
describe('executeBridgeOrTurbo multi-token', () => {
  const fn = html.slice(
    html.indexOf('function executeBridgeOrTurbo()'),
    html.indexOf('// ── Bridge via Circle CCTP v2')
  );

  it('reads bridgeFromToken (not hardcoded USDC)', () => {
    expect(fn).toContain('bridgeFromToken');
    // The const token = line must use the state var
    expect(fn).toMatch(/const token\s*=.*bridgeFromToken/);
  });
});

// ── 8. executeBridgeViaCCTP multi-token ─────────────────────────────────────
describe('executeBridgeViaCCTP multi-token', () => {
  const fn = html.slice(
    html.indexOf('async function executeBridgeViaCCTP()'),
    html.indexOf('async function executeBridgeViaLiFi()')
  );

  it('reads bridgeFromToken for the token variable', () => {
    expect(fn).toContain('bridgeFromToken');
  });

  it('checks BridgeKitRouter.isEligible before proceeding (no blind CCTP for non-eligible tokens)', () => {
    expect(fn).toContain('BridgeKitRouter.isEligible');
    expect(fn).toContain('executeBridgeViaLiFi()');
  });

  it('passes the selected token to BridgeKitRouter.bridge', () => {
    expect(fn).toContain('BridgeKitRouter.bridge');
    // The bridge call must pass token (not hardcoded 'USDC')
    expect(fn).toContain('token, walletAddress');
  });

  it('uses token in step labels (not hardcoded USDC)', () => {
    expect(fn).toContain('Approve ${token}');
    expect(fn).toContain('Burn ${token}');
    expect(fn).toContain('Mint ${token}');
  });
});

// ── 9. executeBridgeViaLiFi multi-token ─────────────────────────────────────
describe('executeBridgeViaLiFi multi-token', () => {
  const fn = html.slice(
    html.indexOf('async function executeBridgeViaLiFi()'),
    html.indexOf('async function executeBridgeViaLiFi()') + 12000
  );

  it('reads bridgeFromToken and bridgeToToken', () => {
    expect(fn).toContain('bridgeFromToken');
    expect(fn).toContain('bridgeToToken');
  });

  it('uses selected token address (not just USDC) for srcToken', () => {
    expect(fn).toContain('_lifiFromSym');
    expect(fn).toContain('getTokenAddressForChain(fromChain.chainId, _lifiFromSym)');
  });

  it('computes amountInRaw using token-specific decimals', () => {
    expect(fn).toContain('_lifiFromDec');
    expect(fn).toContain('Math.pow(10, _lifiFromDec)');
  });

  it('passes resolved token addresses to LiFiAdapter.getQuote fallback (not raw symbols)', () => {
    // 1.2: we now pass { address: srcToken, symbol: _lifiFromSym, decimals } objects
    // so that LiFiAdapter._resolveTokenAddr gets the chain-correct address directly.
    expect(fn).toContain('address: srcToken');
    expect(fn).toContain('address: dstToken');
    expect(fn).toContain('symbol: _lifiFromSym');
    expect(fn).toContain('symbol: _lifiToSym');
  });

  it('uses dynamic token in approve step label', () => {
    expect(fn).toContain('Approve ${_lifiFromSym}');
  });
});

// ── 10. refreshBridgeBalances multi-token ───────────────────────────────────
describe('refreshBridgeBalances multi-token', () => {
  const fn = html.slice(
    html.indexOf('async function refreshBridgeBalances()'),
    html.indexOf('// ── Chain verification')
  );

  it('reads bridgeFromToken and bridgeToToken for balance lookups', () => {
    expect(fn).toContain('bridgeFromToken');
    expect(fn).toContain('bridgeToToken');
  });

  it('passes selected token symbol to _bridgeReadBal', () => {
    expect(fn).toContain('fromSym');
    expect(fn).toContain('toSym');
    expect(fn).toContain("_bridgeReadBal(from, fromSym,");
    expect(fn).toContain("_bridgeReadBal(to,   toSym,");
  });

  it('uses token-specific decimals (not hardcoded 1e6)', () => {
    expect(fn).toContain('decimals');
    expect(fn).not.toContain('/ 1e6');
  });
});

// ── 11. CCTP eligibility via BridgeKitRouter.isEligible ────────────────────
describe('CCTP eligibility check via BridgeKitRouter', () => {
  it('isEligible is exported by BridgeKitRouter', () => {
    expect(bridgeKitRouterSrc).toContain('isEligible: isEligible');
  });

  it('isEligible rejects non-CCTP tokens (cirBTC, ETH, WBTC)', () => {
    const win = {};
    const fn = new Function('window', bridgeKitRouterSrc);
    fn(win);
    const R = win.BridgeKitRouter;
    expect(R.isEligible(1, 5042, 'cirBTC')).toBe(false);
    expect(R.isEligible(1, 5042, 'ETH')).toBe(false);
    expect(R.isEligible(1, 5042, 'WBTC')).toBe(false);
  });

  it('isEligible approves USDC on all CCTP chain pairs', () => {
    const win = {};
    const fn = new Function('window', bridgeKitRouterSrc);
    fn(win);
    const R = win.BridgeKitRouter;
    expect(R.isEligible(1, 5042, 'USDC')).toBe(true);
    expect(R.isEligible(5042, 1, 'USDC')).toBe(true);
    expect(R.isEligible(8453, 42161, 'USDC')).toBe(true);
  });

  it('isEligible approves EURC only on Arc↔Base (both in EURC_CCTP_CHAINS)', () => {
    const win = {};
    const fn = new Function('window', bridgeKitRouterSrc);
    fn(win);
    const R = win.BridgeKitRouter;
    // Arc (5042) ↔ Base (8453): both have verified EURC addresses → eligible
    expect(R.isEligible(5042, 8453, 'EURC')).toBe(true);
    expect(R.isEligible(8453, 5042, 'EURC')).toBe(true);
  });

  it('isEligible rejects same-chain', () => {
    const win = {};
    const fn = new Function('window', bridgeKitRouterSrc);
    fn(win);
    const R = win.BridgeKitRouter;
    expect(R.isEligible(5042, 5042, 'USDC')).toBe(false);
  });

  it('isEligible rejects unsupported chains', () => {
    const win = {};
    const fn = new Function('window', bridgeKitRouterSrc);
    fn(win);
    const R = win.BridgeKitRouter;
    expect(R.isEligible(99999, 5042, 'USDC')).toBe(false);
  });
});

// ── 12. LiFiAdapter token resolution ────────────────────────────────────────
describe('LiFiAdapter token resolution', () => {
  it('_resolveTokenAddr accepts a symbol string', () => {
    expect(lifiAdapterSrc).toContain('_resolveTokenAddr');
    expect(lifiAdapterSrc).toContain('getTokenAddressForChain');
  });

  it('_resolveDecimals accepts a token object with decimals field', () => {
    expect(lifiAdapterSrc).toContain('_resolveDecimals');
    expect(lifiAdapterSrc).toContain('tokenOrSymbol.decimals');
  });

  it('getQuote normalizes fromDecimals and toDecimals in response', () => {
    expect(lifiAdapterSrc).toContain('fromDecimals: fromDecimals');
    expect(lifiAdapterSrc).toContain('toDecimals: toDecimals');
  });
});

// ── 13. swapBridgeChains also swaps tokens ──────────────────────────────────
describe('swapBridgeChains token swap', () => {
  it('swaps bridgeFromToken and bridgeToToken alongside chains', () => {
    const fn = html.slice(html.indexOf('function swapBridgeChains()'), html.indexOf('function applyBridgeChains()'));
    expect(fn).toContain('bridgeFromToken');
    expect(fn).toContain('bridgeToToken');
  });
});

// ── 14. No regression: existing bridge functions still present ───────────────
describe('Regression: existing bridge functions preserved', () => {
  it('executeBridgeViaCCTP still exists', () => {
    expect(html).toContain('async function executeBridgeViaCCTP()');
  });

  it('executeBridgeViaLiFi still exists', () => {
    expect(html).toContain('async function executeBridgeViaLiFi()');
  });

  it('executeBridgeOrTurbo still exists', () => {
    expect(html).toContain('function executeBridgeOrTurbo()');
  });

  it('BridgeKitRouter.bridge is still called in CCTP path', () => {
    const fn = html.slice(html.indexOf('async function executeBridgeViaCCTP()'), html.indexOf('async function executeBridgeViaLiFi()'));
    expect(fn).toContain('BridgeKitRouter.bridge');
  });

  it('BridgeKitRouter.retry is still called in CCTP path', () => {
    const fn = html.slice(html.indexOf('async function executeBridgeViaCCTP()'), html.indexOf('async function executeBridgeViaLiFi()'));
    expect(fn).toContain('BridgeKitRouter.retry');
  });

  it('LiFiAdapter.validateRoute is still called in LiFi path', () => {
    const fn = html.slice(html.indexOf('async function executeBridgeViaLiFi()'), html.indexOf('async function executeBridgeViaLiFi()') + 12000);
    expect(fn).toContain('LiFiAdapter.validateRoute');
  });

  it('_fetchBridgeRoutes still uses LiFiAdapter.getRoutes', () => {
    const fn = html.slice(html.indexOf('async function _fetchBridgeRoutes'), html.indexOf('// ── Route panel rendering'));
    expect(fn).toContain('LiFiAdapter.getRoutes');
  });

  it('bridge-history element still present (history not removed)', () => {
    expect(html).toContain('id="bridge-history"');
  });

  it('cctp-mint-banner-wrap still present (pending mint recovery not removed)', () => {
    expect(html).toContain('id="cctp-mint-banner-wrap"');
  });

  it('bridge-steps-card still present', () => {
    expect(html).toContain('id="bridge-steps-card"');
  });

  it('_brsClearRoutes requires explicit route selection guard', () => {
    const fn = html.slice(html.indexOf('function executeBridgeOrTurbo()'), html.indexOf('// ── Fallback: no routes loaded'));
    expect(fn).toContain('_bridgeRoutes.length > 0 && !_selectedBridgeRoute');
  });
});

// ── 15. Saldo / balance hardcoded USDC references eliminated ─────────────────
describe('Balance reader uses selected token', () => {
  it('refreshBridgeBalances no longer hardcodes USDC as the only token', () => {
    const fn = html.slice(
      html.indexOf('async function refreshBridgeBalances()'),
      html.indexOf('// ── Chain verification')
    );
    // Old hardcoded pattern was: chain && chain.tokens?.USDC?.address
    // New pattern reads from the selected token sym.
    expect(fn).not.toContain("chain.tokens?.USDC?.address");
  });
});

// ── 16. CSS for token picker ─────────────────────────────────────────────────
describe('Bridge token picker CSS', () => {
  it('#bridge-token-picker CSS is defined', () => {
    expect(html).toContain('#bridge-token-picker{');
  });

  it('.btp-modal CSS is defined', () => {
    expect(html).toContain('.btp-modal{');
  });

  it('.btp-item CSS is defined', () => {
    expect(html).toContain('.btp-item{');
  });
});
