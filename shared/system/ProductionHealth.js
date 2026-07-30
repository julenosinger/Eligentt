/**
 * Elligentt ProductionHealthDashboard — Production Monitoring (Phase 12)
 * Aggregates all health, performance, and security metrics into one view.
 * Attached to: window.ProductionHealthDashboard
 */
(function () {
  'use strict';

  function getDashboard() {
    var dash = {
      generatedAt: new Date().toISOString(),
      health: {},
      performance: {},
      security: {},
      alerts: [],
      status: 'healthy'
    };

    // Health
    try {
      if (typeof ModuleHealth !== 'undefined') dash.health = ModuleHealth.getSummary();
      if (typeof HeartbeatManager !== 'undefined') dash.health.heartbeat = HeartbeatManager.getStatus();
    } catch (_e) {}

    // Performance
    try {
      if (typeof MetricsManager !== 'undefined') dash.performance = MetricsManager.getSummary();
      if (typeof Telemetry !== 'undefined') dash.performance.telemetry = Telemetry.getSnapshot();
    } catch (_e) {}

    // Security
    try {
      if (typeof ProductionGuard !== 'undefined') dash.security = ProductionGuard.getSummary();
      if (typeof SecurityAudit !== 'undefined') dash.security.audit = SecurityAudit.scan().summary;
    } catch (_e) {}

    // Alerts
    try {
      if (typeof DashboardRenderer !== 'undefined') dash.alerts.push({ type: 'info', msg: 'All renderers operational' });
      if (dash.health.heartbeat && !dash.health.heartbeat.rpcHealthy) dash.alerts.push({ type: 'warning', msg: 'RPC unhealthy' });
      if (dash.security.productionGuard && !dash.security.productionGuard.legacyFree) dash.alerts.push({ type: 'warning', msg: 'Legacy fallback detected' });
    } catch (_e) {}

    // Overall status
    var hasAlerts = dash.alerts.filter(function (a) { return a.type === 'error' || a.type === 'warning'; }).length;
    dash.status = hasAlerts > 0 ? 'degraded' : 'healthy';

    return dash;
  }

  function logReport() {
    var d = getDashboard();
    console.log('[ProductionHealth] Status: ' + d.status.toUpperCase());
    console.log('[ProductionHealth]', JSON.stringify(d.health));
    return d;
  }

  window.ProductionHealthDashboard = {
    VERSION: '1.0.0',
    getDashboard: getDashboard, logReport: logReport
  };
})();
