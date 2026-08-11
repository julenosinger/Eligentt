/**
 * Elligentt SystemManager — Global System Orchestrator (Phase 6)
 *
 * The single entry point for the system layer. Coordinates all enterprise modules:
 * - AgentManager: multi-agent registration
 * - ExecutionCoordinator: deduplication, trace IDs
 * - WorkflowManager: workflow orchestration
 * - QueueManager: priority task queue
 * - LockManager: concurrency control
 * - CacheManager: centralized caching
 * - CircuitBreaker: RPC/external API protection
 * - ResourceManager: memory/timer tracking
 * - HeartbeatManager: platform health pulse
 * - LifecycleManager: global lifecycle state
 * - MetricsManager: enterprise metrics
 * - AuditManager: immutable audit trail
 * - RecoveryManager: self-healing
 * - VersionManager: module compatibility
 * - PolicyCoordinator: platform policies
 * - DiagnosticsManager: enterprise diagnostics
 *
 * Contains ZERO business logic. Only orchestration.
 *
 * Attached to: window.SystemManager
 *
 * @module systemManager
 * @version 1.0.0
 */
(function () {
  'use strict';

  var VERSION = '1.0.0';
  var _booted = false;

  var _modules = [
    { key: 'lockManager',        api: 'LockManager',        init: null },
    { key: 'cacheManager',       api: 'CacheManager',       init: null },
    { key: 'circuitBreaker',     api: 'CircuitBreaker',     init: null },
    { key: 'queueManager',       api: 'QueueManager',       init: null },
    { key: 'agentManager',       api: 'AgentManager',       init: null },
    { key: 'executionCoordinator', api: 'ExecutionCoordinator', init: null },
    { key: 'workflowManager',    api: 'WorkflowManager',    init: null },
    { key: 'resourceManager',    api: 'ResourceManager',    init: null },
    { key: 'heartbeatManager',   api: 'HeartbeatManager',   init: 'start' },
    { key: 'lifecycleManager',   api: 'LifecycleManager',   init: 'boot' },
    { key: 'metricsManager',     api: 'MetricsManager',     init: null },
    { key: 'auditManager',       api: 'AuditManager',       init: null },
    { key: 'recoveryManager',    api: 'RecoveryManager',    init: null },
    { key: 'versionManager',     api: 'VersionManager',     init: null },
    { key: 'policyCoordinator',  api: 'PolicyCoordinator',  init: null },
    { key: 'diagnosticsManager', api: 'DiagnosticsManager', init: null }
  ];

  function boot() {
    if (_booted) { console.warn('[SystemManager] Already booted'); return; }
    _booted = true;

    if (typeof LifecycleManager !== 'undefined') LifecycleManager.setState('booting');

    var t0 = performance.now();
    console.log('[SystemManager] Booting System Layer v' + VERSION + '...');

    var ok = 0, failed = 0;
    for (var i = 0; i < _modules.length; i++) {
      var m = _modules[i];
      var mod;
      try { mod = m.api ? (typeof window[m.api] !== 'undefined' ? window[m.api] : null) : null; } catch (_e) { mod = null; }
      if (!mod) { failed++; continue; }
      if (m.init && typeof mod[m.init] === 'function') {
        try { mod[m.init](); } catch (e) { console.warn('[SystemManager] Init failed for ' + m.api + ':', e.message); failed++; continue; }
      }
      ok++;
    }

    // Start heartbeat
    try { if (typeof HeartbeatManager !== 'undefined') HeartbeatManager.start(15000); } catch (_e) {}

    var totalMs = performance.now() - t0;
    try { if (typeof MetricsManager !== 'undefined') MetricsManager.record('startupMs', Math.round(totalMs)); } catch (_e2) {}
    try { if (typeof Telemetry !== 'undefined') Telemetry.setInitTime(Math.round(totalMs)); } catch (_e3) {}

    console.log('[SystemManager] System Layer ready — ' + ok + '/' + _modules.length + ' modules (' + totalMs.toFixed(1) + 'ms)');

    if (typeof LifecycleManager !== 'undefined') LifecycleManager.setState('running');
    try { if (typeof EventBus !== 'undefined') EventBus.emit('SYSTEM_LAYER_READY', { modules: ok, totalMs: Math.round(totalMs) }); } catch (_e4) {}
  }

  function getReport() {
    try { if (typeof DiagnosticsManager !== 'undefined') return DiagnosticsManager.generateReport(); } catch (_e) {}
    return null;
  }

  function getStatus() {
    return {
      booted: _booted,
      version: VERSION,
      lifecycleState: typeof LifecycleManager !== 'undefined' ? LifecycleManager.getState() : 'unknown',
      heartbeat: typeof HeartbeatManager !== 'undefined' ? HeartbeatManager.getStatus() : null,
      resources: typeof ResourceManager !== 'undefined' ? ResourceManager.getSnapshot() : null
    };
  }

  window.SystemManager = {
    VERSION: VERSION,
    boot: boot, getReport: getReport, getStatus: getStatus
  };
})();
