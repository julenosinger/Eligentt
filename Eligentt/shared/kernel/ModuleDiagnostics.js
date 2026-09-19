/**
 * Elligentt ModuleDiagnostics — Plugin Diagnostics Reporter (Phase 5)
 * Reports: startup time, listener count, RPC usage, errors, warnings.
 * Attached to: window.ModuleDiagnostics
 */
(function () {
  'use strict';

  function getDiagnostics() {
    var report = {
      generatedAt: new Date().toISOString(),
      plugins: {}
    };

    try {
      if (typeof PluginRegistry !== 'undefined') {
        var plugins = PluginRegistry.getAll();
        for (var i = 0; i < plugins.length; i++) {
          var p = plugins[i];
          var diag = {};
          try { if (typeof p.diagnostics === 'function') diag = p.diagnostics(); } catch (_e) {}
          try { if (typeof PluginLifecycle !== 'undefined') diag.lifecycleState = PluginLifecycle.getState(p.id); } catch (_e2) {}
          try { if (typeof ModuleHealth !== 'undefined') diag.health = ModuleHealth.getHealth(p.id); } catch (_e3) {}
          report.plugins[p.id] = diag;
        }
      }
    } catch (_e) {}

    try {
      if (typeof EventBus !== 'undefined') {
        report.eventBus = { listenerCount: typeof EventBus.count === 'function' ? EventBus.count() : 'unknown', events: typeof EventBus.events === 'function' ? EventBus.events() : [] };
      }
    } catch (_e2) {}

    try {
      if (typeof Telemetry !== 'undefined') { report.telemetry = Telemetry.getSnapshot(); }
    } catch (_e3) {}

    try {
      if (typeof FeatureFlags !== 'undefined') { report.featureFlags = FeatureFlags.getAll(); }
    } catch (_e4) {}

    try {
      if (typeof AppBootstrap !== 'undefined') { report.bootstrap = AppBootstrap.getReport(); }
    } catch (_e5) {}

    return report;
  }

  function logReport() {
    var report = getDiagnostics();
    console.log('[ModuleDiagnostics] Full report:', JSON.stringify(report, null, 2));
    return report;
  }

  /** Get a human-readable summary */
  function getSummary() {
    var d = getDiagnostics();
    return {
      pluginCount: Object.keys(d.plugins).length,
      eventBusListeners: d.eventBus ? d.eventBus.listenerCount : 0,
      bootstrapTimeMs: d.bootstrap ? d.bootstrap.totalTime : 0,
      rpcCalls: d.telemetry ? d.telemetry.rpcCalls : 0,
      errors: d.telemetry ? d.telemetry.errors : 0
    };
  }

  window.ModuleDiagnostics = {
    VERSION: '1.0.0',
    getDiagnostics: getDiagnostics, logReport: logReport, getSummary: getSummary
  };
})();
