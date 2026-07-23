/**
 * Elligentt Storage Manager — Phase 5 Remediation
 * Safe serialization, chunked storage, quota monitoring.
 * Replaces all unsafe JSON.stringify(...).substring(0, N) patterns.
 * Attached to window.StorageManager
 */
(function(){
  'use strict';

  var QUOTA_WARNING = 0.80;
  var QUOTA_CRITICAL = 0.95;
  var MAX_ENTRY_SIZE = 500000;
  var CHUNK_SIZE = 2500000;
  var GC_INTERVAL_MS = 300000;
  var _gcTimer = null;
  var _stats = { reads: 0, writes: 0, deletes: 0, errors: 0 };

  /* ── Metadata tracking ── */
  var META_KEY = 'elligentt_sm_meta_v5';
  var meta = {};

  function _loadMeta() {
    try {
      var r = localStorage.getItem(META_KEY);
      if (r) meta = JSON.parse(r);
    } catch(e) { meta = {}; }
    if (!meta.keys) meta.keys = {};
    if (!meta.totalWrites) meta.totalWrites = 0;
    if (!meta.lastGc) meta.lastGc = 0;
  }
  function _saveMeta() {
    try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch(e) {}
  }

  /* ════════════════════════════════════════
     SAFE STORAGE — never corrupts JSON
  ════════════════════════════════════════ */

  /**
   * Store any value safely. If value exceeds MAX_ENTRY_SIZE,
   * stores it in chunks. Older entries are evicted if quota is exceeded.
   */
  function safeSet(key, value) {
    try {
      var serialized = JSON.stringify(value);
      var size = new Blob([serialized]).size;

      // Check quota
      _checkQuota(size);

      // Store normally if under limit
      if (serialized.length <= MAX_ENTRY_SIZE) {
        localStorage.setItem(key, serialized);
      } else {
        // Chunked storage
        _storeChunked(key, serialized, size);
      }

      _stats.writes++;
      meta.keys[key] = { size: size, ts: Date.now(), chunked: serialized.length > MAX_ENTRY_SIZE };
      meta.totalWrites++;
      _saveMeta();

      return true;
    } catch(e) {
      _stats.errors++;
      // Quota exceeded — trigger GC
      if (e.name === 'QuotaExceededError' || (e.message && e.message.indexOf('quota') !== -1)) {
        _emergencyGC(key);
        try {
          var retry = JSON.stringify(value);
          if (retry.length <= MAX_ENTRY_SIZE) {
            localStorage.setItem(key, retry);
            _stats.writes++;
            return true;
          }
        } catch(e2) { /* still failed */ }
      }
      return false;
    }
  }

  /** Read a value safely. Handles normal and chunked storage. */
  function safeGet(key, defaultValue) {
    try {
      var raw = localStorage.getItem(key);
      if (raw === null) return defaultValue !== undefined ? defaultValue : null;

      // Check for chunked marker
      if (raw === 'CHUNKED:' + key) {
        var assembled = _readChunked(key);
        if (assembled === null) return defaultValue !== undefined ? defaultValue : null;
        raw = assembled;
      }

      _stats.reads++;
      return JSON.parse(raw);
    } catch(e) {
      _stats.errors++;
      return defaultValue !== undefined ? defaultValue : null;
    }
  }

  /** Remove a key and any associated chunks */
  function safeRemove(key) {
    try {
      localStorage.removeItem(key);
      // Also remove any chunked data
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(key + '_chunk_') === 0) {
          localStorage.removeItem(k);
        }
      }
      delete meta.keys[key];
      _stats.deletes++;
      _saveMeta();
      return true;
    } catch(e) { return false; }
  }

  /* ════════════════════════════════════════
     CHUNKED STORAGE
  ════════════════════════════════════════ */
  function _storeChunked(key, serialized, totalSize) {
    var numChunks = Math.ceil(serialized.length / CHUNK_SIZE);
    for (var i = 0; i < numChunks; i++) {
      var chunk = serialized.substring(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      localStorage.setItem(key + '_chunk_' + i, chunk);
    }
    // Store marker
    localStorage.setItem(key, 'CHUNKED:' + key);
    // Store metadata
    localStorage.setItem(key + '_chunk_meta', JSON.stringify({ chunks: numChunks, size: totalSize, version: 1 }));
  }

  function _readChunked(key) {
    try {
      var metaRaw = localStorage.getItem(key + '_chunk_meta');
      if (!metaRaw) return null;
      var meta = JSON.parse(metaRaw);
      var parts = [];
      for (var i = 0; i < meta.chunks; i++) {
        var chunk = localStorage.getItem(key + '_chunk_' + i);
        if (chunk === null) return null;
        parts.push(chunk);
      }
      return parts.join('');
    } catch(e) { return null; }
  }

  /* ════════════════════════════════════════
     QUOTA MANAGEMENT
  ════════════════════════════════════════ */
  function _estimateTotalSize() {
    var total = 0;
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (!k) continue;
      try {
        total += (localStorage.getItem(k) || '').length * 2; // UTF-16
      } catch(e) {}
    }
    return total;
  }

  function _checkQuota(incomingSize) {
    var totalBytes = _estimateTotalSize();
    // Browsers typically allow 5-10 MB
    var estimatedLimit = 5000000;
    var usedPct = (totalBytes + incomingSize) / estimatedLimit;

    if (usedPct > QUOTA_CRITICAL) {
      _emergencyGC();
    } else if (usedPct > QUOTA_WARNING) {
      _softGC();
    }
  }

  function _emergencyGC(preferredKey) {
    // Remove oldest entries first, but preserve security-critical keys
    var PROTECTED = [
      'elligentt_agent_session_v2', 'elligentt_agent_wallet_v2',
      'elligente_ew_vault', 'elligentt_session_wallet_v2',
      'elligentt_device_remediation_secret'
    ];

    var candidates = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (!k || PROTECTED.indexOf(k) !== -1) continue;
      if (preferredKey && k === preferredKey) continue;
      var entry = meta.keys[k];
      candidates.push({ key: k, ts: entry ? entry.ts : 0, size: entry ? entry.size : 0 });
    }

    candidates.sort(function(a, b) { return a.ts - b.ts; });

    var freed = 0;
    var target = 500000; // freed 500KB
    for (var j = 0; j < candidates.length && freed < target; j++) {
      safeRemove(candidates[j].key);
      freed += candidates[j].size || 100000;
    }
  }

  function _softGC() {
    // Remove entries older than 7 days that are non-critical
    var cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    var PROTECTED = [
      'elligentt_agent_session_v2', 'elligentt_agent_wallet_v2',
      'elligente_ew_vault', 'elligentt_session_wallet_v2',
      'elligentt_device_remediation_secret', 'elligentt_agent_auth_v1',
      'elligentt_permits_v2', 'elligentt_policies_v1',
      'elligentt_aiw_vault_v1', 'elligentt_aiw_gas_v1'
    ];

    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (!k || PROTECTED.indexOf(k) !== -1) continue;
      if (k.indexOf('_chunk_') !== -1) continue;
      if (k.indexOf('_chunk_meta') !== -1) continue;
      var entry = meta.keys[k];
      if (entry && entry.ts < cutoff && (k.indexOf('_history_') !== -1 || k.indexOf('_notifs_') !== -1)) {
        var val = safeGet(k);
        if (val && Array.isArray(val)) {
          // Halve the array
          val = val.slice(0, Math.floor(val.length / 2));
          safeSet(k, val);
        }
      }
    }

    meta.lastGc = Date.now();
    _saveMeta();
  }

  function getQuotaStatus() {
    var totalBytes = _estimateTotalSize();
    var estimatedLimit = 5000000;
    var pct = (totalBytes / estimatedLimit) * 100;
    return {
      totalBytes: totalBytes,
      estimatedLimit: estimatedLimit,
      usedPercent: Math.round(pct * 100) / 100,
      warning: pct > QUOTA_WARNING * 100,
      critical: pct > QUOTA_CRITICAL * 100,
      keyCount: localStorage.length,
      stats: _stats
    };
  }

  /* ════════════════════════════════════════
     BACKWARD COMPATIBLE OVERRIDES
     Patch existing localStorage-heavy modules
  ════════════════════════════════════════ */

  /**
   * Safe JSON parse that never throws.
   * Replaces raw JSON.parse in localStorage reads.
   */
  function safeJSONParse(raw, defaultValue) {
    if (!raw || typeof raw !== 'string') return defaultValue !== undefined ? defaultValue : null;
    try {
      return JSON.parse(raw);
    } catch(e) {
      return defaultValue !== undefined ? defaultValue : null;
    }
  }

  /**
   * Safe localStorage.getItem with JSON parse.
   */
  function safeLoadJSON(key, defaultValue) {
    return safeGet(key, defaultValue);
  }

  function getStats() { return _stats; }

  /* ── Start periodic cleanup ── */
  function startGC() {
    if (_gcTimer) return;
    _gcTimer = setInterval(function() {
      _softGC();
    }, GC_INTERVAL_MS);
  }

  function stopGC() {
    if (_gcTimer) { clearInterval(_gcTimer); _gcTimer = null; }
  }

  _loadMeta();
  startGC();

  /* ════════════════════════════════════════
     PUBLIC API
  ════════════════════════════════════════ */
  window.StorageManager = {
    // Safe operations
    safeSet: safeSet,
    safeGet: safeGet,
    safeRemove: safeRemove,
    safeJSONParse: safeJSONParse,
    safeLoadJSON: safeLoadJSON,

    // Quota
    getQuotaStatus: getQuotaStatus,

    // Lifecycle
    startGC: startGC,
    stopGC: stopGC,

    // Stats
    getStats: getStats,

    // Config
    QUOTA_WARNING: QUOTA_WARNING,
    QUOTA_CRITICAL: QUOTA_CRITICAL,
    MAX_ENTRY_SIZE: MAX_ENTRY_SIZE
  };
})();
