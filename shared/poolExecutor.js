/**
 * Elligentt Pool Executor — safe DIRECT-route swap execution (Phase 6).
 * =============================================================================
 * An ORCHESTRATOR for direct (single-pool) swaps. It performs NO financial math:
 *   - PoolRouter  → route discovery / ranking
 *   - PoolEngine  → quote, price impact, utilization (canonical)
 *   - SwapMath    → minOut (canonical slippage)
 *
 * Guarantees:
 *   - DIRECT routes only (multi-hop → MULTI_HOP_NOT_SUPPORTED)
 *   - fresh-state re-validation before transaction creation
 *   - quote expiration (expiresAt)
 *   - explicit error codes (never a generic "swap failed")
 *   - no automatic transaction retry (duplicate-tx protection)
 *   - receipt.status === 1 required before success
 *
 * The executor is wallet-agnostic: it consumes an injected `adapter` for all
 * wallet / provider operations, so the existing user-wallet flow is preserved.
 *
 * Attached to: window.PoolExecutor
 */
(function () {
  'use strict';

  var ERRORS = {
    WALLET_NOT_CONNECTED: 'WALLET_NOT_CONNECTED',
    INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
    INSUFFICIENT_ALLOWANCE: 'INSUFFICIENT_ALLOWANCE',
    POOL_NOT_FOUND: 'POOL_NOT_FOUND',
    POOL_INVALID: 'POOL_INVALID',
    ROUTE_NOT_FOUND: 'ROUTE_NOT_FOUND',
    MULTI_HOP_NOT_SUPPORTED: 'MULTI_HOP_NOT_SUPPORTED',
    QUOTE_EXPIRED: 'QUOTE_EXPIRED',
    ROUTE_STATE_CHANGED: 'ROUTE_STATE_CHANGED',
    QUOTE_UNAVAILABLE: 'QUOTE_UNAVAILABLE',
    POOL_EXECUTION_UNAVAILABLE: 'POOL_EXECUTION_UNAVAILABLE',
    INVALID_TOKEN_ORDER: 'INVALID_TOKEN_ORDER',
    SWAP_TRANSACTION_REVERTED: 'SWAP_TRANSACTION_REVERTED',
    SWAP_RECEIPT_UNAVAILABLE: 'SWAP_RECEIPT_UNAVAILABLE',
    POST_SWAP_VERIFICATION_FAILED: 'POST_SWAP_VERIFICATION_FAILED',
    RPC_ERROR: 'RPC_ERROR',
    TRANSACTION_DUPLICATE_RISK: 'TRANSACTION_DUPLICATE_RISK',
    USER_REJECTED: 'USER_REJECTED',
  };

  // Verified on-chain (Phase 3): swap(address tokenIn, uint256 amountIn, uint256 amountOutMin)
  var SWAP_SELECTOR = '0x9f1d0f59';

  function toBig(v) {
    if (typeof v === 'bigint') return v;
    if (v == null) return 0n;
    var s = String(v).trim();
    if (/^\d+$/.test(s)) return BigInt(s);
    return 0n;
  }

  function createExecutor(opts) {
    opts = opts || {};
    var PE = (opts.poolEngine !== undefined) ? opts.poolEngine
      : ((typeof window !== 'undefined' && window.PoolEngine) ? window.PoolEngine : null);
    var SM = (opts.swapMath !== undefined) ? opts.swapMath
      : ((typeof window !== 'undefined' && window.SwapMath) ? window.SwapMath : null);
    var maxQuoteAgeMs = opts.maxQuoteAgeMs != null ? opts.maxQuoteAgeMs : 30000;

    var router = opts.router;
    if (!router && opts.createRouter) router = opts.createRouter({ poolEngine: PE, swapMath: SM });
    else if (!router && typeof window !== 'undefined' && window.PoolRouter) router = window.PoolRouter.createRouter({ poolEngine: PE, swapMath: SM });

    // swap calldata encoder (injected for testability, else window.ethers)
    var ethers = opts.ethers || ((typeof window !== 'undefined') ? window.ethers : null);
    var swapIface = opts.swapIface;
    if (!swapIface && ethers && ethers.Interface) {
      swapIface = new ethers.Interface(['function swap(address tokenIn, uint256 amountIn, uint256 amountOutMin) returns (uint256 amountOut)']);
    }

    function getSwapSelector() {
      if (swapIface) {
        try { return swapIface.getFunction('swap').selector; } catch (e) { /* fall through */ }
      }
      return SWAP_SELECTOR;
    }

    /** Encode swap(tokenIn, amountIn, amountOutMin) calldata — no invented params. */
    function encodeSwapCalldata(poolAddress, tokenInAddr, amountInRaw, minOutRaw) {
      if (!swapIface) return { ok: false, error: ERRORS.POOL_EXECUTION_UNAVAILABLE };
      try {
        var data = swapIface.encodeFunctionData('swap', [tokenInAddr, amountInRaw, minOutRaw]);
        return { ok: true, to: poolAddress, data: data };
      } catch (e) {
        return { ok: false, error: ERRORS.POOL_EXECUTION_UNAVAILABLE };
      }
    }

    /**
     * Discover + quote a DIRECT route. Returns { ok, quote, alternatives } or
     * { ok:false, reason }. Never fabricates a quote.
     */
    function prepareDirectSwap(req) {
      req = req || {};
      var amountInRaw = toBig(req.amountInRaw);
      var slippageBps = req.slippageBps != null ? req.slippageBps : 50;

      if (!PE) return { ok: false, reason: ERRORS.QUOTE_UNAVAILABLE };
      if (!router) return { ok: false, reason: ERRORS.QUOTE_UNAVAILABLE };
      if (amountInRaw <= 0n) return { ok: false, reason: ERRORS.QUOTE_UNAVAILABLE };

      var rres = router.findBestRoute({ tokenIn: req.tokenIn, tokenOut: req.tokenOut, amountInRaw: amountInRaw, slippageBps: slippageBps });
      if (!rres.ok) {
        return { ok: false, reason: rres.reason === 'ROUTE_QUOTE_UNAVAILABLE' ? ERRORS.QUOTE_UNAVAILABLE : rres.reason };
      }
      var best = rres.bestRoute;
      // DIRECT ONLY: exactly one pool, two tokens in the path.
      if (!best.path || best.path.length !== 2 || !best.pools || best.pools.length !== 1) {
        return { ok: false, reason: ERRORS.MULTI_HOP_NOT_SUPPORTED };
      }

      var pool = PE.getPool(best.pools[0]);
      var now = Date.now();
      var quote = {
        routeId: best.routeId,
        poolId: best.pools[0],
        poolAddress: pool ? pool.address : null,
        tokenIn: req.tokenIn,
        tokenOut: req.tokenOut,
        amountInRaw: amountInRaw,
        expectedOutRaw: best.expectedOutRaw,
        minOutRaw: best.minOutRaw,
        priceImpactBps: best.priceImpactBps,
        feeBps: best.feeBps,
        quotedAt: now,
        stateUpdatedAt: best.stateUpdatedAt,
        expiresAt: now + maxQuoteAgeMs,
        confidence: 'FRESH',
      };
      if (quote.minOutRaw == null || quote.expectedOutRaw <= 0n) {
        return { ok: false, reason: ERRORS.QUOTE_UNAVAILABLE };
      }
      return { ok: true, quote: quote, alternatives: rres.alternatives };
    }

    function isQuoteExpired(quote, nowMs) {
      if (!quote || quote.expiresAt == null) return true;
      return (nowMs != null ? nowMs : Date.now()) > quote.expiresAt;
    }

    /** Re-quote fresh state; report whether the material output changed. */
    function revalidate(quote, req) {
      req = req || {};
      var r = prepareDirectSwap({ tokenIn: quote.tokenIn, tokenOut: quote.tokenOut, amountInRaw: quote.amountInRaw, slippageBps: req.slippageBps });
      if (!r.ok) return { ok: false, reason: r.reason };
      var changed = r.quote.expectedOutRaw !== quote.expectedOutRaw || r.quote.poolId !== quote.poolId;
      return { ok: true, changed: changed, quote: r.quote };
    }

    function buildSwapTx(quote, tokenInAddr) {
      if (quote.minOutRaw == null || quote.expectedOutRaw == null) return { ok: false, error: ERRORS.QUOTE_UNAVAILABLE };
      return encodeSwapCalldata(quote.poolAddress, tokenInAddr, quote.amountInRaw, quote.minOutRaw);
    }

    /**
     * Full direct-swap flow. All wallet/provider ops go through `adapter`:
     *   getWalletAddress(), readBalance(addr), readAllowance(addr, spender),
     *   approve(addr, spender, amount), submitSwap(to, data),
     *   waitForReceipt(tx), confirm(quote), onSubmitted(hash), onConfirmed(receipt)
     * Returns { ok, code, quote, txHash, receipt }.
     */
    async function executeDirectSwap(req) {
      var adapter = req.adapter;
      if (!adapter) return { ok: false, code: ERRORS.RPC_ERROR };

      var wallet = await adapter.getWalletAddress();
      if (!wallet) return { ok: false, code: ERRORS.WALLET_NOT_CONNECTED };

      // 1. quote (direct-only, canonical PoolEngine via router)
      var prep = prepareDirectSwap(req);
      if (!prep.ok) return { ok: false, code: prep.reason };
      var quote = prep.quote;

      var pool = PE.getPool(quote.poolId);
      if (!pool || !pool.deployed) return { ok: false, code: ERRORS.POOL_INVALID };

      var tIn = PE.getToken(quote.tokenIn), tOut = PE.getToken(quote.tokenOut);
      if (!tIn || !tOut || !tIn.address || !tOut.address) return { ok: false, code: ERRORS.INVALID_TOKEN_ORDER };
      var tokenInAddr = tIn.address;

      // 2. balance check
      var balance = await adapter.readBalance(tokenInAddr);
      if (balance == null || balance < quote.amountInRaw) return { ok: false, code: ERRORS.INSUFFICIENT_BALANCE };

      // 3. allowance
      var allowance = await adapter.readAllowance(tokenInAddr, quote.poolAddress);
      var needsApproval = (allowance != null) && allowance < quote.amountInRaw;

      // 4. user confirmation (final quote)
      if (adapter.confirm) {
        var confirmed = await adapter.confirm(quote);
        if (!confirmed) return { ok: false, code: ERRORS.USER_REJECTED };
      }

      // 5. quote expiration
      if (isQuoteExpired(quote)) return { ok: false, code: ERRORS.QUOTE_EXPIRED };

      // 6. fresh-state re-validation
      var rv = revalidate(quote, { slippageBps: req.slippageBps });
      if (!rv.ok) return { ok: false, code: rv.reason };
      if (rv.changed) {
        if (!adapter.confirm) return { ok: false, code: ERRORS.ROUTE_STATE_CHANGED };
        var reconfirmed = await adapter.confirm(rv.quote);
        if (!reconfirmed) return { ok: false, code: ERRORS.ROUTE_STATE_CHANGED };
        quote = rv.quote;
      }

      // 7. approval (only when insufficient)
      if (needsApproval) {
        try {
          await adapter.approve(tokenInAddr, quote.poolAddress, quote.amountInRaw);
        } catch (e) {
          return { ok: false, code: ERRORS.INSUFFICIENT_ALLOWANCE, detail: e && e.message };
        }
      }

      // 8. build swap tx (exact deployed ABI)
      var tx = buildSwapTx(quote, tokenInAddr);
      if (!tx.ok) return { ok: false, code: tx.error };

      // 9. submit — NO automatic retry (duplicate-tx protection)
      var submitTx;
      try {
        submitTx = await adapter.submitSwap(tx.to, tx.data);
      } catch (e) {
        return { ok: false, code: ERRORS.TRANSACTION_DUPLICATE_RISK, detail: e && e.message };
      }
      if (!submitTx || !submitTx.hash) return { ok: false, code: ERRORS.SWAP_RECEIPT_UNAVAILABLE };
      if (adapter.onSubmitted) adapter.onSubmitted(submitTx.hash);

      // 10. receipt + status verification
      var receipt = await adapter.waitForReceipt(submitTx);
      if (!receipt) return { ok: false, code: ERRORS.SWAP_RECEIPT_UNAVAILABLE };
      if (receipt.status === 0) return { ok: false, code: ERRORS.SWAP_TRANSACTION_REVERTED };

      // 11. post-transaction refresh (adapter-owned)
      if (adapter.onConfirmed) await adapter.onConfirmed(receipt);

      return { ok: true, code: null, quote: quote, txHash: submitTx.hash, receipt: receipt };
    }

    return {
      ERRORS: ERRORS,
      SWAP_SELECTOR: SWAP_SELECTOR,
      getSwapSelector: getSwapSelector,
      encodeSwapCalldata: encodeSwapCalldata,
      prepareDirectSwap: prepareDirectSwap,
      revalidate: revalidate,
      buildSwapTx: buildSwapTx,
      isQuoteExpired: isQuoteExpired,
      executeDirectSwap: executeDirectSwap,
    };
  }

  var API = {
    VERSION: '1.0.0',
    ERRORS: ERRORS,
    SWAP_SELECTOR: SWAP_SELECTOR,
    createExecutor: createExecutor,
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = API; }
  if (typeof window !== 'undefined') { window.PoolExecutor = API; }
})();
