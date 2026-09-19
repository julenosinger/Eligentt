/**
 * Elligentt Pool Executor — safe DIRECT-route swap execution (Phase 6.1).
 * =============================================================================
 * An ORCHESTRATOR for direct (single-pool) swaps. Performs NO financial math:
 *   PoolRouter → route discovery/ranking
 *   PoolEngine → quote / price impact / utilization (canonical)
 *   SwapMath   → minOut (canonical slippage)
 *
 * Phase 6.1 hardening guarantees:
 *   - FINAL quote is produced (after a fresh state refresh) BEFORE user confirms
 *   - a lightweight FINAL pre-submit guard re-validates wallet/chain/pool/token/
 *     amount/quote-expiry/state/allowance/balance WITHOUT silently modifying the
 *     user-confirmed parameters (material change → ROUTE_STATE_CHANGED abort)
 *   - balance + allowance are re-read immediately before approval/submission
 *   - approval receipt requires status === 1, then allowance is re-read
 *   - swap receipt requires status === 1
 *   - no automatic transaction retry (duplicate-tx protection; unknown state is
 *     surfaced as TRANSACTION_STATUS_UNKNOWN, never blindly re-submitted)
 *   - post-swap balance delta + actual Swap-event output are captured (BigInt);
 *     actual output is never inferred from the stale quote
 *
 * Wallet-agnostic: consumes an injected `adapter` for all wallet/provider ops.
 *
 * Attached to: window.PoolExecutor
 */
