/**
 * TowerAdapter — frontend bridge to the Tower Exchange swap proxy.
 * ═══════════════════════════════════════════════════════════════════════
 * Calls the server-side proxy (/api/tower/swap-quote) which guards the
 * TOWER_API_KEY. The proxy returns normalized fields:
 *   { ok, data: { expectedOut, minOut, calldata, to, spender, value, approval, ... } }
 *
 * This adapter is an INDEPENDENT liquidity source. It NEVER executes on its own
 * and NEVER decides by itself that it should win — the SwapAggregator compares it
 * against the local pools and picks the best route.
 *
 * getQuote() returns a normalized shape compatible with the LocalAdapter so the
 * SwapAggregator can compare both:
 *   { source:'tower', ok, tokenIn, tokenOut, amountInRaw, expectedOutRaw,
 *     minOutRaw, priceImpactBps, route, calldata, to, spender, expiresAt,
 *     executionType:'tower' }
 *
 * minOut is ALWAYS recomputed locally with SwapMath.calcMinOut (Tower's minOut is
 * never trusted blindly).
 *
 * Attached to window.TowerAdapter
 */
(function () {
  'use strict';

  if (typeof window !== 'undefined' && window.TowerAdapter) return;

  var API = '/api/tower/swap-quote';
  var QUOTE_TTL_MS = 60000; // conservative freshness window (ms)

  function _postJson(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'Invalid response', code: 'BAD_RESPONSE' }; });
    });
  }

  /** Availability check (no secret exposed). */
  async function isAvailable() {
    try {
      var r = await fetch(API, { method: 'GET', credentials: 'same-origin' });
      var d = await r.json().catch(function () { return null; });
      return !!(d && d.ok && d.available);
    } catch (_) {
      return false;
    }
  }

  /**
   * Fetch an optimal Tower quote (raw proxy response).
   * @param {object} opts { tokenIn, tokenOut, amountIn (raw string), slippageBps, userAddress? }
   * @returns {Promise<{ok:boolean, data?:object, error?:string, code?:string}>}
   */
  async function fetchQuote(opts) {
    opts = opts || {};
    var userAddress = opts.userAddress ||
      ((typeof walletAddress !== 'undefined' && walletAddress) ? walletAddress : null);
    return _postJson(API, {
      inputToken: opts.tokenIn,
      outputToken: opts.tokenOut,
      inputAmount: opts.amountIn != null ? String(opts.amountIn) : null,
      slippageTolerance: opts.slippageBps != null ? Number(opts.slippageBps) : 50,
      userAddress: userAddress || null,
    });
  }

  /**
   * Normalize a Tower quote into the aggregator's common quote shape.
   * Never throws — failures return { ok:false, error }.
   * @param {object} opts { tokenIn, tokenOut, amountInRaw: bigint, slippageBps, userAddress? }
   */
  async function getQuote(opts) {
    opts = opts || {};
    var amountInRaw = opts.amountInRaw;
    var amountInStr = (typeof amountInRaw === 'bigint')
      ? amountInRaw.toString()
      : (opts.amountIn != null ? String(opts.amountIn) : null);

    var res;
    try {
      res = await fetchQuote({
        tokenIn: opts.tokenIn,
        tokenOut: opts.tokenOut,
        amountIn: amountInStr,
        slippageBps: opts.slippageBps,
        userAddress: opts.userAddress,
      });
    } catch (e) {
      return { source: 'tower', ok: false, error: (e && e.message) || String(e) };
    }

    if (!res || res.ok !== true || !res.data) {
      return { source: 'tower', ok: false, error: (res && res.error) || 'TOWER_QUOTE_UNAVAILABLE', code: (res && res.code) || null };
    }

    var d = res.data;
    var expectedOutRaw;
    try {
      expectedOutRaw = BigInt(String(d.expectedOut));
    } catch (_) {
      return { source: 'tower', ok: false, error: 'INVALID_TOWER_OUTPUT' };
    }
    if (expectedOutRaw <= 0n) {
      return { source: 'tower', ok: false, error: 'NON_POSITIVE_OUTPUT' };
    }

    // minOut is ALWAYS recomputed locally — Tower's minOut is never trusted.
    var slippageBps = opts.slippageBps != null ? Number(opts.slippageBps) : 50;
    var minOutRaw = (typeof SwapMath !== 'undefined' && SwapMath.calcMinOut)
      ? SwapMath.calcMinOut(expectedOutRaw, slippageBps)
      : null;
    if (minOutRaw == null || minOutRaw <= 0n) {
      return { source: 'tower', ok: false, error: 'MIN_OUT_UNAVAILABLE' };
    }

    var priceImpactBps = d.priceImpact != null ? Math.round(Number(d.priceImpact) * 100) : null;

    return {
      source: 'tower',
      ok: true,
      tokenIn: opts.tokenIn || null,
      tokenOut: opts.tokenOut || null,
      chainId: 5042002,
      amountInRaw: (typeof amountInRaw === 'bigint') ? amountInRaw : null,
      expectedOutRaw: expectedOutRaw,
      minOutRaw: minOutRaw,
      priceImpactBps: priceImpactBps,
      feeBps: d.feeBps != null ? d.feeBps : null,
      route: d.route || null,
      calldata: d.calldata || null,
      to: d.to || null,
      spender: d.spender || null,
      value: d.value != null ? String(d.value) : '0',
      approval: d.approval || null,
      expiresAt: Date.now() + QUOTE_TTL_MS,
      executionType: 'tower',
      // Reference-only by default: Tower executability is finalized by the
      // SwapAggregator (hasLocalPool + calldata validity), never self-declared.
      executable: false,
    };
  }

  /**
   * Sanity-check a normalized Tower response before executing its calldata.
   * Accepts both the raw proxy shape (expectedOut string) and the normalized
   * aggregator shape (expectedOutRaw bigint).
   * @param {object} data normalized Tower data
   * @param {object} ctx { amountInRaw: bigint, slippageBps: number }
   * @returns {{ok:boolean, reason?:string}}
   */
  function validateResponse(data, ctx) {
    if (!data || typeof data !== 'object') return { ok: false, reason: 'no_data' };
    if (!data.calldata || !/^0x[0-9a-fA-F]+$/.test(data.calldata)) return { ok: false, reason: 'invalid_calldata' };
    if (!data.to || !/^0x[0-9a-fA-F]{40}$/.test(data.to) || data.to === '0x0000000000000000000000000000000000000000') return { ok: false, reason: 'invalid_to' };
    if (data.spender != null) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(data.spender) || data.spender === '0x0000000000000000000000000000000000000000') return { ok: false, reason: 'invalid_spender' };
    }
    var out = data.expectedOutRaw != null ? data.expectedOutRaw : data.expectedOut;
    if (out == null) return { ok: false, reason: 'missing_expected_out' };
    try {
      if (BigInt(String(out)) <= 0n) return { ok: false, reason: 'non_positive_output' };
    } catch (_) {
      return { ok: false, reason: 'invalid_output' };
    }
    return { ok: true };
  }

  window.TowerAdapter = {
    isAvailable: isAvailable,
    fetchQuote: fetchQuote,
    getQuote: getQuote,
    validateResponse: validateResponse,
    version: '1.1.0',
  };
})();
