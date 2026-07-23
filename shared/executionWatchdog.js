/**
 * Execution Watchdog — Pure Monitoring & Timeout Layer
 * Never executes, signs, or approves transactions.
 * Monitors the AI Smart Wallet + Agent Schedule Executor pipelines
 * to prevent intents from remaining indefinitely in "validating".
 * Attached to window.ExecutionWatchdog
 */
(function(){
  'use strict';

  /* ════════════════════════════════════════
     TIMEOUT CONFIG (ms) — adjustable per stage
  ════════════════════════════════════════ */
  var TIMEOUTS = {
    balance_validation: 5000,
    permission_validation: 5000,
    vault_validation: 5000,
    risk_validation: 5000,
    gas_validation: 5000,
    policy_validation: 5000,
    queue_wait: 15000,
    tx_submission: 30000,
    rpc_confirmation: 60000,
    dispatch: 10000,
    schedule_pickup: 30000,
    total_execution: 300000,   // 5 min max for entire execution
    overall_validation: 45000  // 45s max for all validations
  };

  var HEALTH_CHECK_MS = 15000;
  var STUCK_THRESHOLD_MS = 90000; // 90s stuck = generate report
  var _healthTimer = null;
  var _reports = [];
  var _maxReports = 50;

  /* ════════════════════════════════════════
     TIMEOUT WRAPPER — Promise.race against setTimeout
  ════════════════════════════════════════ */
  function wrapWithTimeout(promise, timeoutMs, label) {
    var ms = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : 15000;
    var labelStr = String(label || 'operation');

    var timer = new Promise(function(_, reject) {
      setTimeout(function() {
        reject(new Error('TIMEOUT:' + labelStr + ' (exceeded ' + ms + 'ms)'));
      }, ms);
    });

    return Promise.race([promise, timer]).then(
      function(result) { return result; },
      function(err) {
        var msg = (err && err.message) ? String(err.message) : String(err);
        if (msg.indexOf('TIMEOUT:') === 0) {
          _recordTimeout(labelStr, ms);
          return null; // Return null instead of throwing — caller handles null
        }
        throw err;
      }
    );
  }

  function wrapRPC(promise, timeoutMs, label) {
    return wrapWithTimeout(promise, timeoutMs || TIMEOUTS.balance_validation, label || 'RPC');
  }

  /* ════════════════════════════════════════
     STAGE TRACKING — injects metadata into intent objects
  ════════════════════════════════════════ */
  function trackStage(intent, stageIndex, stageTotal, stageName, detail) {
    if (!intent) return;
    if (!intent._watchdog) intent._watchdog = {};
    var wd = intent._watchdog;

    wd.currentStage = stageIndex;
    wd.stageTotal = stageTotal;
    wd.stageName = String(stageName || '');
    wd.stageDetail = String(detail || '');
    wd.stageStartedAt = Date.now();
    wd.lastStageChangedAt = Date.now();
    wd.elapsedTotal = intent.createdAt ? Date.now() - intent.createdAt : 0;

    if (!wd.stages) wd.stages = [];
    wd.stages.push({
      index: stageIndex, name: stageName, detail: detail || '',
      startedAt: Date.now(), status: 'running'
    });
  }

  function markStageComplete(intent, stageName, passed, reason) {
    if (!intent || !intent._watchdog) return;
    var wd = intent._watchdog;
    if (wd.stages && wd.stages.length) {
      var last = wd.stages[wd.stages.length - 1];
      if (last && last.name === stageName) {
        last.status = passed ? 'passed' : 'failed';
        last.reason = reason || '';
        last.completedAt = Date.now();
      }
    }
    wd.lastStageChangedAt = Date.now();
    wd.elapsedTotal = intent.createdAt ? Date.now() - intent.createdAt : 0;
  }

  function initIntentWatchdog(intent) {
    if (!intent) return;
    if (!intent._watchdog) intent._watchdog = {};
    var wd = intent._watchdog;
    wd.currentStage = 0;
    wd.stageTotal = 1;
    wd.stageName = 'Created';
    wd.stageDetail = '';
    wd.stageStartedAt = intent.createdAt || Date.now();
    wd.lastStageChangedAt = Date.now();
    wd.elapsedTotal = 0;
    wd.retryCount = 0;
    wd.rpcLatency = null;
    wd.healthStatus = 'pending';
    wd.stages = [];
    wd.healthCheckCount = 0;
    wd.estimatedRemaining = null;
    wd.queuePosition = null;
    wd.lastRPCError = null;
    wd.lastTimeout = null;
  }

  /* ════════════════════════════════════════
     STATUS MACHINE HELPER
  ════════════════════════════════════════ */
  var VALID_STAGES = [
    'Created','Validating','Authorized','Queued','Executing',
    'Waiting RPC','Waiting Confirmation','Completed','Failed',
    'Timed Out','Retrying','Cancelled'
  ];

  function getStageFromStatus(status) {
    var map = {
      'validating': 'Validating',
      'approved': 'Authorized',
      'executing': 'Executing',
      'executed': 'Completed',
      'rejected': 'Failed',
      'failed': 'Failed',
      'cancelled': 'Cancelled'
    };
    return map[status] || status;
  }

  /* ════════════════════════════════════════
     STUCK INTENT DETECTION
  ════════════════════════════════════════ */
  function isIntentStuck(intent) {
    if (!intent) return false;
    var stuckStates = ['validating', 'executing'];
    if (stuckStates.indexOf(intent.status) === -1) return false;
    var elapsed = intent.createdAt ? Date.now() - intent.createdAt : 0;
    return elapsed > STUCK_THRESHOLD_MS;
  }

  function getStuckReason(intent) {
    if (!intent || !intent._watchdog) return 'Unknown — no watchdog data';
    var wd = intent._watchdog;
    var reason = 'Elapsed: ' + (wd.elapsedTotal ? (wd.elapsedTotal / 1000).toFixed(1) + 's' : 'N/A');

    if (wd.lastRPCError) reason += ' | Last RPC Error: ' + wd.lastRPCError;
    if (wd.lastTimeout) reason += ' | Last Timeout: ' + wd.lastTimeout;
    if (wd.stageName) reason += ' | Stage: ' + wd.stageName + ' (' + wd.currentStage + '/' + wd.stageTotal + ')';
    if (wd.lastStageChangedAt) reason += ' | Stage stuck for: ' + ((Date.now() - wd.lastStageChangedAt) / 1000).toFixed(0) + 's';

    var lastStage = wd.stages && wd.stages.length ? wd.stages[wd.stages.length - 1] : null;
    if (lastStage && lastStage.status === 'running') reason += ' | Running stage: ' + lastStage.name;

    return reason;
  }

  function findStuckIntents(intents) {
    if (!Array.isArray(intents)) return [];
    return intents.filter(isIntentStuck);
  }

  /* ════════════════════════════════════════
     DIAGNOSTIC REPORT
  ════════════════════════════════════════ */
  function generateReport(intent) {
    if (!intent) return { error: 'No intent provided' };
    var wd = intent._watchdog || {};
    var report = {
      intentId: intent.id || 'N/A',
      operation: intent.op || 'N/A',
      amount: intent.amount,
      token: intent.token,
      status: intent.status,
      createdAt: intent.createdAt ? new Date(intent.createdAt).toISOString() : 'N/A',
      elapsedSeconds: intent.createdAt ? ((Date.now() - intent.createdAt) / 1000).toFixed(1) : 'N/A',
      currentStage: wd.stageName || 'N/A',
      stageProgress: wd.currentStage ? (wd.currentStage + '/' + wd.stageTotal) : 'N/A',
      stageElapsedMs: wd.stageStartedAt ? Date.now() - wd.stageStartedAt : 'N/A',
      retryCount: wd.retryCount || 0,
      rpcLatency: wd.rpcLatency || 'N/A',
      lastRPCError: wd.lastRPCError || 'None',
      lastTimeout: wd.lastTimeout || 'None',
      healthStatus: wd.healthStatus || 'N/A',
      estimatedRemaining: wd.estimatedRemaining || 'N/A',
      queuePosition: wd.queuePosition || 'N/A',
      validationChecks: (intent.checks || []).map(function(c) {
        return { name: c.name, passed: c.passed, reason: c.reason || '' };
      }),
      stageHistory: (wd.stages || []).map(function(s) {
        return { name: s.name, status: s.status, durationMs: s.completedAt ? s.completedAt - s.startedAt : (Date.now() - s.startedAt) };
      }),
      suggestedAction: 'Check RPC connectivity. If RPC is healthy, cancel and retry the intent.'
    };

    if (wd.healthStatus === 'rpc_timeout') {
      report.suggestedAction = 'RPC appears to be unresponsive. Try switching RPC endpoint or wait for recovery.';
    } else if (wd.healthStatus === 'stuck_validation') {
      report.suggestedAction = 'Validation is stuck at "' + (wd.stageName || 'unknown') + '". Try cancelling and re-submitting.';
    } else if (wd.healthStatus === 'stuck_execution') {
      report.suggestedAction = 'Execution dispatched but schedule not picked up. Check AgentScheduleExecutor is running and authorized.';
    }

    _reports.unshift(report);
    if (_reports.length > _maxReports) _reports.length = _maxReports;
    return report;
  }

  /* ════════════════════════════════════════
     HEALTH CHECK
  ════════════════════════════════════════ */
  function _recordTimeout(label, ms) {
    try {
      if (typeof AgentAudit !== 'undefined') {
        AgentAudit.recordExecution({
          operation: 'watchdog_timeout', amount: 0, asset: 'USDC', chain: 'Arc Testnet',
          result: 'timeout', duration: ms, metadata: { label: label, timeoutMs: ms }
        });
      }
    } catch(e) {}
  }

  function runHealthCheck(getIntentsFn) {
    var intents = [];
    try {
      if (typeof getIntentsFn === 'function') intents = getIntentsFn();
      else if (typeof AIWallet !== 'undefined' && AIWallet.getIntents) intents = AIWallet.getIntents();
    } catch(e) { return { ok: false, error: e.message }; }

    var stuck = findStuckIntents(intents);
    var results = {
      checked: intents.length,
      stuck: stuck.length,
      reports: [],
      timestamp: Date.now()
    };

    stuck.forEach(function(it) {
      var report = generateReport(it);
      results.reports.push({ id: it.id, status: it.status, stage: report.currentStage, reason: getStuckReason(it), elapsed: report.elapsedSeconds });
      if (it._watchdog) {
        it._watchdog.healthCheckCount = (it._watchdog.healthCheckCount || 0) + 1;
      }
    });

    if (stuck.length) {
      try {
        if (typeof document !== 'undefined') {
          document.dispatchEvent(new CustomEvent('WATCHDOG_STUCK_INTENTS', { detail: results }));
        }
      } catch(e) {}
    }

    return results;
  }

  function startHealthCheck(intervalMs, getIntentsFn) {
    stopHealthCheck();
    var ms = intervalMs || HEALTH_CHECK_MS;
    _healthTimer = setInterval(function() {
      runHealthCheck(getIntentsFn);
    }, ms);
    return true;
  }

  function stopHealthCheck() {
    if (_healthTimer) { clearInterval(_healthTimer); _healthTimer = null; }
  }

  function isHealthCheckRunning() { return !!_healthTimer; }

  /* ════════════════════════════════════════
     STAGE PROGRESS HTML BUILDER
  ════════════════════════════════════════ */
  function buildStageProgressHTML(intent) {
    if (!intent || !intent._watchdog) return '';
    var wd = intent._watchdog;
    var current = wd.currentStage || 0;
    var total = wd.stageTotal || 1;
    var name = wd.stageName || 'Validating';
    var pct = total > 0 ? Math.round((current / total) * 100) : 0;
    var elapsed = wd.elapsedTotal ? (wd.elapsedTotal / 1000).toFixed(1) : '0.0';
    var healthColor = wd.healthStatus === 'stuck' || wd.healthStatus === 'rpc_timeout' ? 'var(--red)' :
      wd.healthStatus === 'slow' ? 'var(--yellow)' : 'var(--muted2)';

    var html = '<div style="font-size:8px;color:var(--muted2);margin-top:4px;display:flex;flex-wrap:wrap;gap:8px;align-items:center">';
    html += '<span title="Current validation stage">' + name + ' (' + current + '/' + total + ')</span>';
    html += '<span style="display:inline-block;width:50px;height:3px;background:rgba(255,255,255,.08);border-radius:2px;overflow:hidden">';
    html += '<span style="display:block;width:' + pct + '%;height:100%;background:' + (pct >= 100 ? 'var(--green)' : pct > 30 ? 'var(--blue)' : 'var(--yellow)') + ';border-radius:2px;transition:width .3s"></span></span>';
    html += '<span>' + elapsed + 's elapsed</span>';
    if (wd.estimatedRemaining) html += '<span style="color:' + healthColor + '">~' + wd.estimatedRemaining.toFixed(0) + 's remaining</span>';
    if (wd.rpcLatency) html += '<span>RPC ' + wd.rpcLatency + 'ms</span>';
    if (wd.retryCount > 0) html += '<span style="color:var(--yellow)">retry #' + wd.retryCount + '</span>';
    html += '</div>';
    return html;
  }

  function buildReportHTML(report) {
    var r = report;
    return '<div style="font-size:8.5px;line-height:1.8;background:rgba(0,0,0,.2);border:1px solid rgba(255,255,255,.06);border-radius:4px;padding:8px;margin-top:4px">' +
      '<div style="color:var(--muted2);margin-bottom:4px;font-weight:600">Diagnostic Report</div>' +
      '<div>Intent: <span style="color:var(--text)">' + (r.intentId || 'N/A') + '</span></div>' +
      '<div>Status: <span style="color:var(--red)">' + (r.status || 'N/A') + '</span></div>' +
      '<div>Stage: <span style="color:var(--yellow)">' + (r.currentStage || 'N/A') + '</span> (' + (r.stageProgress || 'N/A') + ')</div>' +
      '<div>Elapsed: ' + (r.elapsedSeconds || 'N/A') + 's</div>' +
      '<div>RPC Latency: ' + (r.rpcLatency || 'N/A') + '</div>' +
      '<div>Retries: ' + (r.retryCount || 0) + '</div>' +
      '<div style="color:var(--red);margin-top:3px">Last Error: ' + (r.lastTimeout || r.lastRPCError || 'None') + '</div>' +
      '<div style="color:var(--blue);margin-top:3px">Suggested: ' + (r.suggestedAction || 'Check RPC and retry.') + '</div>' +
      '</div>';
  }

  /* ════════════════════════════════════════
     EXPORTS
  ════════════════════════════════════════ */
  var API = {
    TIMEOUTS: TIMEOUTS,
    wrapWithTimeout: wrapWithTimeout,
    wrapRPC: wrapRPC,
    trackStage: trackStage,
    markStageComplete: markStageComplete,
    initIntentWatchdog: initIntentWatchdog,
    isIntentStuck: isIntentStuck,
    getStuckReason: getStuckReason,
    findStuckIntents: findStuckIntents,
    generateReport: generateReport,
    runHealthCheck: runHealthCheck,
    startHealthCheck: startHealthCheck,
    stopHealthCheck: stopHealthCheck,
    isHealthCheckRunning: isHealthCheckRunning,
    buildStageProgressHTML: buildStageProgressHTML,
    buildReportHTML: buildReportHTML,
    getStageFromStatus: getStageFromStatus,
    getReports: function() { return _reports.slice(0); },
    version: '1.0.0'
  };

  if (typeof window !== 'undefined') window.ExecutionWatchdog = API;
  else if (typeof globalThis !== 'undefined') globalThis.ExecutionWatchdog = API;
})();