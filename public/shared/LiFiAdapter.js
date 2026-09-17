/**
 * LiFiAdapter — frontend bridge to the LI.FI routing API (server-side proxy).
 * ═══════════════════════════════════════════════════════════════════════
 * Calls the server-side proxy (/api/lifi/quote) which guards the optional
 * LIFI_API_KEY. LI.FI returns a signed-agnostic Step with a `transactionRequest`
 * (to / data / value / chainId / gas) that the wallet signs directly.
 *
 * This adapter is an INDEPENDENT routing provider (LI.FI aggregates bridges +
 * DEXes). It NEVER executes on its own and NEVER self-declares executability —
 * the SwapAggregator / Send Assets flow finalizes executability from full route
 * validity (calldata / target / chain / token / amount / recipient).
 *
 * getQuote() returns a normalized shape compatible with TowerAdapter / LocalAdapter:
 *   { source:'lifi', ok, tokenIn, tokenOut, fromChainId, toChainId, amountInRaw,
 *     expectedOutRaw, minOutRaw, priceImpactBps, feeBps, route, calldata, to,
 *     spender, value, expiresAt, executionType:'lifi', executable:false,
 *     toAddress, lifiRouteId, transactionId }
 *
 * LI.FI calldata is UNTRUSTED external data: validateRoute() must pass before
 * any signature. Do not sign arbitrary calldata returned by LI.FI.
 *
 * Attached to window.LiFiAdapter
 */
