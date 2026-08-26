/**
 * TowerAdapter — frontend bridge to the Tower Exchange swap proxy.
 * ═══════════════════════════════════════════════════════════════════════
 * Calls the server-side proxy (/api/tower/swap-quote) which guards the
 * TOWER_API_KEY. The proxy returns normalized fields:
 *   { ok, data: { expectedOut, minOut, calldata, to, spender, value, approval, ... } }
 *
 * No secret ever reaches the browser. Tower is OPTIONAL: every caller must
 * treat a failure as a signal to fall back to the local on-chain/PoolEngine flow.
 *
 * Attached to window.TowerAdapter
 */
(function () {
  'use strict';

  if (typeof window !== 'undefined' && window.TowerAdapter) return;

  var API = '/api/tower/swap-quote';

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
   * Fetch an optimal Tower quote.
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
   * Sanity-check a normalized Tower response before executing its calldata.
   * @param {object} data normalized proxy data
   * @param {object} ctx { amountInRaw: bigint, slippageBps: number }
   * @returns {{ok:boolean, reason?:string}}
   */
  function validateResponse(data, ctx) {
    if (!data || typeof data !== 'object') return { ok: false, reason: 'no_data' };
    if (!data.calldata || !/^0x[0-9a-fA-F]+$/.test(data.calldata)) return { ok: false, reason: 'invalid_calldata' };
    if (!data.to || !/^0x[0-9a-fA-F]{40}$/.test(data.to) || data.to === '0x0000000000000000000000000000000000000000') return { ok: false, reason: 'invalid_to' };
    if (data.expectedOut == null) return { ok: false, reason: 'missing_expected_out' };
    try {
      if (BigInt(String(data.expectedOut)) <= 0n) return { ok: false, reason: 'non_positive_output' };
    } catch (_) {
      return { ok: false, reason: 'invalid_output' };
    }
    return { ok: true };
  }

  window.TowerAdapter = {
    isAvailable: isAvailable,
    fetchQuote: fetchQuote,
    validateResponse: validateResponse,
    version: '1.0.0',
  };
})();
