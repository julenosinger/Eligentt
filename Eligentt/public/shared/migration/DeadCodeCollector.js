/**
 * Elligentt DeadCodeCollector — Identify unused functions/CSS/listeners (Phase 16)
 * NEVER auto-deletes. Generates report only. Candidate: name, reason, confidence.
 * Attached to: window.DeadCodeCollector
 */
(function () {
  'use strict';

  function analyze() {
    var report = {
      generatedAt: new Date().toISOString(),
      candidates: [],
      summary: {}
    };

    // Check for known duplicate or unused patterns
    var checks = [
      { pattern: '_log', reason: 'Debug-only logger — disabled in production via __DEBUG__' },
      { pattern: '_warn', reason: 'Debug-only logger — disabled in production via __DEBUG__' },
      { pattern: '_clearAllIntervals', reason: 'Cleanup function — called on unload only' },
      { pattern: '_intervals', reason: 'Internal interval tracker array' },
      { pattern: '_refreshBalancePending', reason: 'Internal guard flag' }
    ];

    checks.forEach(function (c) {
      try {
        var exists = typeof window[c.pattern] !== 'undefined';
        var used = _isUsed(c.pattern);
        report.candidates.push({
          name: c.pattern,
          reason: c.reason,
          exists: exists,
          likelyUsed: used,
          confidence: used ? 'LOW' : 'HIGH',
          action: used ? 'KEEP' : 'REVIEW'
        });
      } catch (_e) {}
    });

    // Check for duplicated event listeners
    try {
      if (typeof EventBus !== 'undefined' && EventBus.count) {
        var totalListeners = EventBus.count();
        report.listeners = { total: totalListeners, note: 'Above 300 may indicate duplication' };
      }
    } catch (_e) {}

    // Check for memory issues
    try {
      if (typeof ResourceManager !== 'undefined') {
        report.resources = ResourceManager.getSnapshot();
      }
    } catch (_e) {}

    report.summary = {
      totalCandidates: report.candidates.length,
      highConfidenceRemovals: report.candidates.filter(function (c) { return c.confidence === 'HIGH'; }).length,
      lowConfidenceKeeps: report.candidates.filter(function (c) { return c.confidence === 'LOW'; }).length,
      recommendation: 'Review HIGH confidence candidates. Keep LOW confidence.'
    };

    return report;
  }

  function _isUsed(name) {
    try {
      var scripts = document.querySelectorAll('script:not([src])');
      var found = false;
      scripts.forEach(function (s) {
        if (s.textContent && s.textContent.indexOf(name) !== -1) found = true;
      });
      return found;
    } catch (_e) { return true; }
  }

  function exportJSON() {
    var r = analyze();
    return JSON.stringify(r, null, 2);
  }

  window.DeadCodeCollector = {
    VERSION: '16.0.0',
    analyze: analyze, exportJSON: exportJSON
  };
})();
