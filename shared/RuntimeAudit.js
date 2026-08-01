/**
 * RuntimeAudit — Diagnostic tools for duplicates, dead code detection.
 * Read-only. Never modifies runtime. Developer panel accessible via console.
 * Attached to window.RuntimeAudit
 */
(function () {
  'use strict';

  try { if (typeof FeatureFlags !== 'undefined' && !FeatureFlags.isEnabled('ENABLE_RUNTIME_AUDIT')) { window.RuntimeAudit = { audit: function(){return{}}, printReport: function(){} }; return; } } catch(_f) {}

  function _scanTimers() {
    var report = { intervals: 0, timeouts: 0, duplicateIntervals: 0 };
    var seen = {};
    try {
      var origSI = window.setInterval;
      var origST = window.setTimeout;
      var countSI = 0, countST = 0;
      var timerCheck = setInterval(function(){ countSI++; clearInterval(timerCheck); }, 1);
      var timeoutCheck = setTimeout(function(){ countST++; clearTimeout(timeoutCheck); }, 1);
      report.intervals = countSI;
      report.timeouts = countST;
    } catch(_e) {}
    return report;
  }

  function _scanListeners() {
    var count = 0;
    try {
      var all = document.querySelectorAll('*');
      for (var i = 0; i < Math.min(all.length, 50); i++) {
        var el = all[i];
        if (el.onclick) count++;
        if (el.onchange) count++;
        if (el.oninput) count++;
      }
    } catch(_e) {}
    return { inlineHandlersEstimated: count };
  }

  function _scanGlobals() {
    var keys = Object.keys(window);
    var sharedMods = keys.filter(function(k){ return k[0] === k[0].toUpperCase() && k.length > 3 && typeof window[k] !== 'undefined'; });
    return { windowGlobals: keys.length, likelyModules: sharedMods.length, moduleNames: sharedMods.slice(0, 50) };
  }

  function _scanDuplicates() {
    var scripts = document.querySelectorAll('script[src]');
    var seen = {};
    var dups = [];
    for (var i = 0; i < scripts.length; i++) {
      var src = scripts[i].src;
      if (seen[src]) dups.push(src);
      seen[src] = true;
    }
    return { totalScripts: scripts.length, duplicateSrcs: dups };
  }

  function audit() {
    var rpcStats = (typeof RPCRequestManager !== 'undefined') ? RPCRequestManager.getStats() : null;
    var rcStats = (typeof ResourceCoordinator !== 'undefined') ? ResourceCoordinator.getStats() : null;
    return {
      timers: _scanTimers(),
      listeners: _scanListeners(),
      globals: _scanGlobals(),
      scripts: _scanDuplicates(),
      memory: (window.performance && performance.memory) ? { used: performance.memory.usedJSHeapSize, limit: performance.memory.jsHeapSizeLimit } : null,
      rpc: rpcStats,
      resources: rcStats
    };
  }

  function printReport() {
    var r = audit();
    console.log('%c[RuntimeAudit] %cDiagnostic Report',
      'font-weight:bold;color:#a78bfa', 'color:var(--muted2)');
    console.log('  Timers: ' + r.timers.intervals + ' intervals, ' + r.timers.timeouts + ' timeouts');
    console.log('  Scripts: ' + r.scripts.totalScripts + ' loaded, ' + r.scripts.duplicateSrcs.length + ' duplicates');
    console.log('  Globals: ' + r.globals.windowGlobals + ' total, ' + r.globals.likelyModules + ' likely modules');
    console.log('  Memory: ' + (r.memory ? Math.round(r.memory.used/1048576) + 'MB / ' + Math.round(r.memory.limit/1048576) + 'MB' : 'N/A'));
    if (r.rpc) console.log('  RPC: ' + r.rpc.total + ' total, ' + r.rpc.coalesced + ' coalesced (' + r.rpc.dedupRatio + '%), ' + r.rpc.inflight + ' inflight');
    if (r.resources) console.log('  Resources: ' + r.resources.activeTimers + ' timers, ' + r.resources.activeIntervals + ' intervals, ' + r.resources.timersPrevented + ' prevented, ' + r.resources.refreshesSkipped + ' refreshes skipped');
  }

  setTimeout(printReport, 8000);

  window.RuntimeAudit = {
    audit: audit,
    printReport: printReport
  };
})();