(function () {
  'use strict';

  if (typeof window !== 'undefined' && window.LiFiAdapter) return;

  var API = '/api/lifi/quote';
  var STATUS_API = '/api/lifi/status';
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

  function _resolveTokenAddr(chainId, symbol) {
    try {
      if (typeof getTokenAddressForChain === 'function') {
        var a = getTokenAddressForChain(chainId, symbol);
        if (a) return a;
      }
    } catch (_) {}
    return null;
  }

  function _toStr(v) {
    if (v == null) return null;
    return (typeof v === 'bigint') ? v.toString() : String(v);
  }

  /** Availability check (no secret exposed). */
  async function isAvailable() {
    try {
      var r = await fetch(API, { method: 'GET', credentials: 'same-origin' });
      var d = await r.json().catch(function () { return null; });
      return !!(d && d.ok);
    } catch (_) {
      return false;
    }
  }

  /**
   * Fetch + normalize a LI.FI quote. Never throws — failures return { ok:false }.
   * @param {object} opts {
   *   tokenIn: symbol, tokenOut: symbol, amountInRaw: bigint,
   *   fromChainId: number, toChainId: number, slippageBps: number,
   *   fromAddress?: string, toAddress?: string
   * }
   */
  async function getQuote(opts) {
    opts = opts || {};
    var amountInRaw = opts.amountInRaw;
    var fromChainId = Number(opts.fromChainId);
    var toChainId = Number(opts.toChainId);
    var slippageBps = opts.slippageBps != null ? Number(opts.slippageBps) : 50;

    if (!Number.isFinite(fromChainId) || !Number.isFinite(toChainId)) {
      return { source: 'lifi', ok: false, error: 'INVALID_CHAIN_IDS' };
    }
    var fromToken = _resolveTokenAddr(fromChainId, opts.tokenIn);
    var toToken = _resolveTokenAddr(toChainId, opts.tokenOut);
    if (!fromToken || !toToken) {
      return { source: 'lifi', ok: false, error: 'TOKEN_NOT_REGISTERED' };
    }
    var amountStr = _toStr(amountInRaw);
    if (amountStr == null || !/^[0-9]+$/.test(amountStr)) {
      return { source: 'lifi', ok: false, error: 'INVALID_AMOUNT' };
    }
    var fromAddress = opts.fromAddress ||
      ((typeof walletAddress !== 'undefined' && walletAddress) ? walletAddress : null);
    if (!fromAddress) {
      return { source: 'lifi', ok: false, error: 'NO_FROM_ADDRESS' };
    }

    var res;
    try {
      res = await _postJson(API, {
        fromChain: fromChainId,
        toChain: toChainId,
        fromToken: fromToken,
        toToken: toToken,
        fromAmount: amountStr,
        fromAddress: fromAddress,
        toAddress: opts.toAddress || null,
        slippage: slippageBps / 10000,
        integrator: 'elligentt',
      });
    } catch (e) {
      return { source: 'lifi', ok: false, error: (e && e.message) || String(e) };
    }

    if (!res || res.ok !== true || !res.data) {
      return { source: 'lifi', ok: false, error: (res && res.error) || 'LIFI_QUOTE_UNAVAILABLE', code: (res && res.code) || null };
    }

    var step = res.data;
    if (!step || !step.transactionRequest || !step.estimate) {
      return { source: 'lifi', ok: false, error: 'MALFORMED_LIFI_STEP' };
    }

    var tr = step.transactionRequest;
    var est = step.estimate;
    var expectedOutRaw;
    try { expectedOutRaw = BigInt(String(est.toAmount)); } catch (_) {
      return { source: 'lifi', ok: false, error: 'INVALID_LIFI_OUTPUT' };
    }
    if (expectedOutRaw <= 0n) {
      return { source: 'lifi', ok: false, error: 'NON_POSITIVE_OUTPUT' };
    }

    // minOut comes from LI.FI's on-chain-enforced toAmountMin (authoritative for
    // LI.FI calldata). Fall back to local slippage math only if absent.
    var minOutRaw = null;
    if (est.toAmountMin != null) {
      try { minOutRaw = BigInt(String(est.toAmountMin)); } catch (_) { minOutRaw = null; }
    }
    if (minOutRaw == null || minOutRaw <= 0n) {
      minOutRaw = (typeof SwapMath !== 'undefined' && SwapMath.calcMinOut)
        ? SwapMath.calcMinOut(expectedOutRaw, slippageBps)
        : expectedOutRaw;
    }

    var feeBps = null;
    if (Array.isArray(est.feeCosts) && est.feeCosts.length) {
      var sum = 0;
      for (var i = 0; i < est.feeCosts.length; i++) {
        var p = parseFloat(est.feeCosts[i] && est.feeCosts[i].percentage);
        if (Number.isFinite(p)) sum += p;
      }
      feeBps = Math.round(sum * 10000);
    }

    return {
      source: 'lifi',
      ok: true,
      tokenIn: opts.tokenIn || null,
      tokenOut: opts.tokenOut || null,
      fromChainId: fromChainId,
      toChainId: toChainId,
      amountInRaw: (typeof amountInRaw === 'bigint') ? amountInRaw : null,
      expectedOutRaw: expectedOutRaw,
      minOutRaw: minOutRaw,
      priceImpactBps: null,
      feeBps: feeBps,
      route: step,
      calldata: (tr && tr.data) || null,
      to: (tr && tr.to) || null,
      spender: (est.approvalAddress) || null,
      value: tr && tr.value != null ? String(tr.value) : '0',
      approval: null,
      expiresAt: Date.now() + QUOTE_TTL_MS,
      executionType: 'lifi',
      executable: false, // finalized by the aggregator / send flow
      toAddress: opts.toAddress || fromAddress,
      lifiRouteId: step.id || null,
      transactionId: step.transactionId || null,
      tool: (step.toolDetails && step.toolDetails.key) || step.tool || null,
    };
  }

  /**
   * Validate a LI.FI Step against the requested operation. Rejects any mismatch
   * in chain / token / amount / recipient, and rejects missing/invalid tx data.
   * @param {object} step normalized LI.FI step (route)
   * @param {object} ctx { fromChainId, toChainId, fromToken, toToken, amountRaw, recipient }
   * @returns {{ok:boolean, reason?:string}}
   */
  function validateRoute(step, ctx) {
    ctx = ctx || {};
    if (!step || typeof step !== 'object') return { ok: false, reason: 'no_route' };
    var action = step.action || null;
    if (!action) return { ok: false, reason: 'no_action' };
    if (Number(action.fromChainId) !== Number(ctx.fromChainId)) return { ok: false, reason: 'from_chain_mismatch' };
    if (Number(action.toChainId) !== Number(ctx.toChainId)) return { ok: false, reason: 'to_chain_mismatch' };
    if (ctx.fromToken && action.fromToken && String(action.fromToken.address).toLowerCase() !== String(ctx.fromToken).toLowerCase()) {
      return { ok: false, reason: 'from_token_mismatch' };
    }
    if (ctx.toToken && action.toToken && String(action.toToken.address).toLowerCase() !== String(ctx.toToken).toLowerCase()) {
      return { ok: false, reason: 'to_token_mismatch' };
    }
    if (ctx.amountRaw != null && String(action.fromAmount) !== String(ctx.amountRaw)) {
      return { ok: false, reason: 'amount_mismatch' };
    }
    var tr = step.transactionRequest;
    if (!tr || !/^0x[0-9a-fA-F]{40}$/.test(tr.to || '') || tr.to === '0x0000000000000000000000000000000000000000') {
      return { ok: false, reason: 'invalid_target' };
    }
    if (!tr.data || !/^0x[0-9a-fA-F]+$/.test(tr.data)) {
      return { ok: false, reason: 'invalid_calldata' };
    }
    // transactionRequest.chainId must match the requested SOURCE chain (fail closed).
    if (ctx.fromChainId != null && tr.chainId != null && Number(tr.chainId) !== Number(ctx.fromChainId)) {
      return { ok: false, reason: 'transaction_chain_mismatch' };
    }
    // If LI.FI returns a `from`, it must be the connected wallet (never a third party).
    if (ctx.sender && tr.from && String(tr.from).toLowerCase() !== String(ctx.sender).toLowerCase()) {
      return { ok: false, reason: 'sender_mismatch' };
    }
    // Native value must be a valid non-negative integer; for ERC-20 bridges it must
    // match the expected value (0 unless the route explicitly requires otherwise).
    if (tr.value != null && String(tr.value) !== '') {
      var v = String(tr.value);
      if (!/^[0-9]+$/.test(v) && !/^0x[0-9a-fA-F]+$/.test(v)) return { ok: false, reason: 'invalid_value' };
      try { if (BigInt(v) < 0n) return { ok: false, reason: 'invalid_value' }; } catch (_) { return { ok: false, reason: 'invalid_value' }; }
      if (ctx.value != null && String(ctx.value) !== v) return { ok: false, reason: 'value_mismatch' };
    }
    if (ctx.recipient && action.toAddress && String(action.toAddress).toLowerCase() !== String(ctx.recipient).toLowerCase()) {
      return { ok: false, reason: 'recipient_mismatch' };
    }
    return { ok: true };
  }

  /** Poll the cross-chain status of a broadcast LI.FI transaction. */
  async function getStatus(txHash, opts) {
    opts = opts || {};
    try {
      return await _postJson(STATUS_API, {
        txHash: txHash,
        bridge: opts.bridge || null,
        fromChain: opts.fromChainId || null,
        toChain: opts.toChainId || null,
      });
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  window.LiFiAdapter = {
    isAvailable: isAvailable,
    getQuote: getQuote,
    validateRoute: validateRoute,
    getStatus: getStatus,
    version: '1.0.0',
  };
})();
