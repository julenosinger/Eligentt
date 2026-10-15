/**
 * swap-crosschain-regression.test.js
 * ═══════════════════════════════════════════════════════════════════════
 * Regression guards for the cross-chain LI.FI swap fix + router refresh throttle:
 *
 *   1. `LI.FI route rejected: no_route` — swpSelectRoute must resolve the full
 *      LI.FI step (action + transactionRequest) into the quote's `route` field
 *      so LiFiAdapter.validateRoute validates a REAL step (not undefined).
 *   2. validateRoute accepts a valid cross-chain step and rejects mismatches.
 *   3. Auto-refresh is throttled to a 30s minimum, suspends during execution,
 *      offers a manual refresh, and surfaces the last-updated time.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const lifiSrc = fs.readFileSync(path.join(root, 'shared', 'LiFiAdapter.js'), 'utf8');

function loadLiFi() {
  const w = {};
  new Function('window', lifiSrc).call(null, w);
  return w.LiFiAdapter;
}

const ADDR = '0x2de8906a641d65d490bc60a4179d961d59742bcb';
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const ARC_USDC  = '0x3600000000000000000000000000000000000000';

function liFiStep(over) {
  return Object.assign({
    id: 'step-1', type: 'lifi', tool: 'cctp',
    action: {
      fromChainId: 8453, toChainId: 5042,
      fromToken: { address: BASE_USDC, symbol: 'USDC' },
      toToken: { address: ARC_USDC, symbol: 'USDC' },
      fromAmount: '1000000', toAddress: ADDR,
    },
    transactionRequest: { to: ADDR, data: '0xabcdef', value: '0', chainId: 8453, from: ADDR },
  }, over || {});
}

describe('no_route root cause — swpSelectRoute resolves the LI.FI step', () => {
  it('patchedQ stores the resolved step in `route` for validateRoute', () => {
    const fn = html.slice(html.indexOf('function swpSelectRoute(source)'), html.indexOf('function swpApplySelectedQuote('));
    expect(fn).toContain('route:      stepRes.step');
    expect(fn).toContain('_needsStepTx: false');
  });
});

describe('LiFiAdapter.validateRoute — cross-chain step validation', () => {
  const L = loadLiFi();

  function ctx(over) {
    return Object.assign({
      fromChainId: 8453, toChainId: 5042,
      fromToken: BASE_USDC, toToken: ARC_USDC,
      amountRaw: '1000000', recipient: ADDR, sender: ADDR, value: '0',
    }, over || {});
  }

  it('accepts a valid cross-chain step (Base → Arc)', () => {
    expect(L.validateRoute(liFiStep(), ctx()).ok).toBe(true);
  });

  it('accepts a valid Arc → Base step', () => {
    const s = liFiStep({
      action: {
        fromChainId: 5042, toChainId: 8453,
        fromToken: { address: ARC_USDC, symbol: 'USDC' },
        toToken: { address: BASE_USDC, symbol: 'USDC' },
        fromAmount: '1000000', toAddress: ADDR,
      },
      transactionRequest: { to: ADDR, data: '0xabcdef', value: '0', chainId: 5042, from: ADDR },
    });
    expect(L.validateRoute(s, ctx({ fromChainId: 5042, toChainId: 8453, fromToken: ARC_USDC, toToken: BASE_USDC })).ok).toBe(true);
  });

  it('returns no_route for a missing step (the case the caller now prevents)', () => {
    const r = L.validateRoute(undefined, ctx());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_route');
  });

  it('rejects from_chain_mismatch', () => {
    const r = L.validateRoute(liFiStep(), ctx({ fromChainId: 1 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('from_chain_mismatch');
  });

  it('rejects amount_mismatch (never sign a different amount)', () => {
    const r = L.validateRoute(liFiStep(), ctx({ amountRaw: '999' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('amount_mismatch');
  });

  it('rejects from_token_mismatch (genuinely different source token)', () => {
    // Step built for Base USDC, validated against a DIFFERENT source token address.
    const r = L.validateRoute(liFiStep(), ctx({ fromToken: '0x' + 'ee'.repeat(20) }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('from_token_mismatch');
  });

  it('rejects to_token_mismatch (different destination token)', () => {
    const r = L.validateRoute(liFiStep(), ctx({ toToken: '0x' + 'dd'.repeat(20) }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('to_token_mismatch');
  });

  it('rejects invalid target (missing transactionRequest.to)', () => {
    const s = liFiStep({ transactionRequest: { to: null, data: '0xabcdef', value: '0', chainId: 8453 } });
    const r = L.validateRoute(s, ctx());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid_target');
  });

  it('rejects transaction_chain_mismatch (tx chain differs from source)', () => {
    const s = liFiStep({ transactionRequest: { to: ADDR, data: '0xabcdef', value: '0', chainId: 1 } });
    const r = L.validateRoute(s, ctx());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('transaction_chain_mismatch');
  });
});

describe('Swap auto-refresh — 30s minimum interval', () => {
  it('defines SWAP_QUOTE_AUTO_REFRESH_MS = 30000', () => {
    expect(html).toContain('SWAP_QUOTE_AUTO_REFRESH_MS = 30000');
  });

  it('has start/stop auto-refresh functions', () => {
    expect(html).toContain('function swapStartQuoteAutoRefresh()');
    expect(html).toContain('function swapStopQuoteAutoRefresh()');
  });

  it('suspends auto-refresh during signing/execution (_swpExecuting guard)', () => {
    const fn = html.slice(html.indexOf('function swapStartQuoteAutoRefresh()'), html.indexOf('function swapStopQuoteAutoRefresh()'));
    expect(fn).toContain('if (_swpExecuting) return');
    expect(fn).toContain("page.classList.contains('active')");
  });

  it('offers a manual refresh (swpManualRefresh)', () => {
    expect(html).toContain('function swpManualRefresh()');
  });

  it('shows the last-updated time + a manual refresh button', () => {
    expect(html).toContain('function swpUpdateTimestamp()');
    expect(html).toContain('id="swp-updated"');
    expect(html).toContain('id="swp-refresh-btn"');
    expect(html).toContain('onclick="swpManualRefresh()"');
  });

  it('SWP state carries lastQuoteAt', () => {
    expect(html).toContain('lastQuoteAt: 0');
  });
});
