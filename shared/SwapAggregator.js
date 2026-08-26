/**
 * SwapAggregator — orchestrator that compares Tower + local pools and selects
 * the best execution for the user.
 * ═══════════════════════════════════════════════════════════════════════
 * Both sources are quoted INDEPENDENTLY (in parallel). A rejection/timeout in
 * one source never breaks the other. The best quote is chosen deterministically:
 *
 *   1. primary  — highest expectedOutRaw (net token output)
 *   2. tiebreak — highest minOutRaw (safest floor)
 *   3. tiebreak — lowest feeBps
 *
 * Gas is intentionally NOT factored in (no reliable estimate exists for the
 * local path); this is documented, not guessed. Only verified data is used.
 *
 * Attached to window.SwapAggregator
 */
(function () {
  'use strict';

  if (typeof window !== 'undefined' && window.SwapAggregator) return;

  function positiveBig(v) {
    try { return typeof v === 'bigint' && v > 0n; } catch (_) { return false; }
  }

  /**
   * Wrap a quote promise so it settles (never hangs) after `ms`, returning the
   * fallback. A slow source is isolated: it cannot block the other source beyond
   * the timeout.
   */
  function withTimeout(promise, ms, fallback) {
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        resolve(fallback);
      }, ms);
      promise.then(function (v) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      }, function (e) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(Object.assign({}, fallback, { error: (e && e.message) || 'QUOTE_REJECTED' }));
      });
    });
  }

  /**
   * Deterministic best-quote selection from a list of normalized quotes.
   * @param {Array<object>} quotes normalized quotes (source, ok, expectedOutRaw, minOutRaw, ...)
   * @returns {{ok:boolean, best?:object, alternatives?:object[], reason?:string, quotes:object[]}}
   */
  function pickBest(quotes) {
    quotes = quotes || [];
    var valid = [];
    for (var i = 0; i < quotes.length; i++) {
      var q = quotes[i];
      if (!q || q.ok !== true) continue;
      if (!positiveBig(q.expectedOutRaw)) continue;
      if (!positiveBig(q.minOutRaw)) continue;
      valid.push(q);
    }

    if (valid.length === 0) {
      return { ok: false, reason: 'NO_ROUTE_AVAILABLE', quotes: quotes.slice() };
    }

    valid.sort(function (a, b) {
      if (a.expectedOutRaw !== b.expectedOutRaw) return (a.expectedOutRaw > b.expectedOutRaw) ? -1 : 1;
      if (a.minOutRaw !== b.minOutRaw) return (a.minOutRaw > b.minOutRaw) ? -1 : 1;
      return ((a.feeBps || 0) - (b.feeBps || 0));
    });

    return { ok: true, best: valid[0], alternatives: valid.slice(1), quotes: quotes.slice() };
  }

  /**
   * Validate a quote against the requested parameters. A quote that does not
   * match the request (token/amount/chain) or is stale is rejected.
   */
  function validateAgainst(q, opts) {
    if (!q || q.ok !== true) return false;
    if (opts.tokenIn && q.tokenIn && String(q.tokenIn) !== String(opts.tokenIn)) return false;
    if (opts.tokenOut && q.tokenOut && String(q.tokenOut) !== String(opts.tokenOut)) return false;
    if (opts.amountInRaw && q.amountInRaw != null && String(q.amountInRaw) !== String(opts.amountInRaw)) return false;
    if (opts.chainId && q.chainId != null && Number(q.chainId) !== Number(opts.chainId)) return false;
    if (q.expiresAt != null && Date.now() > q.expiresAt) return false; // stale
    return true;
  }

  /**
   * Quote Tower + local pools in parallel and select the best route.
   * @param {object} opts { tokenIn, tokenOut, amountInRaw: bigint, slippageBps, userAddress?, chainId? }
   * @returns {Promise<{ok:boolean, best?:object, alternatives?:object[], reason?:string, quotes:object[]}>}
   */
  async function getBestQuote(opts) {
    opts = opts || {};
    var timeoutMs = opts.timeoutMs != null ? Number(opts.timeoutMs) : 8000;

    var towerPromise = (typeof TowerAdapter !== 'undefined' && TowerAdapter.getQuote)
      ? TowerAdapter.getQuote(opts)
      : Promise.resolve({ source: 'tower', ok: false, error: 'TOWER_UNAVAILABLE' });

    var localPromise = (typeof LocalAdapter !== 'undefined' && LocalAdapter.getQuote)
      ? LocalAdapter.getQuote(opts)
      : Promise.resolve({ source: 'local', ok: false, error: 'LOCAL_UNAVAILABLE' });

    // Isolated failures: a slow/rejecting source settles to an error quote after
    // its own timeout, never blocking the other source beyond `timeoutMs`.
    var wrapped = [
      withTimeout(towerPromise, timeoutMs, { source: 'tower', ok: false, error: 'TIMEOUT' }),
      withTimeout(localPromise, timeoutMs, { source: 'local', ok: false, error: 'TIMEOUT' }),
    ];

    var results = await Promise.allSettled(wrapped);

    var quotes = results.map(function (r) {
      if (r.status === 'fulfilled') return r.value;
      return { source: 'unknown', ok: false, error: 'QUOTE_REJECTED' };
    });

    // Reject quotes that do not match the request (amount/token/chain/expiry).
    for (var i = 0; i < quotes.length; i++) {
      var q = quotes[i];
      if (q && q.ok === true && !validateAgainst(q, opts)) {
        quotes[i] = Object.assign({}, q, { ok: false, error: 'QUOTE_MISMATCH' });
      }
    }

    var decision = pickBest(quotes);
    decision.quotes = quotes;
    return decision;
  }

  window.SwapAggregator = {
    getBestQuote: getBestQuote,
    pickBest: pickBest,
    version: '1.0.0',
  };
})();