(function () {
  'use strict';

  var ERRORS = {
    WALLET_NOT_CONNECTED: 'WALLET_NOT_CONNECTED',
    WRONG_NETWORK: 'WRONG_NETWORK',
    WALLET_CHANGED: 'WALLET_CHANGED',
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
    APPROVAL_TRANSACTION_REVERTED: 'APPROVAL_TRANSACTION_REVERTED',
    APPROVAL_INSUFFICIENT: 'APPROVAL_INSUFFICIENT',
    SWAP_TRANSACTION_REVERTED: 'SWAP_TRANSACTION_REVERTED',
    SWAP_RECEIPT_UNAVAILABLE: 'SWAP_RECEIPT_UNAVAILABLE',
    TRANSACTION_STATUS_UNKNOWN: 'TRANSACTION_STATUS_UNKNOWN',
    POST_SWAP_VERIFICATION_FAILED: 'POST_SWAP_VERIFICATION_FAILED',
    POST_SWAP_OUTPUT_UNAVAILABLE: 'POST_SWAP_OUTPUT_UNAVAILABLE',
    RPC_ERROR: 'RPC_ERROR',
    USER_REJECTED: 'USER_REJECTED',
  };

  var STATES = {
    IDLE: 'IDLE', QUOTING: 'QUOTING', READY: 'READY', CONFIRMING: 'CONFIRMING',
    APPROVING: 'APPROVING', APPROVAL_CONFIRMING: 'APPROVAL_CONFIRMING',
    SWAPPING: 'SWAPPING', SWAP_CONFIRMING: 'SWAP_CONFIRMING',
    VERIFYING: 'VERIFYING', SUCCESS: 'SUCCESS', FAILED: 'FAILED', UNKNOWN: 'UNKNOWN',
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

    var ethers = opts.ethers || ((typeof window !== 'undefined') ? window.ethers : null);
    var swapIface = opts.swapIface;
    if (!swapIface && ethers && ethers.Interface) {
      swapIface = new ethers.Interface(['function swap(address tokenIn, uint256 amountIn, uint256 amountOutMin) returns (uint256 amountOut)']);
    }

    function getSwapSelector() {
      if (swapIface) { try { return swapIface.getFunction('swap').selector; } catch (e) { /* fall through */ } }
      return SWAP_SELECTOR;
    }

    function encodeSwapCalldata(poolAddress, tokenInAddr, amountInRaw, minOutRaw) {
      if (!swapIface) return { ok: false, error: ERRORS.POOL_EXECUTION_UNAVAILABLE };
      try {
        return { ok: true, to: poolAddress, data: swapIface.encodeFunctionData('swap', [tokenInAddr, amountInRaw, minOutRaw]) };
      } catch (e) { return { ok: false, error: ERRORS.POOL_EXECUTION_UNAVAILABLE }; }
    }

    /** Discover + quote a DIRECT route. Returns { ok, quote, alternatives } | { ok:false, reason }. */
    function prepareDirectSwap(req) {
      req = req || {};
      var amountInRaw = toBig(req.amountInRaw);
      var slippageBps = req.slippageBps != null ? req.slippageBps : 50;
      if (!PE || !router) return { ok: false, reason: ERRORS.QUOTE_UNAVAILABLE };
      if (amountInRaw <= 0n) return { ok: false, reason: ERRORS.QUOTE_UNAVAILABLE };

      var rres = router.findBestRoute({ tokenIn: req.tokenIn, tokenOut: req.tokenOut, amountInRaw: amountInRaw, slippageBps: slippageBps });
      if (!rres.ok) return { ok: false, reason: rres.reason === 'ROUTE_QUOTE_UNAVAILABLE' ? ERRORS.QUOTE_UNAVAILABLE : rres.reason };
      var best = rres.bestRoute;
      if (!best.path || best.path.length !== 2 || !best.pools || best.pools.length !== 1) {
        return { ok: false, reason: ERRORS.MULTI_HOP_NOT_SUPPORTED };
      }
      var pool = PE.getPool(best.pools[0]);
      var now = Date.now();
      var quote = {
        routeId: best.routeId, poolId: best.pools[0],
        poolAddress: pool ? pool.address : null,
        tokenIn: req.tokenIn, tokenOut: req.tokenOut,
        amountInRaw: amountInRaw, expectedOutRaw: best.expectedOutRaw, minOutRaw: best.minOutRaw,
        priceImpactBps: best.priceImpactBps, feeBps: best.feeBps,
        quotedAt: now, stateUpdatedAt: best.stateUpdatedAt,
        expiresAt: now + maxQuoteAgeMs, confidence: 'FRESH',
      };
      if (quote.minOutRaw == null || quote.expectedOutRaw <= 0n) return { ok: false, reason: ERRORS.QUOTE_UNAVAILABLE };
      return { ok: true, quote: quote, alternatives: rres.alternatives };
    }

    function isQuoteExpired(quote, nowMs) {
      if (!quote || quote.expiresAt == null) return true;
      return (nowMs != null ? nowMs : Date.now()) > quote.expiresAt;
    }

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

    /** Extract the actual Swap/Swapped event from a receipt. */
    function extractSwapEvent(receipt, iface, swappedIface) {
      if (!receipt || !iface || !Array.isArray(receipt.logs)) return null;
      var swapTopic = null, swappedTopic = null;
      try { swapTopic = iface.getEvent('Swap').topicHash; } catch (e) {}
      if (swappedIface) { try { swappedTopic = swappedIface.getEvent('Swapped').topicHash; } catch (e) {} }
      for (var i = 0; i < receipt.logs.length; i++) {
        var log = receipt.logs[i];
        if (!log || !log.topics) continue;
        if (swapTopic && log.topics.indexOf(swapTopic) !== -1) {
          try {
            var a = iface.parseLog(log).args || {};
            var in0 = toBig(a.amount0In), in1 = toBig(a.amount1In);
            var out0 = toBig(a.amount0Out), out1 = toBig(a.amount1Out);
            return { amountInRaw: in0 > 0n ? in0 : in1, amountOutRaw: out0 > 0n ? out0 : out1, tokenInIsToken0: in0 > 0n, eventType: 'Swap', user: a.sender || a.to || null };
          } catch (e) {}
        }
        if (swappedTopic && log.topics.indexOf(swappedTopic) !== -1) {
          try {
            var b = swappedIface.parseLog(log).args || {};
            return { amountInRaw: toBig(b.amountIn), amountOutRaw: toBig(b.amountOut), tokenInIsToken0: null, eventType: 'Swapped', user: b.user || null };
          } catch (e) {}
        }
      }
      return null;
    }

    async function executeDirectSwap(req) {
      var adapter = req.adapter;
      if (!adapter) return { ok: false, code: ERRORS.RPC_ERROR };
      var state = STATES.IDLE;
      function setState(s) { state = s; if (adapter.onStateChange) { try { adapter.onStateChange(s); } catch (e) {} } }

      // 1. wallet
      var wallet = await adapter.getWalletAddress();
      if (!wallet) { setState(STATES.FAILED); return { ok: false, code: ERRORS.WALLET_NOT_CONNECTED }; }

      // 2. chain
      var chainId = adapter.getChainId ? await adapter.getChainId() : null;
      if (req.expectedChainId != null && chainId !== req.expectedChainId) {
        setState(STATES.FAILED); return { ok: false, code: ERRORS.WRONG_NETWORK };
      }

      // 3. initial quote
      setState(STATES.QUOTING);
      var prep = prepareDirectSwap(req);
      if (!prep.ok) { setState(STATES.FAILED); return { ok: false, code: prep.reason }; }
      var pool = PE.getPool(prep.quote.poolId);
      if (!pool || !pool.deployed) { setState(STATES.FAILED); return { ok: false, code: ERRORS.POOL_INVALID }; }

      var tIn = PE.getToken(prep.quote.tokenIn), tOut = PE.getToken(prep.quote.tokenOut);
      if (!tIn || !tOut || !tIn.address || !tOut.address) { setState(STATES.FAILED); return { ok: false, code: ERRORS.INVALID_TOKEN_ORDER }; }
      if (prep.quote.tokenIn !== pool.tokenA && prep.quote.tokenIn !== pool.tokenB) { setState(STATES.FAILED); return { ok: false, code: ERRORS.INVALID_TOKEN_ORDER }; }
      var tokenInAddr = tIn.address;

      // 4. fresh state refresh (adapter-owned)
      if (adapter.refreshState) { await adapter.refreshState(prep.quote.poolId); }

      // 5. FINAL quote — the freshest available quote, produced BEFORE confirmation
      var final = prepareDirectSwap({ tokenIn: req.tokenIn, tokenOut: req.tokenOut, amountInRaw: prep.quote.amountInRaw, slippageBps: req.slippageBps });
      if (!final.ok) { setState(STATES.FAILED); return { ok: false, code: final.reason }; }
      var quote = final.quote;

      // immutable confirmed parameters
      var confirmed = {
        wallet: wallet, chainId: chainId, poolId: quote.poolId, poolAddress: quote.poolAddress,
        tokenIn: quote.tokenIn, tokenOut: quote.tokenOut, amountInRaw: quote.amountInRaw,
        expectedOutRaw: quote.expectedOutRaw, minOutRaw: quote.minOutRaw, slippageBps: req.slippageBps,
        quotedAt: quote.quotedAt, expiresAt: quote.expiresAt,
      };

      // 6. USER confirms the FINAL quote
      setState(STATES.READY);
      if (adapter.confirm) {
        setState(STATES.CONFIRMING);
        var c = await adapter.confirm(quote);
        if (!c) { setState(STATES.FAILED); return { ok: false, code: ERRORS.USER_REJECTED }; }
      }

      // 7. FINAL pre-submit guard — validate WITHOUT modifying confirmed params
      var guard = await preSubmitGuard(adapter, confirmed, req);
      if (!guard.ok) { setState(STATES.FAILED); return { ok: false, code: guard.code }; }

      // capture pre-swap balances for delta verification (BigInt)
      var beforeIn = await adapter.readBalance(tokenInAddr);
      var beforeOut = await adapter.readBalance(tOut.address);

      // 8. approval (only when insufficient), with receipt + re-read
      if (guard.needsApproval) {
        setState(STATES.APPROVING);
        var appTx = await adapter.approve(tokenInAddr, confirmed.poolAddress, confirmed.amountInRaw);
        if (adapter.waitForReceipt) {
          setState(STATES.APPROVAL_CONFIRMING);
          var appReceipt = await adapter.waitForReceipt(appTx);
          if (!appReceipt || appReceipt.status !== 1) { setState(STATES.FAILED); return { ok: false, code: ERRORS.APPROVAL_TRANSACTION_REVERTED }; }
        }
        var allowance2 = await adapter.readAllowance(tokenInAddr, confirmed.poolAddress);
        if (allowance2 == null || allowance2 < confirmed.amountInRaw) { setState(STATES.FAILED); return { ok: false, code: ERRORS.APPROVAL_INSUFFICIENT }; }
      }

      // 9. build swap tx (exact deployed ABI)
      var tx = buildSwapTx(quote, tokenInAddr);
      if (!tx.ok) { setState(STATES.FAILED); return { ok: false, code: tx.error }; }

      // 10. submit — NO automatic retry
      setState(STATES.SWAPPING);
      var submitTx;
      try {
        submitTx = await adapter.submitSwap(tx.to, tx.data);
      } catch (e) {
        setState(STATES.UNKNOWN);
        return { ok: false, code: ERRORS.TRANSACTION_STATUS_UNKNOWN, detail: e && e.message };
      }
      if (!submitTx || !submitTx.hash) { setState(STATES.UNKNOWN); return { ok: false, code: ERRORS.SWAP_RECEIPT_UNAVAILABLE }; }
      if (adapter.onSubmitted) adapter.onSubmitted(submitTx.hash);

      // 11. receipt (strict status === 1)
      setState(STATES.SWAP_CONFIRMING);
      var receipt = await adapter.waitForReceipt(submitTx);
      if (!receipt) { setState(STATES.FAILED); return { ok: false, code: ERRORS.SWAP_RECEIPT_UNAVAILABLE }; }
      if (receipt.status !== 1) { setState(STATES.FAILED); return { ok: false, code: ERRORS.SWAP_TRANSACTION_REVERTED }; }

      // 12. post-swap verification (balance delta + actual event output)
      setState(STATES.VERIFYING);
      var afterIn = await adapter.readBalance(tokenInAddr);
      var afterOut = await adapter.readBalance(tOut.address);
      var deltaIn = (beforeIn != null && afterIn != null) ? beforeIn - afterIn : null;
      var deltaOut = (afterOut != null && beforeOut != null) ? afterOut - beforeOut : null;
      var actualEvent = (adapter.getSwapEvent) ? await adapter.getSwapEvent(receipt, confirmed.poolAddress) : null;
      var postSwap = {
        beforeIn: beforeIn, afterIn: afterIn, deltaInRaw: deltaIn,
        beforeOut: beforeOut, afterOut: afterOut, deltaOutRaw: deltaOut,
        actual: actualEvent, // { amountInRaw, amountOutRaw, tokenInIsToken0 } | null
      };

      if (adapter.onConfirmed) await adapter.onConfirmed(receipt, postSwap);

      setState(STATES.SUCCESS);
      return { ok: true, code: null, quote: quote, txHash: submitTx.hash, receipt: receipt, postSwap: postSwap };
    }

    /** Final pre-submit guard — read fresh state, validate, ABORT on material change. */
    async function preSubmitGuard(adapter, confirmed, req) {
      // wallet unchanged
      var walletNow = await adapter.getWalletAddress();
      if (walletNow !== confirmed.wallet) return { ok: false, code: ERRORS.WALLET_CHANGED };
      // chain unchanged
      if (adapter.getChainId && req.expectedChainId != null) {
        var chainNow = await adapter.getChainId();
        if (chainNow !== req.expectedChainId) return { ok: false, code: ERRORS.WRONG_NETWORK };
      }
      // quote not expired
      if (!confirmed.expiresAt || Date.now() > confirmed.expiresAt) return { ok: false, code: ERRORS.QUOTE_EXPIRED };
      // re-quote current state (fresh) and compare — do NOT substitute
      var rres = router.findBestRoute({ tokenIn: confirmed.tokenIn, tokenOut: confirmed.tokenOut, amountInRaw: confirmed.amountInRaw, slippageBps: confirmed.slippageBps });
      if (!rres.ok || !rres.bestRoute) return { ok: false, code: ERRORS.ROUTE_STATE_CHANGED };
      if (rres.bestRoute.pools[0] !== confirmed.poolId || rres.bestRoute.expectedOutRaw !== confirmed.expectedOutRaw) {
        return { ok: false, code: ERRORS.ROUTE_STATE_CHANGED }; // material change → abort
      }
      // balance re-read
      var tokenInAddr = PE.getToken(confirmed.tokenIn).address;
      var balance = await adapter.readBalance(tokenInAddr);
      if (balance == null || balance < confirmed.amountInRaw) return { ok: false, code: ERRORS.INSUFFICIENT_BALANCE };
      // allowance re-read
      var allowance = await adapter.readAllowance(tokenInAddr, confirmed.poolAddress);
      var needsApproval = (allowance == null) ? false : allowance < confirmed.amountInRaw;
      if (allowance == null) return { ok: false, code: ERRORS.RPC_ERROR };
      return { ok: true, needsApproval: needsApproval };
    }

    return {
      ERRORS: ERRORS, STATES: STATES, SWAP_SELECTOR: SWAP_SELECTOR,
      getSwapSelector: getSwapSelector,
      encodeSwapCalldata: encodeSwapCalldata,
      prepareDirectSwap: prepareDirectSwap,
      revalidate: revalidate,
      buildSwapTx: buildSwapTx,
      isQuoteExpired: isQuoteExpired,
      extractSwapEvent: extractSwapEvent,
      executeDirectSwap: executeDirectSwap,
    };
  }

  var API = {
    VERSION: '1.1.0',
    ERRORS: ERRORS,
    STATES: STATES,
    SWAP_SELECTOR: SWAP_SELECTOR,
    createExecutor: createExecutor,
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = API; }
  if (typeof window !== 'undefined') { window.PoolExecutor = API; }
})();
