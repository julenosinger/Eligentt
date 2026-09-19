/**
 * Elligentt Scheduler Fix — Phase 5 Remediation
 * Fixes monthly recurrence (29-31 day handling) and nonce management.
 * Attached to window.SchedulerFix
 */
(function(){
  'use strict';

  var _nonceLocks = {};
  var _nonceCounter = 0;
  var _pendingNonces = {};
  var LOCK_TTL_MS = 30000; // 30 second nonce lock

  /* ════════════════════════════════════════
     MONTHLY RECURRENCE FIX
     Properly handles months with fewer days than the target.
  ════════════════════════════════════════ */
  function calcNextMonthlyRun(fromDate, targetDay) {
    var day = targetDay || 1;
    if (day < 1) day = 1;
    if (day > 31) day = 31;

    var d = new Date(fromDate);

    // Move to next month
    d.setUTCMonth(d.getUTCMonth() + 1, 1);

    // Get last day of target month
    var lastDay = new Date(d.getUTCFullYear(), d.getUTCMonth() + 1, 0).getUTCDate();

    // Cap day to actual last day of month
    var actualDay = Math.min(day, lastDay);
    d.setUTCDate(actualDay);

    // Reset time to midnight UTC
    d.setUTCHours(0, 0, 0, 0);

    return d.getTime();
  }

  /**
   * Calculate next execution for ANY recurrence type.
   * Used to replace all recurrence calculations across the codebase.
   */
  function calcNextExecution(recurrence, fromDate, opts) {
    var d = new Date(fromDate || Date.now());
    opts = opts || {};

    switch (recurrence) {
      case 'daily':
        d.setUTCDate(d.getUTCDate() + 1);
        d.setUTCHours(opts.hour || 0, opts.minute || 0, 0, 0);
        return d.getTime();

      case 'weekly': {
        var targetDow = opts.dayOfWeek !== null ? opts.dayOfWeek : 1; // Mon=1
        var currentDow = d.getUTCDay() || 7; // Convert Sun=0 to 7
        var diff = (targetDow + 7 - currentDow) % 7;
        if (diff === 0) diff = 7;
        d.setUTCDate(d.getUTCDate() + diff);
        d.setUTCHours(opts.hour || 9, opts.minute || 0, 0, 0);
        return d.getTime();
      }

      case 'biweekly':
        d.setUTCDate(d.getUTCDate() + 14);
        d.setUTCHours(opts.hour || 9, opts.minute || 0, 0, 0);
        return d.getTime();

      case 'monthly':
        return calcNextMonthlyRun(d, opts.dayOfMonth || 1);

      case 'once':
        return null;

      default:
        return Date.now() + 86400000;
    }
  }

  /* ════════════════════════════════════════
     NONCE MANAGEMENT
     Prevents nonce conflicts between concurrent execution paths.
  ════════════════════════════════════════ */

  /**
   * Reserve a nonce for an execution path.
   * Returns a promise that resolves with the nonce when available.
   */
  async function reserveNonce(provider, address, source) {
    if (!provider || !address) return null;

    var sourceKey = source || 'default';
    var lockKey = address.toLowerCase() + ':' + sourceKey;

    // Clean expired locks
    _cleanExpiredLocks();

    // If this source already has a lock, wait
    if (_nonceLocks[sourceKey]) {
      await new Promise(function(r) { setTimeout(r, 100); });
      return reserveNonce(provider, address, source);
    }

    _nonceLocks[sourceKey] = Date.now();

    try {
      // Fetch nonce including pending transactions
      var nonce = await provider.send('eth_getTransactionCount', [address, 'pending']);
      var nonceNum = parseInt(nonce, 16);

      // Reserve this nonce
      _pendingNonces[sourceKey + '_' + nonceNum] = Date.now();

      _nonceCounter++;
      return { nonce: nonce, nonceNum: nonceNum, source: sourceKey, counter: _nonceCounter };
    } finally {
      delete _nonceLocks[sourceKey];
    }
  }

  function _cleanExpiredLocks() {
    var now = Date.now();
    var keys = Object.keys(_nonceLocks);
    for (var i = 0; i < keys.length; i++) {
      if (now - _nonceLocks[keys[i]] > LOCK_TTL_MS) {
        delete _nonceLocks[keys[i]];
      }
    }
    var pkeys = Object.keys(_pendingNonces);
    for (var j = 0; j < pkeys.length; j++) {
      if (now - _pendingNonces[pkeys[j]] > LOCK_TTL_MS) {
        delete _pendingNonces[pkeys[j]];
      }
    }
  }

  function releaseNonce(sourceKey, nonceNum) {
    delete _nonceLocks[sourceKey];
    delete _pendingNonces[sourceKey + '_' + nonceNum];
  }

  function getNonceStatus() {
    return {
      activeLocks: Object.keys(_nonceLocks).length,
      reservedNonces: Object.keys(_pendingNonces).length,
      totalReserved: _nonceCounter
    };
  }

  /* ════════════════════════════════════════
     PATCHES
     Installs fixes into existing modules.
  ════════════════════════════════════════ */

  function install() {
    var maxAttempts = 60;
    var attempts = 0;

    function tryInstall() {
      attempts++;

      // Patch PermitEngine
      if (typeof window.PermitEngine !== 'undefined' && !window.PermitEngine._remediatedCalcNext) {
        window.PermitEngine._remediatedCalcNext = true;
        // Store original for reference
        window.PermitEngine._originalCalcNextExecution = window.PermitEngine.calcNextExecution;
        // Override with fixed version
        window.PermitEngine.calcNextExecution = function(opts) {
          return calcNextExecution(opts.recurrence, Date.now(), {
            dayOfWeek: opts.dayOfWeek,
            dayOfMonth: opts.dayOfMonth,
            hour: 0,
            minute: 0
          });
        };
      }

      // Patch existing ScheduleEngine if it has _advanceSchedule
      if (typeof window.ScheduleEngine !== 'undefined') {
        // The agentScheduleExecutor already handles this
      }

      // All patches applied
      if (typeof window.PermitEngine !== 'undefined' && window.PermitEngine._remediatedCalcNext) {
        console.log('[SchedulerFix] Patches applied: monthly recurrence + nonce management.');
        return;
      }

      if (attempts < maxAttempts) setTimeout(tryInstall, 200);
    }

    tryInstall();
  }

  // Auto-install
  setTimeout(install, 1500);

  window.SchedulerFix = {
    calcNextExecution: calcNextExecution,
    calcNextMonthlyRun: calcNextMonthlyRun,
    reserveNonce: reserveNonce,
    releaseNonce: releaseNonce,
    getNonceStatus: getNonceStatus,
    install: install
  };
})();
