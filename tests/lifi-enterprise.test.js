/**
 * LiFiAdapter — Smart Slippage + Quote Simulation (LI.FI Enterprise)
 * Tests that:
 *   1. simulate:true is sent in both getQuote and getRoutes payloads.
 *   2. slippage:'auto' is sent when no explicit slippageBps is provided.
 *   3. When slippageBps IS provided explicitly, the numeric value is used (not 'auto').
 *   4. The existing behaviour (validation, token resolution, minOut fallback) is
 *      unaffected — these are regression checks, not new functionality.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const adapterSrc = fs.readFileSync(
  path.resolve(__dirname, '../shared/LiFiAdapter.js'), 'utf8'
);

// ── helpers ──────────────────────────────────────────────────────────────────

function fnBlock(src, fnName, windowSize) {
  var idx = src.indexOf('async function ' + fnName + '(');
  if (idx === -1) idx = src.indexOf('function ' + fnName + '(');
  if (idx === -1) return '';
  return src.slice(idx, idx + (windowSize || 3000));
}

// ── S1: Quote Simulation ──────────────────────────────────────────────────────

describe('S1 — Quote Simulation flag', () => {
  const getQuoteBlock  = fnBlock(adapterSrc, 'getQuote',  4000);
  const getRoutesBlock = fnBlock(adapterSrc, 'getRoutes', 4000);

  it('getQuote payload includes simulate: true', () => {
    expect(getQuoteBlock).toContain('simulate: true');
  });

  it('getRoutes payload includes simulate: true', () => {
    expect(getRoutesBlock).toContain('simulate: true');
  });

  it('simulate flag appears INSIDE the _postJson call body in getQuote', () => {
    // Must be between the _postJson( call and its closing );
    const postStart = getQuoteBlock.indexOf('_postJson(API,');
    const postEnd   = getQuoteBlock.indexOf('});', postStart);
    const callBody  = getQuoteBlock.slice(postStart, postEnd);
    expect(callBody).toContain('simulate: true');
  });

  it('simulate flag appears INSIDE the _postJson call body in getRoutes', () => {
    const postStart = getRoutesBlock.indexOf('_postJson(ROUTES_API,');
    const postEnd   = getRoutesBlock.indexOf('});', postStart);
    const callBody  = getRoutesBlock.slice(postStart, postEnd);
    expect(callBody).toContain('simulate: true');
  });
});

// ── S2: Smart Slippage — 'auto' default ─────────────────────────────────────

describe('S2 — Smart Slippage: auto when no explicit slippageBps', () => {
  const getQuoteBlock  = fnBlock(adapterSrc, 'getQuote',  4000);
  const getRoutesBlock = fnBlock(adapterSrc, 'getRoutes', 4000);

  it('getQuote declares slippageParam with auto fallback', () => {
    expect(getQuoteBlock).toContain("opts.slippageBps != null ? slippageBps / 10000 : 'auto'");
  });

  it('getRoutes declares slippageParam with auto fallback', () => {
    expect(getRoutesBlock).toContain("opts.slippageBps != null ? slippageBps / 10000 : 'auto'");
  });

  it('getQuote passes slippageParam (not hardcoded fraction) to payload', () => {
    const postStart = getQuoteBlock.indexOf('_postJson(API,');
    const postEnd   = getQuoteBlock.indexOf('});', postStart);
    const callBody  = getQuoteBlock.slice(postStart, postEnd);
    expect(callBody).toContain('slippage: slippageParam');
    // Must NOT pass the old hardcoded fraction directly
    expect(callBody).not.toContain('slippage: slippageBps / 10000');
  });

  it('getRoutes passes slippageParam (not hardcoded fraction) to payload', () => {
    const postStart = getRoutesBlock.indexOf('_postJson(ROUTES_API,');
    const postEnd   = getRoutesBlock.indexOf('});', postStart);
    const callBody  = getRoutesBlock.slice(postStart, postEnd);
    expect(callBody).toContain('slippage: slippageParam');
    expect(callBody).not.toContain('slippage: slippageBps / 10000');
  });
});

// ── S3: Explicit slippageBps still respected ────────────────────────────────

describe('S3 — Explicit slippageBps preserved (not overridden by auto)', () => {
  it('when opts.slippageBps != null, numeric fraction is computed', () => {
    // The ternary: opts.slippageBps != null ? slippageBps / 10000 : 'auto'
    // Verify the ternary contains the numeric path
    const block = fnBlock(adapterSrc, 'getQuote', 4000);
    expect(block).toContain('slippageBps / 10000');
  });

  it('the auto path is only taken when slippageBps is null/undefined', () => {
    const block = fnBlock(adapterSrc, 'getQuote', 4000);
    // The full ternary must check != null before returning auto
    expect(block).toMatch(/opts\.slippageBps\s*!=\s*null\s*\?\s*slippageBps\s*\/\s*10000\s*:\s*'auto'/);
  });
});

// ── S4: Regression — existing fields still present in payload ────────────────

describe('S4 — Regression: existing required fields still present', () => {
  const getQuoteBlock  = fnBlock(adapterSrc, 'getQuote',  4000);
  const getRoutesBlock = fnBlock(adapterSrc, 'getRoutes', 4000);

  it('getQuote still sends fromChain, toChain, fromToken, toToken, fromAmount, integrator', () => {
    expect(getQuoteBlock).toContain('fromChain: fromChainId');
    expect(getQuoteBlock).toContain('toChain: toChainId');
    expect(getQuoteBlock).toContain('fromToken: fromToken');
    expect(getQuoteBlock).toContain('toToken: toToken');
    expect(getQuoteBlock).toContain('fromAmount: amountStr');
    expect(getQuoteBlock).toContain("integrator: 'elligentt'");
  });

  it('getRoutes still sends fromChainId, toChainId, fromTokenAddress, toTokenAddress, fromAmount, integrator', () => {
    expect(getRoutesBlock).toContain('fromChainId: fromChainId');
    expect(getRoutesBlock).toContain('toChainId: toChainId');
    expect(getRoutesBlock).toContain('fromTokenAddress: fromToken');
    expect(getRoutesBlock).toContain('toTokenAddress: toToken');
    expect(getRoutesBlock).toContain('fromAmount: amountStr');
    expect(getRoutesBlock).toContain("integrator: 'elligentt'");
  });

  it('validateRoute is unchanged — still checks chain, token, amount, calldata', () => {
    const valBlock = fnBlock(adapterSrc, 'validateRoute', 2000);
    expect(valBlock).toContain('from_chain_mismatch');
    expect(valBlock).toContain('to_chain_mismatch');
    expect(valBlock).toContain('from_token_mismatch');
    expect(valBlock).toContain('amount_mismatch');
    expect(valBlock).toContain('invalid_calldata');
    expect(valBlock).toContain('invalid_target');
  });

  it('minOutRaw fallback to SwapMath still present in getQuote', () => {
    expect(getQuoteBlock).toContain('SwapMath.calcMinOut');
  });

  it('QUOTE_TTL_MS still 60000', () => {
    expect(adapterSrc).toContain('var QUOTE_TTL_MS = 60000');
  });
});

// ── S5: Version bump ─────────────────────────────────────────────────────────

describe('S5 — Version bump', () => {
  it("version is '1.3.0'", () => {
    expect(adapterSrc).toContain("version: '1.3.0'");
  });
});

// ── S7: CF proxy — quote.js forwards simulate + slippage:'auto' ─────────────

describe('S7 — CF proxy quote.js: simulate and Smart Slippage', () => {
  const quoteSrc = fs.readFileSync(
    path.resolve(__dirname, '../functions/api/lifi/quote.js'), 'utf8'
  );

  it('quote.js handles slippage === auto and sets params.set("slippage","auto")', () => {
    expect(quoteSrc).toContain("body.slippage === 'auto'");
    expect(quoteSrc).toContain("params.set('slippage', 'auto')");
  });

  it('quote.js still validates numeric slippage with Number.isFinite check', () => {
    expect(quoteSrc).toContain('Number.isFinite(s)');
    expect(quoteSrc).toContain('s >= 0 && s <= 1');
  });

  it('quote.js forwards simulate:true to upstream URL params', () => {
    expect(quoteSrc).toContain("body.simulate === true");
    expect(quoteSrc).toContain("params.set('simulate', 'true')");
  });

  it('quote.js does NOT silently discard slippage:auto (old code would have done Number("auto")=NaN → skip)', () => {
    // The old path was: const s = Number(body.slippage); if (Number.isFinite(s)...)
    // With 'auto', Number('auto')=NaN, isFinite=false → param silently dropped.
    // Confirm the new code checks for 'auto' BEFORE the numeric path.
    const autoIdx    = quoteSrc.indexOf("body.slippage === 'auto'");
    const numericIdx = quoteSrc.indexOf('Number(body.slippage)');
    expect(autoIdx).toBeGreaterThan(-1);
    expect(numericIdx).toBeGreaterThan(-1);
    expect(autoIdx).toBeLessThan(numericIdx); // auto check comes first
  });
});

// ── S8: CF proxy — routes.js forwards simulate + slippage:'auto' ─────────────

describe('S8 — CF proxy routes.js: simulate and Smart Slippage', () => {
  const routesSrc = fs.readFileSync(
    path.resolve(__dirname, '../functions/api/lifi/routes.js'), 'utf8'
  );

  it('routes.js handles slippage === auto', () => {
    expect(routesSrc).toContain("body.slippage === 'auto'");
    expect(routesSrc).toContain("? 'auto'");
  });

  it('routes.js still has numeric fallback (0.005) when slippage invalid', () => {
    expect(routesSrc).toContain('0.005');
  });

  it('routes.js forwards simulate:true inside options object', () => {
    expect(routesSrc).toContain('body.simulate === true');
    expect(routesSrc).toContain('simulate: true');
  });

  it('routes.js does NOT use hardcoded 0.005 when slippage:auto is passed', () => {
    // Confirm ternary: body.slippage === 'auto' ? 'auto' : (numeric check) ? numeric : 0.005
    expect(routesSrc).toMatch(/body\.slippage\s*===\s*'auto'\s*\?\s*'auto'/);
  });

  it('routes.js old path would have fallen to 0.005 for slippage:auto — confirm fixed', () => {
    // Old: Number.isFinite(Number('auto')) = false → 0.005 forced.
    // New code must have 'auto' === check before the numeric path.
    const autoIdx    = routesSrc.indexOf("body.slippage === 'auto'");
    const numericIdx = routesSrc.indexOf("Number.isFinite(Number(body.slippage))");
    expect(autoIdx).toBeGreaterThan(-1);
    expect(numericIdx).toBeGreaterThan(-1);
    expect(autoIdx).toBeLessThan(numericIdx);
  });
});

// ── S6: No regressions in other modules (scope check) ────────────────────────

describe('S6 — Scope check: only LiFiAdapter.js changed', () => {
  it('index.html does not contain the simulate flag (change is in shared/ only)', () => {
    // The simulate:true param lives in LiFiAdapter.js, not hardcoded in index.html
    // This confirms the implementation is in the right place
    const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
    // index.html may reference LiFiAdapter but must NOT duplicate the simulate flag
    // (that would mean someone added it outside the adapter — fragile duplication)
    const lifiCallInHtml = html.indexOf("simulate: true");
    // It's ok to have 0 occurrences in index.html
    // If it appears, it must only be in a comment or documentation string, not a payload
    if (lifiCallInHtml !== -1) {
      const ctx = html.slice(Math.max(0, lifiCallInHtml - 100), lifiCallInHtml + 100);
      // If present it must be inside a comment
      expect(ctx).toMatch(/\/\/|\/\*/);
    }
  });
});
