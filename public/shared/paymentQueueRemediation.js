/**
 * Elligentt Payment Queue Remediation — Phase 5
 * Migrates all Payment Queue operations to the Universal Schedule Engine.
 * The Schedule Engine becomes the SINGLE source of truth for all execution.
 * Backward-compatible: existing queue calls are intercepted and routed.
 * Attached to window.PaymentQueueRemediation
 */
(function(){
  'use strict';

  var _initialized = false;

  /* ════════════════════════════════════════
     COMPATIBILITY LAYER
     Intercepts ExecutionQueue.enqueue/updateStatus
     and routes to ScheduleEngine instead.
  ════════════════════════════════════════ */

  function _getScheduleEngine() {
    try {
      if (typeof ScheduleEngine !== 'undefined') return ScheduleEngine;
    } catch(e) {}
    return null;
  }

  function _getAIWallet() {
    try {
      if (typeof AIWallet !== 'undefined') return AIWallet;
    } catch(e) {}
    return null;
  }

  /**
   * Convert old ExecutionQueue task format to ScheduleEngine format.
   */
  function _taskToSchedule(task) {
    var now = new Date().toISOString();

    // Map old types to ScheduleEngine types
    var typeMap = {
      'payment': 'payment',
      'transfer': 'payment',
      'send': 'payment',
      'bridge': 'bridge',
      'swap': 'swap',
      'crosschain': 'crosschain',
      'multisend': 'multisend',
      'treasury': 'payment',
      'recurring': 'payment',
      'scheduled': 'payment'
    };

    var freq = task.freq || 'once';
    if (task.recurrence) {
      freq = task.recurrence;
    }

    var recipients = [];
    if (task.destination && /^0x[0-9a-fA-F]{40}$/.test(task.destination)) {
      recipients = [{ addr: task.destination, amount: task.amount || 0 }];
    }

    var schedule = {
      type: typeMap[task.type] || 'payment',
      name: 'Q→ ' + (task.operation || task.type || 'Payment'),
      token: task.asset || 'USDC',
      amount: task.amount || 0,
      total: task.amount || 0,
      network: task.chain || 'Arc_Testnet',
      fromNetwork: task.fromChain || 'Arc_Testnet',
      toNetwork: task.chain || 'Arc_Testnet',
      recipients: recipients,
      address: task.destination || '',
      freq: freq,
      maxEx: freq === 'once' ? 1 : 0,
      gas: 0.10,
      nextRun: task.startAt || task.scheduledAt || now,
      execCount: 0,
      executionHistory: [],
      status: 'Active',
      created: now,
      createdBy: 'queue_migration',
      agentExecution: true,
      walletAddress: typeof walletAddress !== 'undefined' ? walletAddress : '',
      _migratedFromQueue: true,
      _originalQueueId: task.id
    };

    return schedule;
  }

  /**
   * Replacement for ExecutionQueue.enqueue()
   * NO-OP: Agent/Multisend already creates ScheduleEngine entries directly.
   * Creating queue entries would cause duplicate "Q→" items confusing users.
   * Returns a stub so callers don't break, but does NOT create ScheduleEngine entries.
   */
  function enqueueCompat(opts) {
    return {
      id: 'q_' + Date.now(),
      _isSchedule: false,
      _migrated: false,
      _skipped: true,
      status: 'pending'
    };
  }

  /**
   * Replacement for ExecutionQueue.updateStatus()
   */
  function updateStatusCompat(queueId, status, extra) {
    var se = _getScheduleEngine();
    if (!se) return null;

    // Try to find schedule by original queue ID
    var all = se.getAll();
    var found = null;
    for (var i = 0; i < all.length; i++) {
      if (all[i]._originalQueueId === queueId) {
        found = all[i];
        break;
      }
    }

    if (!found) {
      // Try direct ID match
      found = se.getById(queueId);
    }

    if (!found) return null;

    // Map statuses
    var scheduleStatus = found.status;
    if (status === 'running') { /* keep Active */ }
    else if (status === 'completed') { scheduleStatus = 'Completed'; }
    else if (status === 'failed') { scheduleStatus = 'Failed'; }
    else if (status === 'cancelled') { scheduleStatus = 'Cancelled'; }

    se.update(found.id, { status: scheduleStatus });

    return { id: found.id, status: scheduleStatus, _migrated: true };
  }

  /**
   * Override the existing ExecutionQueue module after it loads.
   */
  function install() {
    if (_initialized) return;

    // Wait for ExecutionQueue to exist, then patch it
    var attempts = 0;
    var maxAttempts = 50;

    function tryPatch() {
      attempts++;
      if (typeof window.ExecutionQueue !== 'undefined') {
        // Save legacy methods
        window.ExecutionQueue._legacyEnqueue = window.ExecutionQueue.enqueue;
        window.ExecutionQueue._legacyUpdateStatus = window.ExecutionQueue.updateStatus;
        window.ExecutionQueue._legacyGetQueue = window.ExecutionQueue.getQueue;
        window.ExecutionQueue._legacyHasPending = window.ExecutionQueue.hasPending;

        // Replace with schedule-based implementations
        window.ExecutionQueue.enqueue = enqueueCompat;
        window.ExecutionQueue.updateStatus = updateStatusCompat;

        // getQueue reads from ScheduleEngine — filters out migrated queue entries
        window.ExecutionQueue.getQueue = function(filter) {
          var se = _getScheduleEngine();
          if (!se) return [];
          var all = se.getAll();
          // Filter out "Q→" migrated entries — agent creates proper entries directly
          var clean = all.filter(function(s) {
            return !s._migratedFromQueue && (s.name || '').indexOf('Q→') !== 0;
          });

          if (filter === 'active' || filter === 'pending' || filter === 'running') {
            return clean.filter(function(s) { return s.status === 'Active'; })
              .map(function(s) { return _scheduleToTaskView(s); });
          }
          if (filter === 'completed') {
            return clean.filter(function(s) { return s.status === 'Completed'; })
              .map(function(s) { return _scheduleToTaskView(s); });
          }
          if (filter === 'failed') {
            return clean.filter(function(s) { return s.status === 'Failed' || s.status === 'Cancelled'; })
              .map(function(s) { return _scheduleToTaskView(s); });
          }
          return clean.map(function(s) { return _scheduleToTaskView(s); });
        };

        window.ExecutionQueue.hasPending = function() {
          var se = _getScheduleEngine();
          if (!se) return false;
          return se.getAll().some(function(s) { return s.status === 'Active'; });
        };

        window.ExecutionQueue.getTask = function(id) {
          var se = _getScheduleEngine();
          if (!se) return null;
          var s = se.getById(id);
          return s ? _scheduleToTaskView(s) : null;
        };

        window.ExecutionQueue.retry = function(id) {
          var se = _getScheduleEngine();
          if (!se) return null;
          se.update(id, { status: 'Active' });
          return _scheduleToTaskView(se.getById(id));
        };

        window.ExecutionQueue.cancel = function(id) {
          var se = _getScheduleEngine();
          if (!se) return null;
          se.update(id, { status: 'Cancelled' });
          return _scheduleToTaskView(se.getById(id));
        };

        // Migrate any existing localStorage queue items
        _migrateLegacyQueue();

        // Clean up existing "Q→" duplicate entries from ScheduleEngine
        _cleanupQueueDuplicates();

        _initialized = true;
        console.log('[QueueRemediation] Installed. Queue → Schedule (no duplicates).');
        return;
      }

      if (attempts < maxAttempts) {
        setTimeout(tryPatch, 200);
      }
    }

    tryPatch();
  }

  function _scheduleToTaskView(schedule) {
    if (!schedule) return null;
    return {
      id: schedule._originalQueueId || schedule.id,
      _scheduleId: schedule.id,
      type: schedule.type,
      operation: schedule.type,
      amount: schedule.amount || schedule.total || 0,
      asset: schedule.token || 'USDC',
      chain: schedule.network || 'Arc Testnet',
      destination: schedule.address || (schedule.recipients && schedule.recipients[0] ? schedule.recipients[0].addr : ''),
      status: schedule.status === 'Active' ? 'pending' :
              schedule.status === 'Completed' ? 'completed' :
              schedule.status === 'Failed' ? 'failed' :
              schedule.status === 'Cancelled' ? 'cancelled' : 'pending',
      created: schedule.created ? new Date(schedule.created).getTime() : Date.now(),
      started: null,
      elapsed: null,
      progress: schedule.execCount || 0,
      progressLabel: '',
      error: null,
      retryCount: 0,
      permitId: null,
      result: schedule.status,
      txHash: null,
      _migrated: true
    };
  }

  function _migrateLegacyQueue() {
    try {
      var raw = localStorage.getItem('elligentt_exec_queue_v1');
      if (!raw) return;

      var legacyQueue = JSON.parse(raw);
      if (!Array.isArray(legacyQueue) || legacyQueue.length === 0) return;

      var se = _getScheduleEngine();
      if (!se) return;

      var migrated = 0;
      for (var i = 0; i < legacyQueue.length; i++) {
        var task = legacyQueue[i];
        if (task.status === 'completed' || task.status === 'cancelled') continue;
        try {
          var schedule = _taskToSchedule(task);
          schedule.name = '[Migrated] ' + schedule.name;
          schedule.status = task.status === 'running' ? 'Active' : 'Active';
          se.create(schedule);
          migrated++;
        } catch(e) {}
      }

      if (migrated > 0) {
        console.log('[QueueRemediation] Migrated ' + migrated + ' legacy queue items to ScheduleEngine.');
        // Archive the old queue
        try {
          localStorage.setItem('elligentt_exec_queue_v1_ARCHIVED', raw);
          localStorage.removeItem('elligentt_exec_queue_v1');
        } catch(e) {}
      }
    } catch(e) {}
  }

  /**
   * Remove existing "Q→" duplicate entries from ScheduleEngine.
   * These were created by the legacy enqueueCompat before this fix.
   * Agent/Multisend entries ("Payment per hour to...") are preserved.
   */
  function _cleanupQueueDuplicates() {
    var se = _getScheduleEngine();
    if (!se) return;
    try {
      var all = se.getAll();
      var removed = 0;
      for (var i = 0; i < all.length; i++) {
        var s = all[i];
        if (s._migratedFromQueue || (s.name && s.name.indexOf('Q→') === 0)) {
          try { se.delete(s.id); removed++; } catch(e) {}
        }
      }
      if (removed > 0) {
        console.log('[QueueRemediation] Cleaned up ' + removed + ' duplicate Q→ entries from ScheduleEngine.');
      }
    } catch(e) {}
  }

  /**
   * Direct Schedule Engine enqueue (for new code).
   * Preferred API — use this directly instead of ExecutionQueue.
   */
  function scheduleNow(opts) {
    var se = _getScheduleEngine();
    if (!se) return null;

    var now = new Date().toISOString();
    var schedule = {
      type: opts.type || 'payment',
      name: opts.name || 'Immediate ' + (opts.type || 'payment'),
      token: opts.token || 'USDC',
      amount: opts.amount || 0,
      total: opts.amount || 0,
      network: opts.network || 'Arc_Testnet',
      fromNetwork: opts.fromNetwork || 'Arc_Testnet',
      toNetwork: opts.toNetwork || 'Arc_Testnet',
      recipients: opts.recipients || (opts.address ? [{ addr: opts.address, amount: opts.amount || 0 }] : []),
      address: opts.address || '',
      freq: 'once',
      maxEx: 1,
      gas: opts.gas || 0.10,
      nextRun: now,
      execCount: 0,
      executionHistory: [],
      status: 'Active',
      created: now,
      createdBy: opts.createdBy || 'queue_remediation',
      agentExecution: true,
      walletAddress: typeof walletAddress !== 'undefined' ? walletAddress : ''
    };

    return se.create(schedule);
  }

  // Auto-install on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { setTimeout(install, 1500); });
  } else {
    setTimeout(install, 1000);
  }

  window.PaymentQueueRemediation = {
    install: install,
    enqueueCompat: enqueueCompat,
    updateStatusCompat: updateStatusCompat,
    scheduleNow: scheduleNow,
    isInstalled: function() { return _initialized; }
  };
})();
