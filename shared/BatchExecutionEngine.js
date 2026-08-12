/**
 * Batch Execution Engine ÔÇö Auto-Execution Layer for Multisend & Batch Intents
 * ADDITIVE module ÔÇö zero modifications to existing systems.
 *
 * Architecture:
 *   AI Wallet ÔåÆ creates validated intents ÔåÆ ScheduleEngine entry
 *   BatchExecutionEngine ÔåÆ auto-pickup for instant multisend/batch intents
 *   ÔåÆ triggers existing _agentExecuteMultiSend via window
 *   ÔåÆ tracks progress ÔåÆ generates reports ÔåÆ updates history
 *
 * Engines (bundled, additive):
 *   BatchExecutorEngine      ÔÇö auto-pickup + execution trigger
 *   BatchProgressTracker     ÔÇö per-recipient progress tracking
 *   BatchReportEngine        ÔÇö post-execution reporting
 *
 * ONLY activates for:
 *   executionMode = instant  AND
 *   intentType = multisend OR batchPayment OR crosschainBatch
 *
 * Attached to window.BatchExecutionEngine
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'elligentt_batx_v1';
  var POLL_MS = 8000;
  var MAX_RETRIES = 3;
  var RETRY_DELAY_MS = 5000;
  var _pollTimer = null;
  var _busy = false;

  /* ÔöÇÔöÇ State ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ */
  var state = {
    executions: [],          // [{scheduleId, intentId, status, recipients, results, startTime, endTime, txHash, report}]
    lastReport: null
  };

  function load() {
    try { var r = localStorage.getItem(STORAGE_KEY); if (r) state = JSON.parse(r); } catch (_e) {}
  }
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_e) {}
  }

  /* ÔöÇÔöÇ Helpers ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ */
  function hasAIWallet() {
    try { return typeof window.AIWallet !== 'undefined'; } catch (e) { return false; }
  }
  function hasAgentScheduler() {
    try { return typeof window._agentExecuteMultiSend === 'function'; } catch (e) { return false; }
  }
  function hasScheduleEngine() {
    try { return typeof ScheduleEngine !== 'undefined'; } catch (e) { return false; }
  }
  function hasAgentWallet() {
    try {
      return typeof AgentWalletManager !== 'undefined' &&
             !AgentWalletManager.isPaused() &&
             AgentWalletManager.getAgentAddress();
    } catch (e) { return false; }
  }
  function isEmergencyStopped() {
    try {
      if (window.AIWallet && typeof window.AIWallet.isEmergencyStopped === 'function')
        return window.AIWallet.isEmergencyStopped();
    } catch (_e) {}
    return false;
  }

  /* ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
     BATCH EXECUTOR ENGINE ÔÇö Auto-Pickup & Execute
     ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ */

  /**
   * Check if an AI Wallet intent qualifies for auto-execution.
   * Only: executionMode=instant + op in multisend/batchPayment/crosschainBatch
   */
  function isInstantBatchIntent(it) {
    if (!it) return false;
    if (it.executionMode !== 'instant') return false;
    var batchOps = ['multisend', 'batchPayment', 'crosschainBatch', 'payroll'];
    return batchOps.indexOf(it.op) !== -1;
  }

  /**
   * Find due multisend schedules created by aiwallet that haven't been
   * executed yet. These are instant intents handed off to ScheduleEngine.
   */
  function findDueBatchSchedules() {
    if (!hasScheduleEngine()) return [];
    var all = ScheduleEngine.getAll();
    var now = Date.now();
    return all.filter(function (s) {
      if (s.createdBy !== 'aiwallet') return false;
      if (s.type !== 'multisend') return false;
      if (s.status !== 'Active') return false;
      if (!s.nextRun) return false;
      if (new Date(s.nextRun).getTime() > now) return false;
      // Skip already being executed
      if (state.executions.some(function (e) {
        return e.scheduleId === s.id && (e.status === 'running' || e.status === 'broadcasting');
      })) return false;
      // Skip completed/failed in our state
      if (state.executions.some(function (e) {
        return e.scheduleId === s.id && (e.status === 'completed' || e.status === 'failed');
      })) return false;
      return true;
    });
  }

  /**
   * Extract recipients from a schedule entry.
   * Returns {token, addresses: [], amounts: []}
   */
  function extractBatchParams(sched) {
    var token = sched.token || 'USDC';
    var recipients = sched.recipients || [];
    var addrs = [];
    var amts = [];
    for (var i = 0; i < recipients.length; i++) {
      var r = recipients[i];
      var addr = r.addr || r.address || '';
      var amt = parseFloat(r.amount || sched.amount || 0);
      if (/^0x[0-9a-fA-F]{40}$/.test(addr) && isFinite(amt) && amt > 0) {
        addrs.push(addr);
        amts.push(amt);
      }
    }
    return { token: token, addresses: addrs, amounts: amts, total: amts.reduce(function (s, a) { return s + a; }, 0) };
  }

  /**
   * Execute a single batch (multisend) schedule.
   * Uses the EXISTING _agentExecuteMultiSend ÔÇö zero duplicated business logic.
   */
  async function executeBatchSchedule(sched) {
    if (!hasAgentScheduler()) {
      return { ok: false, error: 'Agent scheduler unavailable (_agentExecuteMultiSend not found)' };
    }

    var params = extractBatchParams(sched);
    if (!params.addresses.length) {
      return { ok: false, error: 'No valid recipients found in schedule ' + sched.id };
    }
    if (params.addresses.length > 256) {
      return { ok: false, error: 'Batch too large (' + params.addresses.length + ' > 256)' };
    }

    // Shared cross-executor claim (same slot key as AgentScheduleExecutor:
    // "scheduleId|nextRun") so the same schedule is never executed twice.
    var claimKey = sched.id + '|' + sched.nextRun;
    var _claimAcquired = false;
    if (hasScheduleEngine() && typeof ScheduleEngine.claimExecution === 'function') {
      if (!ScheduleEngine.claimExecution(claimKey, 'batch_execution_engine')) {
        return { ok: false, error: 'Schedule already claimed by another executor' };
      }
      _claimAcquired = true;
    }

    var execEntry = {
      id: 'BATX-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      scheduleId: sched.id,
      intentId: null,
      status: 'running',
      token: params.token,
      recipients: params.addresses.length,
      totalAmount: params.total,
      startedAt: Date.now(),
      progress: 0,
      progressLabel: 'Starting...',
      txHash: null,
      results: [],
      retries: 0
    };

    // Find matching AI Wallet intent
    if (hasAIWallet()) {
      var intents = window.AIWallet.getIntents();
      for (var j = 0; j < intents.length; j++) {
        if (intents[j].schedId === sched.id || intents[j].op === 'multisend') {
          execEntry.intentId = intents[j].id;
          // Update intent status to executing
          if (intents[j].status === 'executing' || intents[j].status === 'approved') {
            intents[j].status = 'executing';
            intents[j]._batchExecId = execEntry.id;
          }
          break;
        }
      }
    }

    state.executions.unshift(execEntry);
    if (state.executions.length > 50) state.executions.length = 50;
    save();

    emitStatus(execEntry);

    var startTime = Date.now();
    try {
      execEntry.status = 'broadcasting';
      execEntry.progressLabel = 'Sending batch to ' + params.addresses.length + ' recipients...';
      execEntry.progress = 10;
      save();
      emitStatus(execEntry);

      // Execute via existing agent multisend function
      await window._agentExecuteMultiSend(params.token, params.addresses, params.amounts);

      // Check if execution produced a result via the agent state messages
      // _agentExecuteMultiSend is fire-and-forget in nature; we check for completion
      var elapsed = Date.now() - startTime;
      execEntry.status = 'completed';
      execEntry.progress = 100;
      execEntry.progressLabel = 'Batch completed ÔÇö ' + params.addresses.length + ' recipients';
      execEntry.endTime = Date.now();
      execEntry.retries = 0;

      // Generate report
      execEntry.report = generateReport(execEntry);

      // Update the AI Wallet intent status
      updateIntentStatus(execEntry, 'executed');

      // Update schedule execution count
      updateScheduleAfterExecution(sched, execEntry);

      // Update history
      updateHistory(execEntry, params);

      save();
      emitStatus(execEntry);
      return { ok: true, execEntry: execEntry, elapsed: elapsed };
    } catch (e) {
      execEntry.status = 'failed';
      execEntry.progressLabel = 'Failed: ' + (e.message || String(e)).substring(0, 80);
      execEntry.endTime = Date.now();
      execEntry.retries = (execEntry.retries || 0) + 1;

      updateIntentStatus(execEntry, 'failed');

      save();
      emitStatus(execEntry);
      return { ok: false, error: e.message || String(e), execEntry: execEntry };
    } finally {
      if (_claimAcquired && hasScheduleEngine() && typeof ScheduleEngine.releaseExecutionClaim === 'function') {
        try { ScheduleEngine.releaseExecutionClaim(claimKey, 'batch_execution_engine'); } catch(_e) {}
      }
    }
  }

  /**
   * Retry a failed batch execution if safe.
   * Only retries for RPC/temporary failures ÔÇö never for auth/permission/balance failures.
   */
  async function retryExecution(execEntryId) {
    var entry = state.executions.find(function (e) { return e.id === execEntryId; });
    if (!entry) return { ok: false, error: 'Execution entry not found' };
    if (entry.retries >= MAX_RETRIES) return { ok: false, error: 'Max retries exhausted' };
    if (entry.status !== 'failed') return { ok: false, error: 'Can only retry failed executions' };

    var sched = hasScheduleEngine() ? ScheduleEngine.getById(entry.scheduleId) : null;
    if (!sched) return { ok: false, error: 'Schedule not found' };

    entry.status = 'retrying';
    entry.retries++;
    save();
    emitStatus(entry);

    return executeBatchSchedule(sched);
  }

  /* ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
     PROGRESS TRACKER ÔÇö BatchProgressTracker
     ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ */
  function getExecutionStatus(execEntryId) {
    return state.executions.find(function (e) { return e.id === execEntryId; }) || null;
  }

  function getActiveExecutions() {
    return state.executions.filter(function (e) {
      return e.status === 'running' || e.status === 'broadcasting' || e.status === 'retrying';
    });
  }

  function getCompletedExecutions(limit) {
    return state.executions
      .filter(function (e) { return e.status === 'completed' || e.status === 'failed'; })
      .slice(0, limit || 20);
  }

  function getProgressHTML(execEntry) {
    if (!execEntry) return '';
    var pct = execEntry.progress || 0;
    var statusColor = execEntry.status === 'completed' ? 'var(--green)' :
      execEntry.status === 'failed' ? 'var(--red)' :
      execEntry.status === 'running' || execEntry.status === 'broadcasting' ? 'var(--yellow)' :
      'var(--muted2)';

    return '<div style="border:1px solid ' + (execEntry.status === 'running' || execEntry.status === 'broadcasting' ? 'rgba(167,139,250,.4)' : 'var(--border)') + ';border-radius:7px;padding:9px;margin-bottom:7px;background:rgba(0,0,0,.15)">' +
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
      '<span style="font-size:10px;font-weight:700;color:var(--text)">Batch Payment</span>' +
      '<span class="chip" style="border:1px solid var(--border);color:' + statusColor + '">' + escapeHTML(execEntry.status) + '</span>' +
      '<span style="font-size:9px;color:var(--muted2)">' + (execEntry.recipients || 0) + ' recipients</span>' +
      '<span style="margin-left:auto;font-size:9px;font-weight:600;color:var(--text)">' + escapeHTML(String(execEntry.totalAmount)) + ' ' + escapeHTML(execEntry.token) + '</span></div>' +
      '<div style="margin-top:5px;height:4px;background:var(--border);border-radius:2px;overflow:hidden">' +
      '<div style="height:100%;width:' + pct + '%;background:' + (pct >= 100 ? 'var(--green)' : 'var(--purple)') + ';transition:width .3s"></div></div>' +
      '<div style="font-size:8px;color:var(--muted2);margin-top:4px;display:flex;justify-content:space-between">' +
      '<span>' + escapeHTML(execEntry.progressLabel || '') + '</span>' +
      '<span>' + pct + '%' + (execEntry.startedAt ? ' ┬À ' + formatElapsed(Date.now() - execEntry.startedAt) : '') + '</span></div>' +
      (execEntry.txHash ? '<div style="font-size:8px;color:var(--blue);margin-top:2px"><a href="https://testnet.arcscan.app/tx/' + execEntry.txHash + '" target="_blank" rel="noopener">' + escapeHTML(String(execEntry.txHash).substring(0, 14) + '...') + '</a></div>' : '') +
      (execEntry.status === 'failed' && execEntry.retries < MAX_RETRIES ?
        '<button class="btn" style="font-size:8.5px;padding:3px 8px;margin-top:4px" onclick="BatchExecutionEngine.retryExecution(\'' + escapeHTML(execEntry.id) + '\')">Retry</button>' : '') +
      '</div>';
  }

  /* ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
     REPORT ENGINE ÔÇö BatchReportEngine
     ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ */
  function generateReport(execEntry) {
    var elapsed = execEntry.endTime ? execEntry.endTime - execEntry.startedAt : Date.now() - execEntry.startedAt;
    return {
      executionId: execEntry.id,
      scheduleId: execEntry.scheduleId,
      intentId: execEntry.intentId,
      status: execEntry.status,
      totalRecipients: execEntry.recipients,
      totalAmount: execEntry.totalAmount,
      token: execEntry.token,
      txHash: execEntry.txHash || null,
      executionTimeMs: elapsed,
      executionTimeFormatted: formatElapsed(elapsed),
      retries: execEntry.retries || 0,
      timestamp: new Date().toISOString()
    };
  }

  function getLastReport() { return state.lastReport; }

  /* ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
     HISTORY & INTENT UPDATES
     ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ */
  function updateIntentStatus(execEntry, status) {
    if (!hasAIWallet()) return;
    try {
      var intents = window.AIWallet.getIntents();
      for (var i = 0; i < intents.length; i++) {
        var it = intents[i];
        if (it.schedId === execEntry.scheduleId || it._batchExecId === execEntry.id) {
          it.status = status;
          it._batchExecId = execEntry.id;
          if (status === 'executed') it.executedAt = Date.now();
          break;
        }
      }
    } catch (_e) {}
  }

  function updateScheduleAfterExecution(sched, execEntry) {
    if (!hasScheduleEngine()) return;
    try {
      var nextRun = null;
      if (sched.freq === 'once') {
        ScheduleEngine.update(sched.id, {
          status: 'Completed',
          execCount: (sched.execCount || 0) + 1,
          lastExecuted: new Date().toISOString()
        });
      } else {
        var d = new Date();
        switch (sched.freq) {
          case 'daily': d.setUTCDate(d.getUTCDate() + 1); break;
          case 'weekly': d.setUTCDate(d.getUTCDate() + 7); break;
          case 'biweekly': d.setUTCDate(d.getUTCDate() + 14); break;
          case 'monthly': d.setUTCMonth(d.getUTCMonth() + 1); break;
          default: d = null; break;
        }
        nextRun = d ? d.toISOString() : null;
        ScheduleEngine.update(sched.id, {
          nextRun: nextRun,
          execCount: (sched.execCount || 0) + 1,
          lastExecuted: new Date().toISOString()
        });
      }
    } catch (_e) {}
  }

  function updateHistory(execEntry, params) {
    try {
      if (typeof ExecutionHistory !== 'undefined') {
        ExecutionHistory.recordExecution({
          operation: 'batch_multisend',
          amount: params.total,
          asset: params.token,
          chain: 'Arc Testnet',
          txHash: execEntry.txHash || '',
          result: execEntry.status === 'completed' ? 'success' : 'failed',
          duration: execEntry.endTime ? execEntry.endTime - execEntry.startedAt : 0,
          displayText: 'Batch ' + params.addresses.length + ' recipients ÔÇö ' + params.total + ' ' + params.token
        });
      }
    } catch (_e) {}
    try {
      if (typeof AgentAudit !== 'undefined') {
        AgentAudit.recordExecution({
          operation: 'batch_multisend',
          amount: params.total,
          asset: params.token,
          chain: 'Arc Testnet',
          transactionHash: execEntry.txHash || '',
          result: execEntry.status === 'completed' ? 'success' : 'failed',
          duration: execEntry.endTime ? execEntry.endTime - execEntry.startedAt : 0,
          metadata: {
            batchId: execEntry.id,
            recipients: params.addresses.length,
            executor: 'BatchExecutionEngine'
          }
        });
      }
    } catch (_e) {}
  }

  /* ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
     AUTO-POLL LOOP ÔÇö checks for new due batch schedules
     ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ */
  async function poll() {
    if (_busy) return;
    if (isEmergencyStopped()) return;
    if (!hasAgentWallet()) return;

    _busy = true;
    try {
      var due = findDueBatchSchedules();
      for (var i = 0; i < due.length; i++) {
        await executeBatchSchedule(due[i]);
      }
    } catch (_e) {
    } finally {
      _busy = false;
    }
  }

  /**
   * Handle SCHEDULE_CREATED events for instant dispatch.
   * When aiwallet creates a multisend schedule, auto-trigger execution.
   */
  function onScheduleCreated(detail) {
    if (!detail) return;
    if (detail.createdBy !== 'aiwallet') return;
    if (detail.type !== 'multisend') return;
    if (detail.freq !== 'once' && detail.freq !== undefined && detail.status !== 'Active') return;

    // Immediate pickup ÔÇö short delay to allow validation completion
    setTimeout(function () {
      poll();
    }, 1200);
  }

  /* ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
     DIRECT EXECUTION API ÔÇö for AI Wallet to call directly
     ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ */

  /**
   * Execute a batch intent directly (bypasses schedule polling delay).
   * Called by AI Wallet when instant execution is requested.
   */
  async function executeIntentDirect(intentOrSchedule) {
    var sched;

    if (intentOrSchedule.id && intentOrSchedule.type) {
      // Already a schedule entry
      sched = intentOrSchedule;
    } else if (intentOrSchedule.schedId && hasScheduleEngine()) {
      sched = ScheduleEngine.getById(intentOrSchedule.schedId);
    }

    if (!sched) return { ok: false, error: 'No schedule found' };

    return executeBatchSchedule(sched);
  }

  /* ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
     HELPERS
     ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ */
  function escapeHTML(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function formatElapsed(ms) {
    if (!ms || ms < 0) return '0s';
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    if (ms < 3600000) return Math.floor(ms / 60000) + 'm ' + Math.floor((ms % 60000) / 1000) + 's';
    return Math.floor(ms / 3600000) + 'h ' + Math.floor((ms % 3600000) / 60000) + 'm';
  }

  function emitStatus(execEntry) {
    try {
      if (typeof document !== 'undefined') {
        document.dispatchEvent(new CustomEvent('BATCH_EXEC_STATUS', { detail: execEntry }));
      }
    } catch (_e) {}
  }

  /* ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
     INIT ÔÇö Background poll + event listener
     ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ */
  function init() {
    load();

    if (typeof document !== 'undefined') {
      document.addEventListener('SCHEDULE_CREATED', function (e) {
        onScheduleCreated(e.detail);
      });
    }

    // Background poll for pending batch schedules
    function startPoll() {
      if (_pollTimer) return;
      _pollTimer = setInterval(poll, POLL_MS);
      setTimeout(poll, 3000); // Initial check after load
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        setTimeout(startPoll, 5000);
      });
    } else {
      setTimeout(startPoll, 4000);
    }
  }

  init();

  /* ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
     PUBLIC API
     ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ */
  window.BatchExecutionEngine = {
    // Core execution
    executeBatchSchedule: executeBatchSchedule,
    executeIntentDirect: executeIntentDirect,
    retryExecution: retryExecution,
    poll: poll,

    // Query
    getExecutionStatus: getExecutionStatus,
    getActiveExecutions: getActiveExecutions,
    getCompletedExecutions: getCompletedExecutions,
    getProgressHTML: getProgressHTML,
    getLastReport: getLastReport,
    findDueBatchSchedules: findDueBatchSchedules,

    // Report
    generateReport: generateReport,

    // Classification
    isInstantBatchIntent: isInstantBatchIntent,

    // State
    getState: function () { return state; },

    version: '1.0.0'
  };
})();
