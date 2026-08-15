/**
 * Elligentt Authoritative Pool Indexer (Phase 5).
 * =============================================================================
 * A dedicated on-chain event indexing layer for pool analytics. It scans block
 * ranges in safe chunks, decodes Swap/Mint/Burn logs, deduplicates by
 * (transactionHash + logIndex), and maintains an indexing cursor so it can
 * resume / backfill / incrementally update without rescanning history.
 *
 * Financial event amounts are stored as raw BigInt — never converted to Number.
 * This module is a pure orchestrator over the blockchain; it performs NO pool
 * math. PoolEngine remains the financial source of truth.
 *
 * Attached to: window.PoolIndexer
 */
(function () {
  'use strict';

  var EVENT_TYPES = { SWAP: 'Swap', MINT: 'Mint', BURN: 'Burn' };

  function toBig(v) {
    if (typeof v === 'bigint') return v;
    if (v == null) return 0n;
    var s = String(v).trim();
    if (/^-?\d+$/.test(s)) return BigInt(s);
    return 0n;
  }

  /** Unique identity: transactionHash + logIndex (multiple logs per tx). */
  function eventIdentity(txHash, logIndex) {
    return String(txHash || '') + ':' + String(logIndex ?? 0);
  }

  /** In-memory store (pluggable via opts.store for D1/KV later). */
  function createMemoryStore() {
    var map = {};
    return {
      has: function (key) { return Object.prototype.hasOwnProperty.call(map, key); },
      put: function (key, ev) { map[key] = ev; },
      list: function () { return Object.keys(map).map(function (k) { return map[k]; }); },
      size: function () { return Object.keys(map).length; }
    };
  }

  /**
   * Decode a raw log into a normalized event, or null when the log is not a
   * supported pool event. `iface` is an ethers.Interface carrying the Swap/Mint/
   * Burn event definitions.
   */
  function createDecoder(iface) {
    return function decodeLog(log) {
      if (!log || !log.topics || !log.topics.length) return null;
      var parsed;
      try {
        parsed = iface.parseLog({ topics: log.topics, data: log.data || '0x' });
      } catch (e) {
        return null;
      }
      if (!parsed || !parsed.name) return null;

      var base = {
        chainId: log.chainId || null,
        poolAddress: (log.address || '').toLowerCase(),
        blockNumber: toBig(log.blockNumber),
        blockHash: log.blockHash || null,
        transactionHash: log.transactionHash || '',
        logIndex: Number(log.logIndex != null ? log.logIndex : log.index) || 0,
        timestamp: Number(log.timestamp) || 0,
      };

      if (parsed.name === 'Swap') {
        var a = parsed.args || {};
        return Object.assign({}, base, {
          eventType: EVENT_TYPES.SWAP,
          amount0In: toBig(a.amount0In), amount1In: toBig(a.amount1In),
          amount0Out: toBig(a.amount0Out), amount1Out: toBig(a.amount1Out),
          sender: a.sender || null, to: a.to || null,
        });
      }
      if (parsed.name === 'Mint') {
        var m = parsed.args || {};
        return Object.assign({}, base, {
          eventType: EVENT_TYPES.MINT,
          amount0: toBig(m.amount0), amount1: toBig(m.amount1),
          sender: m.sender || null,
        });
      }
      if (parsed.name === 'Burn') {
        var b = parsed.args || {};
        return Object.assign({}, base, {
          eventType: EVENT_TYPES.BURN,
          amount0: toBig(b.amount0), amount1: toBig(b.amount1),
          sender: b.sender || null, to: b.to || null,
        });
      }
      return null;
    };
  }

  /**
   * createIndexer({ chainId, poolAddress, provider, decode, confirmationDepth,
   *                  chunkSize, store, lastIndexedBlock })
   *   provider           — object with getLogs(filter) (ethers provider).
   *   decode             — function(log) -> normalized event | null.
   *   confirmationDepth  — blocks behind `latest` treated as immutable (default 10).
   *   chunkSize          — max block span per getLogs call (default 2000).
   */
  function createIndexer(opts) {
    opts = opts || {};
    var chainId = opts.chainId;
    var poolAddress = (opts.poolAddress || '').toLowerCase();
    var provider = opts.provider;
    var decode = opts.decode || function () { return null; };
    var confirmationDepth = opts.confirmationDepth != null ? opts.confirmationDepth : 10;
    var chunkSize = opts.chunkSize || 2000;
    var store = opts.store || createMemoryStore();
    var cursor = {
      chainId: chainId,
      poolAddress: poolAddress,
      lastIndexedBlock: opts.lastIndexedBlock || 0,
      status: 'IDLE',
      indexedEvents: 0,
    };

    function normalize(ev) {
      if (!ev) return null;
      ev.chainId = chainId;
      ev.poolAddress = poolAddress;
      ev.key = eventIdentity(ev.transactionHash, ev.logIndex);
      return ev;
    }

    /** Scan a single [from,to] block range and return raw logs. */
    function fetchLogs(from, to) {
      return provider.getLogs({
        address: poolAddress,
        fromBlock: '0x' + from.toString(16),
        toBlock: '0x' + to.toString(16),
      });
    }

    /**
     * Ingest events in [fromBlock, toBlock], chunked safely, deduplicated by
     * (txHash + logIndex). Advances the cursor. Returns a summary.
     */
    async function ingestRange(fromBlock, toBlock) {
      var from = BigInt(fromBlock);
      var to = BigInt(toBlock);
      var indexed = 0, skipped = 0, chunks = 0, errors = 0;
      if (to < from) return { ok: false, reason: 'INVALID_RANGE', indexed: 0, skipped: 0, chunks: 0, errors: 0, lastIndexedBlock: cursor.lastIndexedBlock };

      cursor.status = 'SCANNING';
      var cursorBlock = from;
      while (cursorBlock <= to) {
        var chunkEnd = cursorBlock + BigInt(chunkSize) - 1n;
        if (chunkEnd > to) chunkEnd = to;
        chunks++;
        try {
          var logs = await fetchLogs(cursorBlock, chunkEnd);
          for (var i = 0; i < logs.length; i++) {
            var ev = normalize(decode(logs[i]));
            if (!ev) { skipped++; continue; }
            if (store.has(ev.key)) { skipped++; continue; }
            store.put(ev.key, ev);
            indexed++;
          }
        } catch (e) {
          errors++;
          cursor.status = 'ERROR';
          cursor.error = (e && e.message) || 'RPC_ERROR';
          // Do not advance past the failed chunk; allow retry from cursorBlock.
          break;
        }
        cursorBlock = chunkEnd + 1n;
      }

      cursor.lastIndexedBlock = Number(cursorBlock - 1n);
      cursor.indexedEvents += indexed;
      cursor.status = errors ? 'PARTIAL' : 'COMPLETE';
      return {
        ok: errors === 0,
        indexed: indexed, skipped: skipped, chunks: chunks, errors: errors,
        lastIndexedBlock: cursor.lastIndexedBlock,
        status: cursor.status,
      };
    }

    /** Incrementally index up to (latestBlock - confirmationDepth). */
    async function ingestLatest() {
      var latest = await provider.getBlockNumber();
      var boundary = Number(latest) - confirmationDepth;
      if (boundary < 0) boundary = 0;
      var from = cursor.lastIndexedBlock > 0 ? cursor.lastIndexedBlock + 1 : 0;
      if (boundary < from) return { ok: true, indexed: 0, skipped: 0, chunks: 0, errors: 0, lastIndexedBlock: cursor.lastIndexedBlock, status: cursor.status };
      return ingestRange(from, boundary);
    }

    function getEvents(filter) {
      filter = filter || {};
      var all = store.list();
      return all.filter(function (ev) {
        if (filter.eventType && ev.eventType !== filter.eventType) return false;
        if (filter.fromBlock != null && ev.blockNumber < BigInt(filter.fromBlock)) return false;
        if (filter.toBlock != null && ev.blockNumber > BigInt(filter.toBlock)) return false;
        return true;
      });
    }

    /**
     * Token-denominated volume in [now - periodSeconds, now] for the pool's
     * `token0`/`token1` amounts (raw BigInt, not Number). `token0`/`token1` are
     * metadata labels only — no pricing is performed here.
     */
    function computeTokenVolume(periodSeconds, nowMs) {
      var now = nowMs != null ? nowMs : Date.now();
      var cutoff = now - (periodSeconds * 1000);
      var swaps = getEvents({ eventType: EVENT_TYPES.SWAP });
      var in0 = 0n, in1 = 0n;
      for (var i = 0; i < swaps.length; i++) {
        var s = swaps[i];
        if (s.timestamp <= 0 || s.timestamp * 1000 < cutoff) continue;
        in0 += s.amount0In || 0n;
        in1 += s.amount1In || 0n;
      }
      return { periodSeconds: periodSeconds, amount0InRaw: in0, amount1InRaw: in1, swapCount: swaps.length, status: 'COMPLETE' };
    }

    /**
     * Aggregated volume with optional USD valuation. `priceFn(symbol)` returns a
     * USD price or null. When no trustworthy price exists, usd values are null
     * (never a fabricated 0). Token volumes are always raw BigInt.
     */
    function computeVolume(periodSeconds, opts2) {
      opts2 = opts2 || {};
      var nowMs = opts2.now != null ? opts2.now : Date.now();
      var t = computeTokenVolume(periodSeconds, nowMs);
      var priceFn = opts2.priceFn || null;
      var usdVolume = null;
      if (priceFn) {
        var p0 = priceFn(opts2.token0Symbol), p1 = priceFn(opts2.token1Symbol);
        var dec0 = opts2.token0Decimals || 18, dec1 = opts2.token1Decimals || 18;
        var h0 = t.amount0InRaw / (10n ** BigInt(dec0));
        var h1 = t.amount1InRaw / (10n ** BigInt(dec1));
        if (p0 != null && p1 != null) {
          usdVolume = Number(h0) * p0 + Number(h1) * p1;
        }
      }
      return {
        periodSeconds: periodSeconds,
        amount0InRaw: t.amount0InRaw,
        amount1InRaw: t.amount1InRaw,
        usdVolume: usdVolume,
        swapCount: t.swapCount,
        status: t.status,
      };
    }

    function getCursor() { return Object.assign({}, cursor); }

    function reset(fromBlock) {
      cursor.lastIndexedBlock = fromBlock || 0;
      cursor.indexedEvents = 0;
      cursor.status = 'IDLE';
      return Object.assign({}, cursor);
    }

    return {
      EVENT_TYPES: EVENT_TYPES,
      ingestRange: ingestRange,
      ingestLatest: ingestLatest,
      getEvents: getEvents,
      computeVolume: computeVolume,
      getCursor: getCursor,
      reset: reset,
      eventIdentity: eventIdentity,
    };
  }

  window.PoolIndexer = {
    VERSION: '1.0.0',
    EVENT_TYPES: EVENT_TYPES,
    createIndexer: createIndexer,
    createDecoder: createDecoder,
    createMemoryStore: createMemoryStore,
    eventIdentity: eventIdentity,
  };
})();
