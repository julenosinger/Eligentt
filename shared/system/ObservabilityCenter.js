/**
 * Elligentt ObservabilityCenter — Unified Production Dashboard (Phase 17.6)
 * Module health, execution latency, failed ops, RPC health, queue, agent metrics.
 * Attached to: window.ObservabilityCenter
 */
(function () {
  'use strict';

  function getDashboard() {
    var dash = {
      generatedAt: new Date().toISOString(),
      modules: {},
      executions: {},
      rpc: {},
      queues: {},
      agents: {},
      storage: {},
      status: 'healthy'
    };

    try { if (typeof ModuleHealth !== 'undefined') dash.modules = ModuleHealth.getSummary(); } catch (_e) {}
    try { if (typeof MetricsManager !== 'undefined') dash.executions = MetricsManager.getSummary(); } catch (_e2) {}
    try { if (typeof RPCService !== 'undefined') dash.rpc = RPCService.getMetrics(); } catch (_e3) {}
    try { if (typeof QueueManager !== 'undefined') dash.queues = QueueManager.getAllStats(); } catch (_e4) {}
    try { if (typeof AgentManager !== 'undefined') dash.agents = { count: AgentManager.getCount(), metrics: AgentManager.getAllMetrics() }; } catch (_e5) {}
    try { if (typeof CacheManager !== 'undefined') dash.storage = CacheManager.getAllMetrics(); } catch (_e6) {}
    try { if (typeof HeartbeatManager !== 'undefined') dash.heartbeat = HeartbeatManager.getStatus(); } catch (_e7) {}
    try { if (typeof ResourceManager !== 'undefined') dash.resources = ResourceManager.getSnapshot(); } catch (_e8) {}

    // Determine status
    var hasIssues = false;
    try { if (dash.heartbeat && !dash.heartbeat.rpcHealthy) hasIssues = true; } catch (_e) {}
    try { if (dash.executions && dash.executions.failedExecutions > 5) hasIssues = true; } catch (_e) {}
    try { if (dash.modules && dash.modules.error > 0) hasIssues = true; } catch (_e) {}

    dash.status = hasIssues ? 'degraded' : 'healthy';
    return dash;
  }

  function logDashboard() {
    var d = getDashboard();
    console.log('[Observability] Status: ' + d.status.toUpperCase());
    console.log('[Observability] Modules: ' + JSON.stringify(d.modules));
    console.log('[Observability] RPC: ' + JSON.stringify(d.rpc));
    return d;
  }

  window.ObservabilityCenter = {
    VERSION: '17.0.0',
    getDashboard: getDashboard, logDashboard: logDashboard
  };
})();
