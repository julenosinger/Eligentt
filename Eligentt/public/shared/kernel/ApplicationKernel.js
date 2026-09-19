/**
 * Elligentt ApplicationKernel — Microkernel Orchestrator (Phase 5)
 *
 * The single entry point for the application. Manages:
 * - Plugin discovery & registration
 * - Dependency validation
 * - Ordered plugin loading
 * - Health monitoring
 * - Diagnostics collection
 * - Feature flag support
 *
 * Contains ZERO business logic. Only orchestration.
 *
 * Attached to: window.ApplicationKernel
 *
 * @module applicationKernel
 * @version 1.0.0
 */
(function () {
  'use strict';

  var VERSION = '1.0.0';
  var _started = false;

  /**
   * Start the application kernel. Called once after all plugins are registered.
   * Flow: Register core services → Validate graph → Load plugins → Health check → Ready
   *
   * @param {Object} [opts]
   * @returns {{ loaded: number, failed: number, order: string[], diagnostics: Object }}
   */
  function boot(opts) {
    if (_started) {
      console.warn('[Kernel] Already booted — skipping');
      return { loaded: 0, failed: 0, order: [], diagnostics: null };
    }
    _started = true;

    var t0 = performance.now();
    console.log('[Kernel] Booting ApplicationKernel v' + VERSION + '...');

    /* 1. Register core platform services */
    _registerCoreServices();

    /* 2. Discover and register all plugins */
    _discoverPlugins();

    /* 3. Load all plugins */
    var result = { loaded: 0, failed: 0, order: [] };
    try {
      if (typeof PluginLoader !== 'undefined') {
        result = PluginLoader.loadAll();
      }
    } catch (e) {
      console.warn('[Kernel] Plugin load error:', e.message);
    }

    /* 4. Run diagnostics */
    var diagnostics = null;
    try {
      if (typeof ModuleDiagnostics !== 'undefined') {
        diagnostics = ModuleDiagnostics.getSummary();
      }
    } catch (_e) {}

    var totalTime = performance.now() - t0;
    console.log('[Kernel] Boot complete in ' + totalTime.toFixed(1) + 'ms. ' + result.loaded + ' plugins loaded.');

    try {
      if (typeof Telemetry !== 'undefined') Telemetry.setInitTime(totalTime);
    } catch (_e2) {}

    try {
      if (typeof EventBus !== 'undefined') EventBus.emit('KERNEL_BOOT_COMPLETE', { totalTime: totalTime, plugins: result, diagnostics: diagnostics });
    } catch (_e3) {}

    return { loaded: result.loaded, failed: result.failed, order: result.order, diagnostics: diagnostics };
  }

  /* Register core infrastructure as services */
  function _registerCoreServices() {
    try {
      if (typeof ServiceContainer === 'undefined') return;
      if (typeof EventBus !== 'undefined') ServiceContainer.register('eventBus', EventBus, { type: 'infrastructure' });
      if (typeof Utils !== 'undefined') ServiceContainer.register('utils', Utils, { type: 'utility' });
      if (typeof ErrorHandler !== 'undefined') ServiceContainer.register('errorHandler', ErrorHandler, { type: 'infrastructure' });
      if (typeof Telemetry !== 'undefined') ServiceContainer.register('telemetry', Telemetry, { type: 'infrastructure' });
      if (typeof RPCService !== 'undefined') ServiceContainer.register('rpc', RPCService, { type: 'infrastructure' });
      if (typeof WalletService !== 'undefined') ServiceContainer.register('wallet', WalletService, { type: 'service' });
      if (typeof NotificationService !== 'undefined') ServiceContainer.register('notifications', NotificationService, { type: 'service' });
      if (typeof FeatureFlags !== 'undefined') ServiceContainer.register('featureFlags', FeatureFlags, { type: 'infrastructure' });
      if (typeof CapabilityRegistry !== 'undefined') ServiceContainer.register('capabilities', CapabilityRegistry, { type: 'infrastructure' });
    } catch (_e) {}
  }

  /* Discover plugins from the global window scope */
  function _discoverPlugins() {
    if (typeof PluginRegistry === 'undefined') return;

    // Auto-discover plugins that attached themselves to window namespace
    // Plugins are registered by their individual IIFE modules (in shared/plugins/)
    var knownPlugins = [
      'WalletPlugin', 'AIWalletPlugin', 'AutonomaPlugin', 'BridgePlugin',
      'SwapPlugin', 'TreasuryPlugin', 'SchedulerPlugin', 'ContactsPlugin',
      'DashboardPlugin', 'HistoryPlugin', 'ReportsPlugin', 'NotificationsPlugin',
      'MissionControlPlugin', 'VaultPlugin', 'InsightsPlugin', 'AutomationPlugin',
      'SimulationPlugin', 'PoliciesPlugin', 'SettingsPlugin', 'TimelinePlugin'
    ];

    for (var i = 0; i < knownPlugins.length; i++) {
      try {
        var name = knownPlugins[i];
        if (typeof window[name] !== 'undefined' && typeof window[name].id === 'string') {
          PluginRegistry.register(window[name]);
        }
      } catch (_e) {}
    }

    console.log('[Kernel] Discovered ' + PluginRegistry.getCount() + ' plugins');
  }

  /** Stop and destroy all plugins */
  function shutdown() {
    try { if (typeof PluginLoader !== 'undefined') PluginLoader.unloadAll(); } catch (_e) {}
    _started = false;
    try { if (typeof EventBus !== 'undefined') EventBus.emit('KERNEL_SHUTDOWN', {}); } catch (_e2) {}
  }

  function isBooted() { return _started; }

  /** @public */
  window.ApplicationKernel = {
    VERSION: VERSION,
    boot: boot,
    shutdown: shutdown,
    isBooted: isBooted
  };
})();
