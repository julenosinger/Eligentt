/**
 * Elligentt Authoritative Pool Indexer (Phase 5.5 — production hardening).
 * =============================================================================
 * A persistent, recoverable, deterministic on-chain event indexer for pool
 * analytics. It scans block ranges in safe chunks, decodes Swap/Mint/Burn logs,
 * deduplicates by (transactionHash + logIndex), and maintains a durable
 * per-pool cursor that only advances AFTER events are successfully persisted.
 *
 * Properties guaranteed by this module:
 *   - cursor survives restart (persisted via a pluggable async IndexStore)
 *   - failed chunks never advance the cursor (retry-safe, idempotent)
 *   - overlapping / repeated ranges never produce duplicates
 *   - block timestamps come from real blocks (batched + cached), never invented
 *   - events with unknown timestamps are excluded from time-windowed analytics
 *   - financial amounts remain raw BigInt (exact string when serialized)
 *   - analytics are rebuildable from indexed events (no stored derived truth)
 *
 * This module performs NO pool math. PoolEngine remains the financial source
 * of truth. No route execution. No multi-hop.
 *
 * Attached to: window.PoolIndexer
 */
(function () {
  'use strict';

  var EVENT_TYPES = { SWAP: 'Swap', MINT: 'Mint', BURN: 'Burn' };
  var STATUS = { COMPLETE: 'COMPLETE', PARTIAL: 'PARTIAL', UNAVAILABLE: 'UNAVAILABLE', ERROR: 'ERROR' };
  var INDEX_VERSION = 1;

  // Swap event capabilities (Phase 6.2).
  var SWAP_EVENT_TYPE = { STANDARD: 'standard', SWAPPED: 'swapped', NONE: 'none' };

  // Verified topics. Standard Uniswap-V2-style Swap + USDC/EURC Swapped.
  var SWAP_TOPIC = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
  var SWAPPED_TOPIC = '0xa078c4190abe07940190effc1846be0ccf03ad6007bc9e93f9697d0b460befbb';

  /** Detect which swap event a pool emits from its deployed bytecode. */
  function detectSwapEventType(code) {
    if (!code || code === '0x') return SWAP_EVENT_TYPE.NONE;
    var c = code.toLowerCase();
    if (c.indexOf(SWAP_TOPIC.slice(2)) !== -1) return SWAP_EVENT_TYPE.STANDARD;
    if (c.indexOf(SWAPPED_TOPIC.slice(2)) !== -1) return SWAP_EVENT_TYPE.SWAPPED;
    return SWAP_EVENT_TYPE.NONE;
  }

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

  /* ══════════════════════════════════════════════════════════════
     INDEX STORE — async pluggable persistence interface.
     Indexer depends on this interface, not on a specific backend.
     ══════════════════════════════════════════════════════════════ */

  /** In-memory store (async interface) — for tests / non-persistent fallback. */
  function createMemoryStore() {
    var map = {};
    return {
      get: async function (key) { return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null; },
      put: async function (key, value) { map[key] = value; },
      has: async function (key) { return Object.prototype.hasOwnProperty.call(map, key); },
      list: async function (prefix) {
        var out = [];
        for (var k in map) { if (Object.prototype.hasOwnProperty.call(map, k) && (!prefix || k.indexOf(prefix) === 0)) out.push({ key: k, value: map[k] }); }
        return out;
      },
      delete: async function (key) { delete map[key]; },
      size: async function () { return Object.keys(map).length; },
    };
  }

  /**
   * Cloudflare KV store adapter (existing infrastructure). Wraps a KV binding
   * (get/put/list/delete). Values are strings; BigInt amounts are serialized by
   * the indexer before persistence.
   */
  function createKVStore(kv, prefix) {
    prefix = (prefix || 'pool-index').replace(/\/$/, '');
    function k(key) { return prefix + ':' + key; }
    return {
      get: async function (key) { try { return await kv.get(k(key)); } catch (e) { return null; } },
      put: async function (key, value) { try { await kv.put(k(key), String(value)); } catch (e) { throw e; } },
      has: async function (key) { try { return (await kv.get(k(key))) != null; } catch (e) { return false; } },
      list: async function (subPrefix) {
        try {
          var all = [];
          var cursor;
          do {
            var res = await kv.list({ prefix: k(subPrefix || ''), cursor: cursor });
            all = all.concat((res.keys || []).map(function (kk) { return { key: kk.name.substring(prefix.length + 1), value: null }; }));
            cursor = res.list_complete ? undefined : res.cursor;
          } while (cursor);
          return all;
        } catch (e) { return []; }
      },
      delete: async function (key) { try { await kv.delete(k(key)); } catch (e) {} },
    };
  }

  /* ══════════════════════════════════════════════════════════════
     DECODER
     ══════════════════════════════════════════════════════════════ */

  function createDecoder(iface, opts) {
    opts = opts || {};
    var t0 = (opts.token0Address || '').toLowerCase();
    var t1 = (opts.token1Address || '').toLowerCase();
    var s0 = opts.token0Symbol || null;
    var s1 = opts.token1Symbol || null;

    return function decodeLog(log) {
      if (!log || !log.topics || !log.topics.length) return null;
      var parsed;
      try {
        parsed = iface.parseLog({ topics: log.topics, data: log.data || '0x' });
      } catch (e) { return null; }
      if (!parsed || !parsed.name) return null;

      var base = {
        chainId: log.chainId || null,
        poolAddress: (log.address || '').toLowerCase(),
        blockNumber: toBig(log.blockNumber),
        blockHash: log.blockHash || null,
        transactionHash: log.transactionHash || '',
        logIndex: Number(log.logIndex != null ? log.logIndex : log.index) || 0,
        timestamp: null, // resolved separately via getBlock(blockNumber)
      };

      if (parsed.name === 'Swap') {
        var a = parsed.args || {};
        var in0 = toBig(a.amount0In), in1 = toBig(a.amount1In);
        var out0 = toBig(a.amount0Out), out1 = toBig(a.amount1Out);
        return Object.assign({}, base, {
          eventType: EVENT_TYPES.SWAP,
          amount0In: in0, amount1In: in1, amount0Out: out0, amount1Out: out1,
          tokenIn: in0 > 0n ? s0 : s1,
          tokenOut: out0 > 0n ? s0 : s1,
          amountInRaw: in0 > 0n ? in0 : in1,
          amountOutRaw: out0 > 0n ? out0 : out1,
          user: a.sender || a.to || null,
          sender: a.sender || null, to: a.to || null,
        });
      }
      if (parsed.name === 'Swapped') {
        var b = parsed.args || {};
        var tokenInAddr = (b.tokenIn || '').toLowerCase();
        var amtIn = toBig(b.amountIn), amtOut = toBig(b.amountOut);
        var ti, to, a0i = 0n, a1i = 0n, a0o = 0n, a1o = 0n;
        if (t0 && tokenInAddr === t0) { ti = s0; to = s1; a0i = amtIn; a1o = amtOut; }
        else if (t1 && tokenInAddr === t1) { ti = s1; to = s0; a1i = amtIn; a0o = amtOut; }
        else { return null; } // unknown tokenIn — reject
        return Object.assign({}, base, {
          eventType: EVENT_TYPES.SWAP,
          amount0In: a0i, amount1In: a1i, amount0Out: a0o, amount1Out: a1o,
          tokenIn: ti, tokenOut: to,
          amountInRaw: amtIn, amountOutRaw: amtOut,
          user: b.user || null,
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
        var bu = parsed.args || {};
        return Object.assign({}, base, {
          eventType: EVENT_TYPES.BURN,
          amount0: toBig(bu.amount0), amount1: toBig(bu.amount1),
          sender: bu.sender || null, to: bu.to || null,
        });
      }
      return null;
    };
  }

  /* ══════════════════════════════════════════════════════════════
     SERIALIZATION (BigInt → exact string, and back)
     ══════════════════════════════════════════════════════════════ */

  var BIGINT_FIELDS = ['blockNumber', 'amount0In', 'amount1In', 'amount0Out', 'amount1Out', 'amount0', 'amount1', 'amountInRaw', 'amountOutRaw'];

  function serializeEvent(ev) {
    var out = {};
    for (var k in ev) {
      if (Object.prototype.hasOwnProperty.call(ev, k)) {
        var v = ev[k];
        if (typeof v === 'bigint') out[k] = v.toString();
        else out[k] = v;
      }
    }
    return JSON.stringify(out);
  }

  function deserializeEvent(json) {
    var o = JSON.parse(json);
    for (var i = 0; i < BIGINT_FIELDS.length; i++) {
      var f = BIGINT_FIELDS[i];
      if (o[f] != null && typeof o[f] === 'string' && /^-?\d+$/.test(o[f])) o[f] = BigInt(o[f]);
    }
    return o;
  }

  function validateEvent(ev) {
    if (!ev) return false;
    if (!ev.transactionHash || !ev.eventType) return false;
    if (ev.chainId == null) return false;
    if (ev.blockNumber == null || ev.blockNumber < 0n) return false;
    if (ev.poolAddress && !/^0x[a-fA-F0-9]{40}$/.test(ev.poolAddress)) return false;
    return true;
  }

  /* ══════════════════════════════════════════════════════════════
     INDEXER
     ══════════════════════════════════════════════════════════════ */

  function createIndexer(opts) {
    opts = opts || {};
    var chainId = opts.chainId;
    var poolAddress = (opts.poolAddress || '').toLowerCase();
    var provider = opts.provider;
    var decode = opts.decode || function () { return null; };
    var store = opts.store || createMemoryStore();
    var confirmationDepth = opts.confirmationDepth != null ? opts.confirmationDepth : 10;
    var chunkSize = opts.chunkSize || 2000;
    var maxRetries = opts.maxRetries != null ? opts.maxRetries : 3;
    var retryBackoffMs = opts.retryBackoffMs != null ? opts.retryBackoffMs : 500;
    var indexVersion = opts.indexVersion != null ? opts.indexVersion : INDEX_VERSION;

    var cursorKey = opts.cursorKey || ('cursor:' + chainId + ':' + poolAddress);
    var eventPrefix = opts.eventPrefix || ('evt:' + chainId + ':' + poolAddress + ':');

    // In-memory authoritative index (cache). Persisted to `store` async.
    var _events = {};            // eventKey -> normalized event (BigInt)
    var _timestamps = {};        // blockNumber -> timestamp (cache)
    var _inflight = false;       // per-instance concurrency guard

    var cursor = {
      chainId: chainId,
      poolAddress: poolAddress,
      lastIndexedBlock: 0,
      status: 'IDLE',
      lastIndexedAt: 0,
      indexedEvents: 0,
      indexVersion: indexVersion,
    };

    function normalize(ev, chainIdOverride) {
      if (!ev) return null;
      if (chainIdOverride != null) ev.chainId = chainIdOverride;
      if (ev.poolAddress) ev.poolAddress = ev.poolAddress.toLowerCase();
      else ev.poolAddress = poolAddress;
      ev.key = eventIdentity(ev.transactionHash, ev.logIndex);
      return ev;
    }

    function eventStoreKey(ev) { return eventPrefix + ev.transactionHash + ':' + ev.logIndex; }

    async function persistCursor() {
      cursor.lastIndexedAt = Date.now();
      await store.put(cursorKey, JSON.stringify(cursor));
    }

    async function init() {
      var raw = await store.get(cursorKey);
      if (raw) {
        try {
          var saved = JSON.parse(raw);
          if (saved && saved.lastIndexedBlock != null) {
            cursor.lastIndexedBlock = Number(saved.lastIndexedBlock);
            cursor.status = saved.status || 'IDLE';
            cursor.lastIndexedAt = Number(saved.lastIndexedAt) || 0;
            cursor.indexedEvents = Number(saved.indexedEvents) || 0;
            cursor.indexVersion = saved.indexVersion != null ? saved.indexVersion : indexVersion;
          }
        } catch (e) { /* corrupt cursor — start fresh */ }
      }
      // Load persisted events into memory (rebuildable analytics source).
      var entries = await store.list(eventPrefix);
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (!e.key) continue;
        try {
          var loaded = await store.get(e.key);
          if (!loaded) continue;
          var ev = deserializeEvent(loaded);
          if (!validateEvent(ev)) continue;
          _events[ev.key] = ev;
        } catch (err) { /* skip corrupt record */ }
      }
      return Object.assign({}, cursor);
    }

    async function fetchLogsWithRetry(from, to) {
      var lastErr = null;
      for (var attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await provider.getLogs({
            address: poolAddress,
            fromBlock: '0x' + from.toString(16),
            toBlock: '0x' + to.toString(16),
          });
        } catch (e) {
          lastErr = e;
          if (attempt < maxRetries) {
            await new Promise(function (r) { setTimeout(r, retryBackoffMs * Math.pow(2, attempt)); });
          }
        }
      }
      throw lastErr || new Error('RPC_ERROR');
    }

    /** Resolve block timestamps in batch, cached per blockNumber. */
    async function resolveTimestamps(logs) {
      var blocks = {};
      for (var i = 0; i < logs.length; i++) {
        var bn = Number(logs[i].blockNumber);
        if (_timestamps[bn] != null) continue;
        blocks[bn] = true;
      }
      var bns = Object.keys(blocks).map(Number);
      for (var j = 0; j < bns.length; j++) {
        var b = bns[j];
        try {
          var blk = await provider.getBlock(b);
          if (blk && blk.timestamp != null) _timestamps[b] = Number(blk.timestamp);
          else _timestamps[b] = null;
        } catch (e) {
          _timestamps[b] = null; // TIMESTAMP_UNAVAILABLE
        }
      }
    }

    async function ingestRange(fromBlock, toBlock) {
      if (_inflight) return { ok: false, reason: 'INDEXING_IN_PROGRESS', status: cursor.status, lastIndexedBlock: cursor.lastIndexedBlock };
      _inflight = true;
      try {
        var from = BigInt(fromBlock);
        var to = BigInt(toBlock);
        if (to < from) return { ok: false, reason: 'INVALID_RANGE', indexed: 0, skipped: 0, chunks: 0, errors: 0, lastIndexedBlock: cursor.lastIndexedBlock, status: cursor.status };

        cursor.status = 'SCANNING';
        var indexed = 0, skipped = 0, chunks = 0, errors = 0, missingTs = 0;
        var cursorBlock = from;

        while (cursorBlock <= to) {
          var chunkEnd = cursorBlock + BigInt(chunkSize) - 1n;
          if (chunkEnd > to) chunkEnd = to;
          chunks++;
          try {
            var logs = await fetchLogsWithRetry(cursorBlock, chunkEnd);
            await resolveTimestamps(logs);

            // Decode + validate + dedup (against BOTH memory and store).
            var decoded = [];
            for (var i = 0; i < logs.length; i++) {
              var ev = normalize(decode(logs[i]), chainId);
              if (!ev || !validateEvent(ev)) { skipped++; continue; }
              ev.timestamp = _timestamps[Number(ev.blockNumber)] != null ? _timestamps[Number(ev.blockNumber)] : null;
              if (ev.timestamp === null) missingTs++;
              if (_events[ev.key]) { skipped++; continue; }
              if (await store.has(eventStoreKey(ev))) { _events[ev.key] = ev; skipped++; continue; }
              decoded.push(ev);
            }

            // Persist events FIRST (idempotent by unique key), THEN cursor.
            for (var d = 0; d < decoded.length; d++) {
              await store.put(eventStoreKey(decoded[d]), serializeEvent(decoded[d]));
              _events[decoded[d].key] = decoded[d];
              indexed++;
            }

            // Advance cursor only AFTER events persisted.
            cursor.lastIndexedBlock = Number(chunkEnd);
            cursor.indexedEvents += indexed;
            await persistCursor();
          } catch (e) {
            errors++;
            cursor.status = STATUS.ERROR;
            cursor.error = (e && e.message) || 'RPC_ERROR';
            // Do NOT advance the cursor past this failed chunk.
            break;
          }
          cursorBlock = chunkEnd + 1n;
        }

        cursor.status = errors ? STATUS.ERROR : (missingTs ? STATUS.PARTIAL : STATUS.COMPLETE);
        cursor.missingTimestamps = missingTs;
        await persistCursor();
        return {
          ok: errors === 0,
          indexed: indexed, skipped: skipped, chunks: chunks, errors: errors, missingTimestamps: missingTs,
          lastIndexedBlock: cursor.lastIndexedBlock,
          status: cursor.status,
        };
      } finally {
        _inflight = false;
      }
    }

    async function ingestLatest() {
      var latest = await provider.getBlockNumber();
      var boundary = Number(latest) - confirmationDepth;
      if (boundary < 0) boundary = 0;
      var from = cursor.lastIndexedBlock > 0 ? cursor.lastIndexedBlock + 1 : 0;
      if (boundary < from) return { ok: true, indexed: 0, skipped: 0, chunks: 0, errors: 0, missingTimestamps: 0, lastIndexedBlock: cursor.lastIndexedBlock, status: cursor.status };
      return ingestRange(from, boundary);
    }

    /** Deterministic event ordering: blockNumber ASC, logIndex ASC. */
    function getEvents(filter) {
      filter = filter || {};
      var all = Object.keys(_events).map(function (k) { return _events[k]; });
      var out = all.filter(function (ev) {
        if (filter.eventType && ev.eventType !== filter.eventType) return false;
        if (filter.fromBlock != null && ev.blockNumber < BigInt(filter.fromBlock)) return false;
        if (filter.toBlock != null && ev.blockNumber > BigInt(filter.toBlock)) return false;
        return true;
      });
      out.sort(function (a, b) {
        if (a.blockNumber !== b.blockNumber) return (a.blockNumber < b.blockNumber) ? -1 : 1;
        return a.logIndex - b.logIndex;
      });
      return out;
    }

    function computeTokenVolume(periodSeconds, nowMs) {
      var now = nowMs != null ? nowMs : Date.now();
      var cutoff = now - (periodSeconds * 1000);
      var swaps = getEvents({ eventType: EVENT_TYPES.SWAP });
      var in0 = 0n, in1 = 0n, missingTs = 0;
      for (var i = 0; i < swaps.length; i++) {
        var s = swaps[i];
        if (s.timestamp == null) { missingTs++; continue; } // exclude unknown timestamps from windowed analytics
        if (s.timestamp * 1000 < cutoff) continue;
        in0 += s.amount0In || 0n;
        in1 += s.amount1In || 0n;
      }
      return { periodSeconds: periodSeconds, amount0InRaw: in0, amount1InRaw: in1, swapCount: swaps.length, missingTimestamps: missingTs };
    }

    function computeVolume(periodSeconds, opts2) {
      opts2 = opts2 || {};
      var nowMs = opts2.now != null ? opts2.now : Date.now();
      var t = computeTokenVolume(periodSeconds, nowMs);
      var priceFn = opts2.priceFn || null;
      var usdVolume = null;
      if (priceFn) {
        var p0 = priceFn(opts2.token0Symbol), p1 = priceFn(opts2.token1Symbol);
        var dec0 = opts2.token0Decimals || 18, dec1 = opts2.token1Decimals || 18;
        if (p0 != null && p1 != null) {
          var h0 = t.amount0InRaw / (10n ** BigInt(dec0));
          var h1 = t.amount1InRaw / (10n ** BigInt(dec1));
          usdVolume = Number(h0) * p0 + Number(h1) * p1;
        }
      }
      return {
        periodSeconds: periodSeconds,
        amount0InRaw: t.amount0InRaw,
        amount1InRaw: t.amount1InRaw,
        usdVolume: usdVolume,
        swapCount: t.swapCount,
        status: t.missingTimestamps ? STATUS.PARTIAL : STATUS.COMPLETE,
        missingTimestamps: t.missingTimestamps,
      };
    }

    function getCursor() { return Object.assign({}, cursor); }

    function getStatus() {
      return {
        cursor: Object.assign({}, cursor),
        inMemoryEvents: Object.keys(_events).length,
        status: cursor.status,
      };
    }

    async function reset(fromBlock) {
      cursor.lastIndexedBlock = fromBlock || 0;
      cursor.indexedEvents = 0;
      cursor.status = 'IDLE';
      cursor.lastIndexedAt = 0;
      await persistCursor();
      return Object.assign({}, cursor);
    }

    return {
      EVENT_TYPES: EVENT_TYPES,
      STATUS: STATUS,
      init: init,
      ingestRange: ingestRange,
      ingestLatest: ingestLatest,
      getEvents: getEvents,
      computeVolume: computeVolume,
      getCursor: getCursor,
      getStatus: getStatus,
      reset: reset,
      eventIdentity: eventIdentity,
    };
  }

  var API = {
    VERSION: '1.2.0',
    INDEX_VERSION: INDEX_VERSION,
    EVENT_TYPES: EVENT_TYPES,
    STATUS: STATUS,
    SWAP_EVENT_TYPE: SWAP_EVENT_TYPE,
    SWAP_TOPIC: SWAP_TOPIC,
    SWAPPED_TOPIC: SWAPPED_TOPIC,
    detectSwapEventType: detectSwapEventType,
    createIndexer: createIndexer,
    createDecoder: createDecoder,
    createMemoryStore: createMemoryStore,
    createKVStore: createKVStore,
    eventIdentity: eventIdentity,
    serializeEvent: serializeEvent,
    deserializeEvent: deserializeEvent,
  };

  // Dual-mode: browser global + CommonJS (for Cloudflare Pages Functions).
  if (typeof module !== 'undefined' && module.exports) { module.exports = API; }
  if (typeof window !== 'undefined') { window.PoolIndexer = API; }
})();
