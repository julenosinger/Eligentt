/**
 * swap-multitoken.test.js
 * Tests for multi-token/multi-chain swap expansion + token selector bug fix:
 * - LiFiAdapter _resolveTokenAddr handles objects, addresses, and symbols
 * - LiFiAdapter getTokens function is exported
 * - CF Function /api/lifi/tokens structure
 * - SwapAggregator validateAgainst accepts token objects
 * - SWP state has fromChainId/toChainId/tokenInObj/tokenOutObj
 * - swpExecuteLiFi guards: wrong-chain, expired quote, invalid calldata, zero minOut
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

const lifiSrc = fs.readFileSync(path.resolve(__dirname, '../shared/LiFiAdapter.js'), 'utf8');
const aggSrc  = fs.readFileSync(path.resolve(__dirname, '../shared/SwapAggregator.js'), 'utf8');
const indexSrc = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
const tokensCFSrc = fs.readFileSync(path.resolve(__dirname, '../functions/api/lifi/tokens.js'), 'utf8');

describe('LiFiAdapter', () => {
  it('exports getTokens', () => {
    expect(lifiSrc).toContain('getTokens: getTokens');
  });

  it('_resolveTokenAddr accepts token object with address', () => {
    expect(lifiSrc).toContain("typeof tokenOrSymbol === 'object' && tokenOrSymbol.address");
  });

  it('_resolveTokenAddr accepts plain address 0x...', () => {
    expect(lifiSrc).toContain('/^0x[0-9a-fA-F]{40}$/.test(tokenOrSymbol)');
  });

  it('_resolveDecimals reads from token object', () => {
    expect(lifiSrc).toContain('function _resolveDecimals');
    expect(lifiSrc).toContain('tokenOrSymbol.decimals != null');
  });

  it('getQuote includes tokenInAddr/tokenOutAddr/fromDecimals/toDecimals in result', () => {
    expect(lifiSrc).toContain('tokenInAddr: fromToken');
    expect(lifiSrc).toContain('tokenOutAddr: toToken');
    expect(lifiSrc).toContain('fromDecimals: fromDecimals');
    expect(lifiSrc).toContain('toDecimals: toDecimals');
  });

  it('TOKENS_API constant defined', () => {
    expect(lifiSrc).toContain("var TOKENS_API = '/api/lifi/tokens'");
  });

  it('getTokens calls TOKENS_API', () => {
    const body = lifiSrc.slice(lifiSrc.indexOf('async function getTokens('));
    const fn = body.slice(0, body.indexOf('\n  window.LiFiAdapter'));
    expect(fn).toContain('TOKENS_API');
    expect(fn).toContain('_tokCache');
  });

  it('in-memory cache avoids refetch within TTL', () => {
    const body = lifiSrc.slice(lifiSrc.indexOf('async function getTokens('));
    const fn = body.slice(0, body.indexOf('\n  window.LiFiAdapter'));
    expect(fn).toContain('TTL_MS');
    expect(fn).toContain('fetchedAt');
  });
});

describe('CF Function /api/lifi/tokens', () => {
  it('exports onRequestGet handler', () => {
    expect(tokensCFSrc).toContain('export async function onRequestGet');
  });

  it('uses ALLOWED_CHAIN_IDS to filter Arc+EVM chains', () => {
    expect(tokensCFSrc).toContain('ALLOWED_CHAIN_IDS');
    expect(tokensCFSrc).toContain('5042');
    expect(tokensCFSrc).toContain('8453');
    expect(tokensCFSrc).toContain('42161');
  });

  it('LIFI_API_KEY never returned in response body', () => {
    // Find all return json( calls and ensure LIFI_API_KEY is not in the data argument.
    const returnJsonMatches = tokensCFSrc.match(/return json\(\{[^}]*\}/g) || [];
    returnJsonMatches.forEach(m => {
      expect(m).not.toContain('LIFI_API_KEY');
    });
  });

  it('has cache logic (Cloudflare Cache API + Cache-Control header)', () => {
    expect(tokensCFSrc).toContain('caches.default');
    expect(tokensCFSrc).toContain('Cache-Control');
    expect(tokensCFSrc).toContain('CACHE_TTL_SECONDS');
  });

  it('normalizes token fields to safe shape', () => {
    expect(tokensCFSrc).toContain('chainId: Number(t.chainId');
    expect(tokensCFSrc).toContain("address: (t.address || '').toLowerCase()");
    expect(tokensCFSrc).toContain('decimals: Number(t.decimals)');
    expect(tokensCFSrc).toContain('logoURI: t.logoURI || null');
  });
});

describe('SwapAggregator validateAgainst token objects', () => {
  it('has _tokenKey helper', () => {
    expect(aggSrc).toContain('function _tokenKey(t)');
  });

  it('_tokenKey handles object by address+chainId', () => {
    const body = aggSrc.slice(aggSrc.indexOf('function _tokenKey(t)'));
    const fn = body.slice(0, body.indexOf('\n  function'));
    expect(fn).toContain("typeof t === 'object'");
    expect(fn).toContain('t.address');
  });

  it('validateAgainst compares by address when token object is provided', () => {
    const body = aggSrc.slice(aggSrc.indexOf('function validateAgainst('));
    const fn = body.slice(0, body.indexOf('\n  /**'));
    expect(fn).toContain('tokenInAddr');
    expect(fn).toContain('tokenOutAddr');
    expect(fn).toContain("opts.tokenIn === 'object'");
  });
});

describe('SWP multi-chain state', () => {
  const swpBlock = indexSrc.slice(indexSrc.indexOf('const SWP = {'), indexSrc.indexOf('\n};', indexSrc.indexOf('const SWP = {')) + 2);

  it('has fromChainId default 5042', () => {
    expect(swpBlock).toContain('fromChainId: 5042');
  });

  it('has toChainId default 5042', () => {
    expect(swpBlock).toContain('toChainId: 5042');
  });

  it('has tokenInObj field', () => {
    expect(swpBlock).toContain('tokenInObj: null');
  });

  it('has tokenOutObj field', () => {
    expect(swpBlock).toContain('tokenOutObj: null');
  });

  it('has _tokModalChainId', () => {
    expect(swpBlock).toContain('_tokModalChainId: 5042');
  });
});

describe('Token selector modal', () => {
  it('has #tok-chain-row for chain pills', () => {
    expect(indexSrc).toContain('id="tok-chain-row"');
  });

  it('has swpTokModalChain function', () => {
    expect(indexSrc).toContain('function swpTokModalChain(chainId)');
  });

  it('has selectTokenObj function', () => {
    expect(indexSrc).toContain('function selectTokenObj(tokenObj)');
  });

  it('selectTokenObj updates fromChainId/toChainId', () => {
    const body = indexSrc.slice(indexSrc.indexOf('function selectTokenObj(tokenObj)'));
    const fn = body.slice(0, body.indexOf('\n}', body.indexOf('SWP.tokSelectorTarget = null')) + 2);
    expect(fn).toContain('SWP.fromChainId = chainId');
    expect(fn).toContain('SWP.toChainId = chainId');
  });

  it('renderTokenList uses _tokListCache per chainId', () => {
    expect(indexSrc).toContain('_tokListCache[chainId]');
    expect(indexSrc).toContain("typeof LiFiAdapter !== 'undefined' && LiFiAdapter.getTokens");
  });

  it('chain pills use .tok-chain-pill CSS class', () => {
    expect(indexSrc).toContain('.tok-chain-pill{');
  });
});

describe('swpExecuteLiFi security guards', () => {
  const lifiExecStart = indexSrc.indexOf('async function swpExecuteLiFi(');
  const lifiExecEnd   = indexSrc.indexOf('\n// ── Execute Swap', lifiExecStart);
  const lifiExec = indexSrc.slice(lifiExecStart, lifiExecEnd);

  it('checks quote expiry before execution', () => {
    expect(lifiExec).toContain('Date.now() > q.expiresAt');
  });

  it('validates calldata is valid hex', () => {
    expect(lifiExec).toContain('/^0x[0-9a-fA-F]+$/.test(q.calldata)');
  });

  it('validates target address is non-zero', () => {
    expect(lifiExec).toContain('/^0x[0-9a-fA-F]{40}$/.test(q.to)');
  });

  it('guards against zero minOut', () => {
    expect(lifiExec).toContain('minOutRaw <= 0n');
  });

  it('validates spender is non-zero before approve', () => {
    expect(lifiExec).toContain("spender === '0x0000000000000000000000000000000000000000'");
  });

  it('uses fromDecimals/toDecimals from token objects', () => {
    expect(lifiExec).toContain('fromDecimals');
    expect(lifiExec).toContain('toDecimals');
  });

  it('resolves execFromChain from SWP.fromChainId', () => {
    expect(lifiExec).toContain('SWP.fromChainId || activeChainId');
  });
});

describe('LiFiAdapter lifiPromise in SwapAggregator', () => {
  it('passes token objects directly to LiFiAdapter.getQuote', () => {
    const aggBody = aggSrc.slice(aggSrc.indexOf('var lifiFromChain'));
    expect(aggBody.slice(0, 500)).toContain('tokenIn:     opts.tokenIn');
    expect(aggBody.slice(0, 500)).toContain('tokenOut:    opts.tokenOut');
  });
});

// ── Token Selector Bug-fix tests ─────────────────────────────────────────────
// Verifies that clicking a token in the panel calls selectTokenObj() with a
// safe integer index reference — NOT inline JSON that breaks HTML parsing.
describe('Token Selector onclick safety (bug fix)', () => {
  it('renderItem uses _tokRenderMap index, not JSON.stringify inline', () => {
    expect(indexSrc).toContain('_tokRenderMap = []');
    expect(indexSrc).toContain('_tokRenderMap.push(');
    // Must NOT inject JSON.stringify into onclick attribute
    expect(indexSrc).not.toContain('onclick="selectTokenObj(${JSON.stringify(');
    // Must use numeric index reference instead
    expect(indexSrc).toContain('onclick="selectTokenObj(_tokRenderMap[');
  });

  it('_tokRenderMap is reset before each render to avoid stale indices', () => {
    const render = indexSrc.slice(indexSrc.indexOf('async function renderTokenList('));
    // The reset happens after the renderItem closure is defined (which contains push).
    // Find the reset that appears after the closing of renderItem (i.e. after '  };')
    const closureEnd = render.indexOf('\n  };\n\n  // Reset render map');
    const resetIdx   = render.indexOf('_tokRenderMap = [];', closureEnd);
    const pushIdx    = render.indexOf('_tokRenderMap.push(');
    // push is inside the closure (defined first), reset fires at call time (after closure def)
    expect(resetIdx).toBeGreaterThan(-1);
    expect(render).toContain('// Reset render map each time');
    expect(render.slice(resetIdx)).toContain('_tokRenderMap = [];');
    // Ensure the reset comment precedes the first visible item render
    expect(resetIdx).toBeLessThan(render.indexOf('visible.map(t => renderItem'));
  });

  it('selectTokenObj is declared as a function', () => {
    expect(indexSrc).toContain('function selectTokenObj(tokenObj)');
  });

  it('selectTokenObj closes the panel and calls applySwapTokens + updateSwapRate', () => {
    const fn = indexSrc.slice(
      indexSrc.indexOf('function selectTokenObj(tokenObj)'),
      indexSrc.indexOf('\n// Inline token cycling', indexSrc.indexOf('function selectTokenObj(tokenObj)'))
    );
    expect(fn).toContain("classList.remove('open')");
    expect(fn).toContain('applySwapTokens()');
    expect(fn).toContain('updateSwapRate()');
  });

  it('selectTokenObj sets SWP.tokenInObj when target is in', () => {
    const fn = indexSrc.slice(
      indexSrc.indexOf('function selectTokenObj(tokenObj)'),
      indexSrc.indexOf('function swapTokens()')
    );
    expect(fn).toContain("SWP.tokSelectorTarget === 'in'");
    expect(fn).toContain('SWP.tokenInObj = tokenObj');
    expect(fn).toContain('SWP.fromChainId = chainId');
  });

  it('selectTokenObj sets SWP.tokenOutObj when target is out', () => {
    const fn = indexSrc.slice(
      indexSrc.indexOf('function selectTokenObj(tokenObj)'),
      indexSrc.indexOf('function swapTokens()')
    );
    expect(fn).toContain('SWP.tokenOutObj = tokenObj');
    expect(fn).toContain('SWP.toChainId = chainId');
  });

  it('openTokenSelector sets tokSelectorTarget to in or out', () => {
    const fn = indexSrc.slice(
      indexSrc.indexOf('function openTokenSelector(target)'),
      indexSrc.indexOf('function closeTokenSelector(')
    );
    expect(fn).toContain('SWP.tokSelectorTarget = target');
  });

  it('_swpTokIn prefers tokenInObj over TOKEN_LIST index', () => {
    const fn = indexSrc.slice(
      indexSrc.indexOf('function _swpTokIn()'),
      indexSrc.indexOf('function _swpTokOut()')
    );
    expect(fn).toContain('SWP.tokenInObj');
    expect(fn).toContain('TOKEN_LIST[SWP.tokenInIdx]');
  });

  it('swapTokens() flips tokenInObj and tokenOutObj', () => {
    const fn = indexSrc.slice(
      indexSrc.indexOf('function swapTokens()'),
      indexSrc.indexOf('// ── Route selection')
    );
    expect(fn).toContain('SWP.tokenInObj');
    expect(fn).toContain('SWP.tokenOutObj');
    expect(fn).toContain('SWP.fromChainId');
    expect(fn).toContain('SWP.toChainId');
  });
});
