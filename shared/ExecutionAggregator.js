/**
 * Execution Aggregator & Batch Execution Layer
 * ADDITIVE module — zero modifications to existing systems.
 *
 * Groups similar pending executions INLINE in the AI Smart Wallet
 * "Executions" tab with an "Execute All" button per group.
 * Individual intents are NEVER merged — each executes independently
 * with full validation between each.
 *
 * Engines (bundled, additive):
 *   ExecutionAggregatorEngine  — detects & groups similar intents
 *   ExecutionGroupingEngine    — creates/maintains batch groups
 *   BatchExecutionEngine       — sequential execution with validation
 *   BatchSummaryEngine         — summary bar
 *   ExecutionBatchValidator    — pre-flight validation
 *
 * Attached to window.ExecutionAggregator
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'elligentt_execagg_v2';
  var state = { groups: [], lastRefresh: 0 };
  var observer = null;

  /* ── Helpers ────────────────────────────────────────────────────── */
  function $id(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtUsd(n) { return '$' + (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }); }
  var OP_LABELS = { swap: 'Swap', bridge: 'Bridge', payment: 'Payment', crosschain: 'Cross-Chain', multisend: 'Multi-Send', payroll: 'Payroll', transfer: 'Transfer', recurring: 'Recurring', treasury: 'Treasury' };

  /* ── Persistence ────────────────────────────────────────────────── */
  function load() { try { var r = localStorage.getItem(STORAGE_KEY); if (r) state = JSON.parse(r); } catch (_e) {} }
  function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_e) {} }

  /* ══════════════════════════════════════════════════════════════════
     GROUPING — ExecutionAggregatorEngine + ExecutionGroupingEngine
     ══════════════════════════════════════════════════════════════════ */
  function _sameGroup(a, b) {
    if (a.status !== 'approved' || b.status !== 'approved') return false;
    if (a.op !== b.op) return false;
    if (a.token !== b.token) return false;
    if ((a.swapToToken || '') !== (b.swapToToken || '')) return false;
    if (a.network !== b.network) return false;
    if (a.toNetwork !== b.toNetwork) return false;
    if (a.freq !== b.freq) return false;
    if (a.riskLevel !== b.riskLevel) return false;
    return true;
  }

  function buildGroups() {
    try {
      if (typeof window.AIWallet === 'undefined') return [];
      var intents = window.AIWallet.getIntents();
      if (!intents || !intents.length) return [];
      var pending = intents.filter(function (i) { return i.status === 'approved'; });
      if (!pending.length) return [];

      var assigned = {};
      var result = [];

      for (var i = 0; i < pending.length; i++) {
        if (assigned[pending[i].id]) continue;

        var group = {
          id: 'GRP-' + Date.now().toString(36),
          intents: [pending[i]],
          op: pending[i].op,
          token: pending[i].token,
          toToken: pending[i].swapToToken || null,
          network: pending[i].network,
          riskLevel: pending[i].riskLevel || 'LOW',
          totalAmount: Number(pending[i].amount) || 0,
          count: 1,
          status: 'ready',
          currentIndex: null,
          results: [],
          createdAt: Date.now()
        };
        assigned[pending[i].id] = true;

        for (var j = i + 1; j < pending.length; j++) {
          if (!assigned[pending[j].id] && _sameGroup(pending[i], pending[j])) {
            group.intents.push(pending[j]);
            group.totalAmount += Number(pending[j].amount) || 0;
            group.count = group.intents.length;
            assigned[pending[j].id] = true;
          }
        }

        result.push(group);
      }

      return result;
    } catch (_e) { return []; }
  }

  function refresh() {
    state.groups = buildGroups();
    state.lastRefresh = Date.now();
    save();
    return state.groups;
  }

  function getGroups() { return state.groups || []; }
  function getPendingGroups() { return (state.groups || []).filter(function (g) { return g.status === 'ready'; }); }
  function getRunningGroups() { return (state.groups || []).filter(function (g) { return g.status === 'running'; }); }

  /* ══════════════════════════════════════════════════════════════════
     BATCH SUMMARY — BatchSummaryEngine
     ══════════════════════════════════════════════════════════════════ */
  function getSummary() {
    var grps = state.groups || [];
    var ready = grps.filter(function (g) { return g.status === 'ready'; });
    var running = grps.filter(function (g) { return g.status === 'running'; });
    var done = grps.filter(function (g) { return g.status === 'completed' || g.status === 'partial'; });
    var batch = ready.filter(function (g) { return g.count > 1; });
    var single = ready.filter(function (g) { return g.count === 1; });
    var batchOps = batch.reduce(function (s, g) { return s + g.count; }, 0);

    return {
      pendingTotal: ready.length,
      batchGroups: batch.length,
      singleOps: single.length,
      batchOps: batchOps,
      running: running.length,
      completed: done.length,
      estSecs: ready.length * 9
    };
  }

  /* ══════════════════════════════════════════════════════════════════
     BATCH VALIDATOR — ExecutionBatchValidator (pre-flight)
     ══════════════════════════════════════════════════════════════════ */
  async function validateBatch(groupId) {
    var g = (state.groups || []).find(function (x) { return x.id === groupId; });
    if (!g) return { ok: false, error: 'Group not found' };
    var results = [];
    for (var i = 0; i < g.intents.length; i++) {
      try {
        if (window.AIWallet && window.AIWallet.validateIntent) {
          var v = await window.AIWallet.validateIntent(g.intents[i]);
          results.push({ intentId: g.intents[i].id, ok: !!(v && v.valid), checks: v ? v.checks : [] });
        } else { results.push({ intentId: g.intents[i].id, ok: true, checks: [] }); }
      } catch (e) { results.push({ intentId: g.intents[i].id, ok: false, error: e.message || String(e) }); }
    }
    return { ok: results.every(function (r) { return r.ok; }), results: results, groupId: groupId };
  }

  /* ══════════════════════════════════════════════════════════════════
     BATCH EXECUTION — BatchExecutionEngine
     ══════════════════════════════════════════════════════════════════ */
  async function executeBatch(groupId) {
    var idx = (state.groups || []).findIndex(function (g) { return g.id === groupId; });
    if (idx === -1) return { ok: false, error: 'Group not found' };
    var g = state.groups[idx];
    if (g.status === 'running') return { ok: false, error: 'Already running' };

    g.status = 'running';
    g.currentIndex = 0;
    g.results = [];
    save();
    _patchExecutions();

    var allOk = true;
    for (var i = 0; i < g.intents.length; i++) {
      g.currentIndex = i;
      save();
      _patchExecutions();

      var freshIntents = window.AIWallet ? window.AIWallet.getIntents() : [];
      var fresh = freshIntents.find(function (x) { return x.id === g.intents[i].id; });
      if (!fresh || fresh.status !== 'approved') {
        g.results.push({ intentId: g.intents[i].id, ok: false, error: 'No longer available' });
        allOk = false;
        continue;
      }

      try {
        var ok = await window.AIWallet.executeIntent(g.intents[i].id);
        g.results.push({ intentId: g.intents[i].id, ok: !!ok });
        if (!ok) allOk = false;
      } catch (e) {
        g.results.push({ intentId: g.intents[i].id, ok: false, error: e.message || String(e) });
        allOk = false;
      }

      if (i < g.intents.length - 1) {
        await new Promise(function (r) { setTimeout(r, 1500); });
      }
    }

    g.status = allOk ? 'completed' : 'partial';
    g.currentIndex = null;
    save();
    _patchExecutions();

    try { if (window.AIWallet.onShow) window.AIWallet.onShow(); } catch (_e) {}
    return { ok: allOk, results: g.results, groupId: groupId };
  }

  function cancelBatch(groupId) {
    var idx = (state.groups || []).findIndex(function (g) { return g.id === groupId; });
    if (idx === -1) return;
    var g = state.groups[idx];
    if (g.status === 'running') return;

    for (var i = 0; i < g.intents.length; i++) {
      try { if (window.AIWallet.cancelIntent) window.AIWallet.cancelIntent(g.intents[i].id); } catch (_e) {}
    }
    g.status = 'cancelled';
    save();
    _patchExecutions();
    try { if (window.AIWallet.onShow) window.AIWallet.onShow(); } catch (_e) {}
  }

  /* ══════════════════════════════════════════════════════════════════
     INLINE UI INJECTION — Patches the Executions panel after each render
     WITHOUT modifying AIWallet source code.
     ══════════════════════════════════════════════════════════════════ */
  function _renderGroupCard(g) {
    var opLabel = OP_LABELS[g.op] || g.op;
    var running = g.status === 'running';
    var done = g.status === 'completed' || g.status === 'partial';
    var cancelled = g.status === 'cancelled';

    var statusHtml = '';
    if (running) statusHtml = '<span class="chip" style="border:1px solid var(--border);color:var(--yellow)">Executing ' + ((g.currentIndex||0)+1) + '/' + g.count + '</span>';
    else if (done) statusHtml = '<span class="chip" style="border:1px solid var(--border);color:' + (g.status==='completed'?'var(--green)':'var(--yellow)') + '">' + (g.status==='completed'?'Done':'Partial') + '</span>';
    else if (cancelled) statusHtml = '<span class="chip" style="border:1px solid var(--border);color:var(--red)">Cancelled</span>';
    else statusHtml = '<span class="chip" style="border:1px solid var(--border);color:var(--blue)">Ready</span>';

    var riskColor = g.riskLevel === 'HIGH' ? 'var(--red)' : g.riskLevel === 'MEDIUM' ? 'var(--yellow)' : 'var(--green)';

    var progress = '';
    if (running && g.count > 0) {
      var pct = Math.round(((g.currentIndex||0) / g.count) * 100);
      progress = '<div style="margin-top:5px;height:3px;background:var(--border);border-radius:2px;overflow:hidden"><div style="height:100%;width:' + pct + '%;background:var(--purple)"></div></div>';
    }

    var resultsHtml = '';
    if (done && g.results && g.results.length) {
      var okN = g.results.filter(function(r){return r.ok;}).length;
      var failN = g.results.filter(function(r){return !r.ok;}).length;
      resultsHtml = '<div style="font-size:8.5px;margin-top:4px;color:' + (failN?'var(--red)':'var(--green)') + '">' + okN + '/' + g.count + ' succeeded' + (failN?' · ' + failN + ' failed':'') + '</div>';
    }

    var intentList = '<div style="margin-top:5px;font-size:8px;color:var(--muted2)">' +
      g.intents.map(function(it, i) {
        var mark = '';
        if (g.results && g.results[i]) mark = g.results[i].ok ? ' <span style="color:var(--green)">&#x2713;</span>' : ' <span style="color:var(--red)">&#x2717;</span>';
        else if (running && g.currentIndex !== null && i < g.currentIndex) mark = ' <span style="color:var(--green)">&#x2713;</span>';
        else if (running && i === g.currentIndex) mark = ' <span style="color:var(--yellow)">&#x25CF;</span>';
        return '<span style="color:var(--muted2)">#' + (i+1) + '</span> ' + esc(String(it.amount)) + ' ' + esc(it.token) + mark + (i < g.intents.length-1 ? ' · ' : '');
      }).join('') + '</div>';

    var actions = '';
    if (!running && !done && !cancelled) {
      actions = '<div style="display:flex;gap:6px;margin-top:8px">' +
        '<button class="btn primary" style="font-size:8.5px;padding:3px 10px" onclick="ExecutionAggregator.executeBatch(\'' + esc(g.id) + '\')"><i class="ti ti-stack-2"></i>Execute All (' + g.count + ')</button>' +
        '<button class="btn" style="font-size:8.5px;padding:3px 10px;border-color:rgba(239,68,68,.4);color:var(--red)" onclick="ExecutionAggregator.cancelBatch(\'' + esc(g.id) + '\')">Cancel All</button></div>';
    }

    return '<div style="border:1px solid ' + (running?'rgba(167,139,250,.4)':'var(--border)') + ';border-radius:7px;padding:9px;margin-bottom:7px;background:rgba(0,0,0,.15)">' +
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
      '<span style="font-size:10px;font-weight:700;color:var(--text)">' + esc(opLabel) + ' Batch</span>' +
      statusHtml +
      '<span style="font-size:9px;color:var(--muted2)">' + g.count + ' ops</span>' +
      '<span style="margin-left:auto;font-size:9px;font-weight:600;color:var(--text)">Total: ' + esc(String(g.totalAmount)) + ' ' + esc(g.token) + '</span>' +
      '<span style="font-size:8px;color:' + riskColor + '">' + esc(g.riskLevel) + '</span></div>' +
      progress + resultsHtml + intentList + actions + '</div>';
  }

  /** Injects batch group cards at the TOP of the pending executions section */
  function _patchExecutions() {
    var pend = $id('aiw-pending-body');
    if (!pend) return;

    // Remove any previously injected batch cards
    var oldBatches = pend.querySelectorAll('.ea-batch-card');
    for (var b = 0; b < oldBatches.length; b++) oldBatches[b].remove();
    var oldSummary = pend.querySelector('.ea-summary-bar');
    if (oldSummary) oldSummary.remove();

    refresh();

    var summary = getSummary();
    // Only inject if there are batches or pending items
    if (summary.pendingTotal === 0 && summary.running === 0 && summary.completed === 0) return;

    var groups = state.groups || [];
    var readyGroups = groups.filter(function (g) { return g.status === 'ready'; });
    var runningGroups = groups.filter(function (g) { return g.status === 'running'; });

    var html = '';

    // Summary bar
    if (summary.pendingTotal > 0) {
      html += '<div class="ea-summary-bar" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:8px 10px;margin-bottom:8px;background:rgba(167,139,250,.06);border:1px solid rgba(167,139,250,.2);border-radius:6px;font-size:9px">' +
        '<span style="color:var(--text);font-weight:600"><i class="ti ti-stack-2" style="color:var(--purple);margin-right:4px"></i>Batch Executions</span>' +
        (summary.batchGroups > 0 ? '<span style="color:var(--purple)">' + summary.batchGroups + ' group' + (summary.batchGroups>1?'s':'') + '</span>' : '') +
        (summary.batchOps > 0 ? '<span style="color:var(--blue)">' + summary.batchOps + ' ops batchable</span>' : '') +
        (summary.singleOps > 0 ? '<span style="color:var(--muted2)">+ ' + summary.singleOps + ' individual</span>' : '') +
        '<span style="color:var(--muted2);margin-left:auto">~' + summary.estSecs + 's est.</span></div>';
    }

    // Running batches
    if (runningGroups.length) {
      for (var r = 0; r < runningGroups.length; r++) {
        html += '<div class="ea-batch-card">' + _renderGroupCard(runningGroups[r]) + '</div>';
      }
    }

    // Ready groups (multi-item batches first, then singles)
    var batchReady = readyGroups.filter(function (g) { return g.count > 1; });
    for (var bg = 0; bg < batchReady.length; bg++) {
      html += '<div class="ea-batch-card">' + _renderGroupCard(batchReady[bg]) + '</div>';
    }

    // Insert at the top of the pending panel
    if (html) {
      pend.insertAdjacentHTML('afterbegin', html);
    }
  }

  /* ══════════════════════════════════════════════════════════════════
     INIT — Observe the executions panel for renders
     ══════════════════════════════════════════════════════════════════ */
  function init() {
    load();

    function tryObserve() {
      if (!window.AIWallet) { setTimeout(tryObserve, 500); return; }
      var pend = $id('aiw-pending-body');
      if (!pend) { setTimeout(tryObserve, 500); return; }

      // Patch after every DOM change in the pending panel
      if (observer) observer.disconnect();
      observer = new MutationObserver(function () {
        // Debounce — wait for render to settle
        clearTimeout(observer._timer);
        observer._timer = setTimeout(function () { _patchExecutions(); }, 200);
      });
      observer.observe(pend, { childList: true, subtree: true });

      // Initial patch
      setTimeout(function () { _patchExecutions(); }, 800);

      // Periodic refresh every 20s
      setInterval(function () {
        var pg = $id('page-aiwallet');
        if (pg && pg.classList.contains('active')) _patchExecutions();
      }, 20000);
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { setTimeout(tryObserve, 600); });
    } else {
      setTimeout(tryObserve, 400);
    }
  }

  init();

  /* ══════════════════════════════════════════════════════════════════
     PUBLIC API
     ══════════════════════════════════════════════════════════════════ */
  window.ExecutionAggregator = {
    refresh: refresh,
    getGroups: getGroups,
    getPendingGroups: getPendingGroups,
    getRunningGroups: getRunningGroups,
    getSummary: getSummary,
    executeBatch: executeBatch,
    cancelBatch: cancelBatch,
    validateBatch: validateBatch,
    version: '1.0.0'
  };
})();
