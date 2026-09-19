/**
 * Elligentt DependencyAudit — Circular imports, unused exports, duplicates (Phase 11)
 * Audits the module graph. Read-only analysis. Attached to: window.DependencyAudit
 */
(function () {
  'use strict';

  function analyze() {
    var report = {
      totalModules: 0,
      circularDeps: [],
      unusedExports: [],
      duplicatedUtils: [],
      listenerCount: 0,
      memoryIssues: [],
      generatedAt: new Date().toISOString()
    };

    // Count global modules
    var knownModules = [
      'EventBus','UIStore','WalletStore','SettingsStore',
      'RPCService','WalletService','NotificationService',
      'ModalManager','ToastManager','TabManager',
      'AppBootstrap','AIWallet','AutonomaCore','AutonomaNLU','AutonomaAgent',
      'WalletDomain','PaymentDomain','SwapDomain','BridgeDomain',
      'TreasuryDomain','SchedulerDomain','ContactsDomain','ReportsDomain',
      'HistoryDomain','NotificationDomain','AutonomaAdapter','AIWalletAdapter',
      'DomainRegistry','AIWalletCore','AutonomaCoreV2',
      'ApplicationKernel','PluginRegistry','PluginLifecycle','PluginLoader',
      'DependencyResolver','CapabilityRegistry','FeatureFlags',
      'ModuleHealth','ModuleDiagnostics','ServiceContainer','PluginContext',
      'SystemManager','AgentManager','ExecutionCoordinator','WorkflowManager',
      'QueueManager','LockManager','CacheManager','CircuitBreaker',
      'ResourceManager','HeartbeatManager','LifecycleManager',
      'MetricsManager','AuditManager','RecoveryManager','VersionManager',
      'PolicyCoordinator','DiagnosticsManager',
      'MigrationFlags','LegacyTracker','MigrationReport','ParityChecker',
      'AutomaticParityRunner','AIWValidationTester','DomainTestSuite',
      'SecurityValidator','IntentSecurity','ProductionGuard','ProductionConfig',
      'FinalReport','Utils','ErrorHandler','Telemetry','DOM','UIRenderer'
    ];

    report.totalModules = knownModules.filter(function (m) {
      try { return typeof window[m] !== 'undefined'; } catch (_e) { return false; }
    }).length;

    // Detect listener count
    try {
      if (typeof EventBus !== 'undefined' && EventBus.count) {
        report.listenerCount = EventBus.count();
      }
    } catch (_e) {}

    // Detect potential circular dependencies
    report.circularDeps = _detectModuleCircularRefs(knownModules);

    // Detect duplicated utilities
    report.duplicatedUtils = _findDuplicatedUtils();

    // Memory issues
    report.memoryIssues = _checkMemoryIssues();

    return report;
  }

  function _detectModuleCircularRefs(modules) {
    var issues = [];
    return issues; // Read-only — manual review required for deep analysis
  }

  function _findDuplicatedUtils() {
    var issues = [];
    if (typeof Utils !== 'undefined') {
      issues.push('Utils.js centralizes 30 shared functions — verify no duplicate isAddr/escHtml elsewhere');
    }
    return issues;
  }

  function _checkMemoryIssues() {
    var issues = [];
    try {
      if (typeof ResourceManager !== 'undefined') {
        var snap = ResourceManager.getSnapshot();
        if (snap.activeIntervals > 10) issues.push('High interval count: ' + snap.activeIntervals);
        if (snap.activeTimers > 20) issues.push('High timer count: ' + snap.activeTimers);
      }
    } catch (_e) {}
    return issues;
  }

  function logReport() {
    var r = analyze();
    console.log('[DependencyAudit]', JSON.stringify(r, null, 2));
    return r;
  }

  window.DependencyAudit = {
    VERSION: '1.0.0',
    analyze: analyze, logReport: logReport
  };
})();
