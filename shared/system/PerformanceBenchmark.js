/**
 * Elligentt PerformanceBenchmark — Phase 20 Performance Scoring
 *
 * Benchmarks: startup, page load, module initialization, event routing,
 * store access, render times, memory usage, global registry access,
 * cache hits, and listener counts.
 *
 * Score: A+ | A | B | C
 *
 * Attached to: window.PerformanceBenchmark
 *
 * @module PerformanceBenchmark
 * @version 20.0.0
 */
(function () {
  'use strict';

  function run() {
    var b = {};
    b.version = '20.0.0';
    b.timestamp = new Date().toISOString();

    b.startup = _benchStartup();
    b.pageLoad = _benchPageLoad();
    b.modules = _benchModules();
    b.eventRouting = _benchEventRouting();
    b.storeAccess = _benchStoreAccess();
    b.renderTimes = _benchRenderTimes();
    b.memory = _benchMemory();
    b.globalRegistry = _benchGlobalRegistry();
    b.listeners = _benchListeners();
    b.cacheUsage = _benchCacheUsage();
    b.intervals = _benchIntervals();

    b.score = _calculateScore(b);
    b.scoreLabel = _scoreLabel(b.score);

    return b;
  }

  function _benchStartup() {
    var result = { ms: 0, grade: 'N/A' };
    try {
      if (typeof performance !== 'undefined') {
        var nav = performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
        if (nav) {
          result.ms = Math.round(nav.domContentLoadedEventEnd - nav.fetchStart);
          result.grade = result.ms < 2000 ? 'A+' : result.ms < 4000 ? 'A' : result.ms < 8000 ? 'B' : 'C';
        }
      }
    } catch (_e) {}
    return result;
  }

  function _benchPageLoad() {
    var result = { ms: 0, grade: 'N/A' };
    try {
      if (typeof performance !== 'undefined') {
        var nav = performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
        if (nav) {
          result.ms = Math.round(nav.loadEventEnd - nav.fetchStart);
          result.grade = result.ms < 3000 ? 'A+' : result.ms < 5000 ? 'A' : result.ms < 10000 ? 'B' : 'C';
        }
      }
    } catch (_e) {}
    return result;
  }

  function _benchModules() {
    var result = { count: 0, loadTimeMs: 0, grade: 'N/A' };
    try {
      var modules = ['EventBus','RuntimeMode','PureExecutionGuard','CoreMigrate','WalletStore','PaymentStore','SwapStore','UIStore','SettingsStore','AIWalletStore','AutonomaStore','PoolStore','SwapPage','BridgePage','WalletPage','PaymentsPage','SchedulerPage','TreasuryPage','AutonomaPage','ContactsPage','ReportsPage','HistoryPage','InvoicesPage','PayLinksPage','PoolPage','XChainPage','AIWalletRuntime'];
      result.count = modules.filter(function (m) { return typeof window[m] !== 'undefined'; }).length;
      result.grade = result.count >= 20 ? 'A+' : result.count >= 15 ? 'A' : result.count >= 10 ? 'B' : 'C';
    } catch (_e) {}
    return result;
  }

  function _benchEventRouting() {
    var result = { listeners: 0, events: 0, grade: 'N/A' };
    try {
      if (typeof EventBus !== 'undefined') {
        result.listeners = EventBus.count ? EventBus.count() : 0;
        result.events = EventBus.events ? EventBus.events().length : 0;
        result.grade = result.listeners < 200 ? 'A+' : result.listeners < 500 ? 'A' : result.listeners < 1000 ? 'B' : 'C';
      }
    } catch (_e) {}
    return result;
  }

  function _benchStoreAccess() {
    var result = { stores: 0, grade: 'N/A' };
    try {
      var stores = ['WalletStore','PaymentStore','SwapStore','PoolStore','UIStore','SettingsStore','AIWalletStore','AutonomaStore'];
      result.stores = stores.filter(function (s) { return typeof window[s] !== 'undefined'; }).length;
      result.grade = result.stores >= 7 ? 'A+' : result.stores >= 5 ? 'A' : result.stores >= 3 ? 'B' : 'C';
    } catch (_e) {}
    return result;
  }

  function _benchRenderTimes() {
    var result = { domReadyMs: 0, loadMs: 0, grade: 'N/A' };
    try {
      if (typeof performance !== 'undefined') {
        var nav = performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
        if (nav) {
          result.domReadyMs = Math.round(nav.domContentLoadedEventEnd - nav.domContentLoadedEventStart);
          result.loadMs = Math.round(nav.loadEventEnd - nav.loadEventStart);
        }
      }
      result.grade = result.domReadyMs < 500 ? 'A+' : result.domReadyMs < 1000 ? 'A' : result.domReadyMs < 2000 ? 'B' : 'C';
    } catch (_e) {}
    return result;
  }

  function _benchMemory() {
    var result = { usedMB: 0, totalMB: 0, grade: 'N/A' };
    try {
      if (typeof performance !== 'undefined' && performance.memory) {
        result.usedMB = Math.round(performance.memory.usedJSHeapSize / 1048576);
        result.totalMB = Math.round(performance.memory.totalJSHeapSize / 1048576);
        result.grade = result.usedMB < 20 ? 'A+' : result.usedMB < 50 ? 'A' : result.usedMB < 100 ? 'B' : 'C';
      }
    } catch (_e) {}
    return result;
  }

  function _benchGlobalRegistry() {
    var result = { registered: 0, violations: 0, grade: 'N/A' };
    try {
      if (typeof GlobalRegistryV2 !== 'undefined') {
        var a = GlobalRegistryV2.auditGlobals();
        result.registered = a.registeredCount || 0;
        result.violations = a.violationCount || 0;
        result.grade = result.violations < 5 ? 'A+' : result.violations < 15 ? 'A' : result.violations < 30 ? 'B' : 'C';
      }
    } catch (_e) {}
    return result;
  }

  function _benchListeners() {
    var result = { domNodes: 0, inlineHandlers: 0, grade: 'N/A' };
    try {
      var handlers = document.querySelectorAll('[onclick],[onchange],[oninput],[onsubmit]');
      result.inlineHandlers = handlers.length;
      result.grade = result.inlineHandlers === 0 ? 'A+' : result.inlineHandlers < 50 ? 'A' : result.inlineHandlers < 300 ? 'B' : 'C';
    } catch (_e) {}
    return result;
  }

  function _benchCacheUsage() {
    var result = { caches: 0, grade: 'N/A' };
    try {
      if (typeof CacheManager !== 'undefined') {
        var metrics = typeof CacheManager.getAllMetrics === 'function' ? CacheManager.getAllMetrics() : null;
        if (metrics) result.caches = Object.keys(metrics).length || 0;
        result.grade = result.caches > 0 ? 'A' : 'C';
      }
    } catch (_e) {}
    return result;
  }

  function _benchIntervals() {
    var result = { count: 0, grade: 'A+' };
    try {
      result.count = _estimateIntervals();
      result.grade = result.count < 10 ? 'A+' : result.count < 20 ? 'A' : result.count < 50 ? 'B' : 'C';
    } catch (_e) {}
    return result;
  }

  function _estimateIntervals() {
    var count = 0;
    try {
      var scripts = document.querySelectorAll('script:not([src])');
      scripts.forEach(function (s) {
        if (s.textContent) {
          var matches = s.textContent.match(/setInterval|setTimeout/g);
          if (matches) count += matches.length;
        }
      });
    } catch (_e) {}
    return count;
  }

  /* ── Scoring ───────────────────────────────────────────── */

  function _calculateScore(b) {
    var grades = [
      b.startup.grade, b.pageLoad.grade, b.modules.grade, b.eventRouting.grade,
      b.storeAccess.grade, b.renderTimes.grade, b.memory.grade, b.globalRegistry.grade,
      b.listeners.grade, b.cacheUsage.grade, b.intervals.grade
    ];

    var scores = grades.map(function (g) {
      if (g === 'A+') return 100;
      if (g === 'A')  return 85;
      if (g === 'B')  return 65;
      if (g === 'C')  return 40;
      return 50;
    }).filter(function (s) { return s > 0; });

    if (scores.length === 0) return 50;
    return Math.round(scores.reduce(function (a, b) { return a + b; }, 0) / scores.length);
  }

  function _scoreLabel(score) {
    if (score >= 95) return 'A+';
    if (score >= 80) return 'A';
    if (score >= 60) return 'B';
    return 'C';
  }

  function printReport() {
    var b = run();

    var lines = [
      '',
      '========================================',
      'PHASE 20 — PERFORMANCE BENCHMARK',
      '========================================',
      '',
      'Startup:         ' + b.startup.ms + 'ms (' + b.startup.grade + ')',
      'Page Load:       ' + b.pageLoad.ms + 'ms (' + b.pageLoad.grade + ')',
      'Modules:         ' + b.modules.count + ' loaded (' + b.modules.grade + ')',
      'Event Routing:   ' + b.eventRouting.listeners + ' listeners (' + b.eventRouting.grade + ')',
      'Stores:          ' + b.storeAccess.stores + ' available (' + b.storeAccess.grade + ')',
      'Render:          ' + b.renderTimes.domReadyMs + 'ms DOM ready (' + b.renderTimes.grade + ')',
      'Memory:          ' + b.memory.usedMB + 'MB / ' + b.memory.totalMB + 'MB (' + b.memory.grade + ')',
      'Globals:         ' + b.globalRegistry.registered + ' reg, ' + b.globalRegistry.violations + ' violations (' + b.globalRegistry.grade + ')',
      'Inline Handlers: ' + b.listeners.inlineHandlers + ' (' + b.listeners.grade + ')',
      'Cache:           ' + b.cacheUsage.caches + ' caches (' + b.cacheUsage.grade + ')',
      'Intervals:       ' + b.intervals.count + ' (' + b.intervals.grade + ')',
      '',
      'OVERALL SCORE: ' + b.scoreLabel + ' (' + b.score + '/100)',
      '',
      '========================================'
    ];

    var output = lines.join('\n');
    console.log(output);
    return output;
  }

  window.PerformanceBenchmark = {
    VERSION: '20.0.0',
    run: run,
    printReport: printReport
  };
})();
