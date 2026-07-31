/**
 * Elligentt LegacyPurgeEngine — Phase 20 Legacy Purge Analysis & Classification
 *
 * Analyzes legacy functions, compatibility wrappers, migration adapters,
 * window globals, event handlers, and deprecated APIs.
 *
 * Classifies: SAFE_REMOVE | KEEP | BLOCKED | UNKNOWN
 *
 * DOES NOT automatically delete anything.
 *
 * Attached to: window.LegacyPurgeEngine
 *
 * @module LegacyPurgeEngine
 * @version 20.0.0
 */
(function () {
  'use strict';

  function analyze() {
    return {
      version: '20.0.0',
      generatedAt: new Date().toISOString(),
      legacyFunctions: _analyzeLegacyFunctions(),
      compatibilityWrappers: _analyzeCompatibilityWrappers(),
      migrationAdapters: _analyzeMigrationAdapters(),
      windowGlobals: _analyzeWindowGlobals(),
      eventHandlers: _analyzeEventHandlers(),
      deprecatedAPIs: _analyzeDeprecatedAPIs(),
      summary: null
    };
  }

  function _analyzeLegacyFunctions() {
    var functions = [];
    try {
      if (typeof PureModularAudit !== 'undefined') {
        var audit = PureModularAudit.audit();
        functions = audit.activeCalls.concat(audit.inactiveFunctions).concat(audit.unknownCalls);
      }
    } catch (_e) {}

    if (functions.length === 0) {
      try {
        if (typeof PureExecutionGuard !== 'undefined') {
          var map = PureExecutionGuard.getBlockMap();
          Object.keys(map).forEach(function (name) {
            var exists = typeof window[name] === 'function';
            functions.push({
              name: name,
              replacement: map[name].replacement,
              domain: map[name].domain,
              existsOnWindow: exists,
              classification: exists ? 'KEEP' : 'SAFE_REMOVE'
            });
          });
        }
      } catch (_e2) {}
    }

    var safeRemove = functions.filter(function (f) { return f.classification === 'SAFE_REMOVE'; });
    var keep = functions.filter(function (f) { return f.classification === 'KEEP' || f.classification === 'BLOCKED'; });
    var unknown = functions.filter(function (f) { return f.classification === 'UNKNOWN' || !f.classification; });

    return {
      total: functions.length,
      safeRemove: safeRemove,
      safeRemoveCount: safeRemove.length,
      keep: keep,
      keepCount: keep.length,
      unknown: unknown,
      unknownCount: unknown.length
    };
  }

  function _analyzeCompatibilityWrappers() {
    var wrappers = [];
    try {
      if (typeof CoreMigrate !== 'undefined') {
        Object.keys(CoreMigrate).forEach(function (k) {
          if (k === 'VERSION') return;
          if (typeof CoreMigrate[k] === 'function') {
            var src = CoreMigrate[k].toString();
            var hasTryCatch = src.indexOf('try') !== -1 && src.indexOf('catch') !== -1;
            wrappers.push({
              name: 'CoreMigrate.' + k,
              isPure: !hasTryCatch,
              hasLegacyFallback: hasTryCatch,
              classification: hasTryCatch ? 'BLOCKED' : 'SAFE_REMOVE'
            });
          }
        });
      }
    } catch (_e) {}

    return {
      total: wrappers.length,
      pure: wrappers.filter(function (w) { return w.isPure; }).length,
      withFallback: wrappers.filter(function (w) { return w.hasLegacyFallback; }).length,
      items: wrappers
    };
  }

  function _analyzeMigrationAdapters() {
    var adapters = [];
    try {
      if (typeof CoreMigrate !== 'undefined') {
        adapters.push({ name: 'CoreMigrate', version: CoreMigrate.VERSION || 'unknown' });
      }
      if (typeof LegacyTracker !== 'undefined') {
        adapters.push({ name: 'LegacyTracker', active: true });
      }
      if (typeof MigrationFlags !== 'undefined') {
        adapters.push({ name: 'MigrationFlags', active: true });
      }
    } catch (_e) {}
    return { total: adapters.length, items: adapters };
  }

  function _analyzeWindowGlobals() {
    try {
      if (typeof GlobalRegistryV2 !== 'undefined') {
        return GlobalRegistryV2.auditGlobals();
      }
    } catch (_e) {}
    return { violations: [], violationCount: 0 };
  }

  function _analyzeEventHandlers() {
    var report = { onclick: 0, onchange: 0, oninput: 0, onkeyup: 0, onsubmit: 0, total: 0 };
    try {
      ['onclick','onchange','oninput','onkeyup','onsubmit'].forEach(function (attr) {
        report[attr] = document.querySelectorAll('[' + attr + ']').length;
      });
      report.total = report.onclick + report.onchange + report.oninput + report.onkeyup + report.onsubmit;
    } catch (_e) {}
    return report;
  }

  function _analyzeDeprecatedAPIs() {
    var apis = [];
    try {
      if (typeof CoreMigrate !== 'undefined') {
        var v = CoreMigrate.VERSION || 'unknown';
        if (v !== '19.0.0' && v !== '20.0.0') {
          apis.push({ name: 'CoreMigrate', version: v, status: 'OLD_VERSION — should be v19+' });
        }
      }
    } catch (_e) {}
    return { total: apis.length, items: apis };
  }

  function generateReport() {
    var a = analyze();
    a.summary = {
      totalLegacyFunctions: a.legacyFunctions.total,
      safeToRemove: a.legacyFunctions.safeRemoveCount,
      keepOrBlocked: a.legacyFunctions.keepCount,
      unknown: a.legacyFunctions.unknownCount,
      compatibilityWrappersTotal: a.compatibilityWrappers.total,
      compatibilityWithFallback: a.compatibilityWrappers.withFallback,
      inlineHandlers: a.eventHandlers.total,
      windowGlobals: a.windowGlobals.violationCount,
      deprecatedAPIs: a.deprecatedAPIs.total,
      canPurge: a.legacyFunctions.unknownCount === 0 && a.compatibilityWrappers.withFallback === 0
    };
    return a;
  }

  function quickReport() {
    var a = analyze();
    a.summary = {
      totalLegacyFunctions: a.legacyFunctions.total,
      safeToRemove: a.legacyFunctions.safeRemoveCount,
      keepOrBlocked: a.legacyFunctions.keepCount,
      unknown: a.legacyFunctions.unknownCount,
      inlineHandlers: a.eventHandlers.total,
      canPurge: a.legacyFunctions.unknownCount === 0
    };
    return a.summary;
  }

  function getSafeToRemove() {
    return analyze().legacyFunctions.safeRemove;
  }

  function getBlockedFunctions() {
    return analyze().legacyFunctions.keep;
  }

  window.LegacyPurgeEngine = {
    VERSION: '20.0.0',
    analyze: analyze,
    generateReport: generateReport,
    quickReport: quickReport,
    getSafeToRemove: getSafeToRemove,
    getBlockedFunctions: getBlockedFunctions
  };
})();
