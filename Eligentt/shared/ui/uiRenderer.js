/**
 * Elligentt UIRenderer — Centralized UI Rendering Orchestrator (Phase 2 Architecture)
 *
 * Initializes all render modules in dependency order.
 * Delegates to each render module's initialize/render/refresh/destroy lifecycle.
 * Hooks into AppBootstrap and EventBus for coordinated startup.
 *
 * Contains ZERO rendering logic. Only orchestration.
 *
 * Attached to: window.UIRenderer
 *
 * @module uiRenderer
 * @version 1.0.0
 */
(function () {
  'use strict';

  var _initialized = false;

  /**
   * Ordered list of all render modules with their lifecycle methods.
   * Each entry: { name, module, dependsOn }
   */
  var _registry = [
    { name: 'wallet',       mod: null, init: 'initialize', render: 'render', refresh: 'refresh', destroy: 'destroy' },
    { name: 'dashboard',    mod: null, init: 'initialize', render: 'render', refresh: 'refresh', destroy: 'destroy' },
    { name: 'missionCtrl',  mod: null, init: 'initialize', render: 'render', refresh: 'refresh', destroy: 'destroy' },
    { name: 'overview',     mod: null, init: 'initialize', render: 'render', refresh: 'refresh', destroy: 'destroy' },
    { name: 'vault',        mod: null, init: 'initialize', render: 'render', refresh: 'refresh', destroy: 'destroy' },
    { name: 'history',      mod: null, init: 'initialize', render: 'render', refresh: 'refresh', destroy: 'destroy' },
    { name: 'timeline',     mod: null, init: 'initialize', render: 'render', refresh: 'refresh', destroy: 'destroy' },
    { name: 'reports',      mod: null, init: 'initialize', render: 'render', refresh: 'refresh', destroy: 'destroy' },
    { name: 'contacts',     mod: null, init: 'initialize', render: 'render', refresh: 'refresh', destroy: 'destroy' },
    { name: 'scheduler',    mod: null, init: 'initialize', render: 'render', refresh: 'refresh', destroy: 'destroy' },
    { name: 'swap',         mod: null, init: 'initialize', render: 'render', refresh: 'refresh', destroy: 'destroy' },
    { name: 'bridge',       mod: null, init: 'initialize', render: 'render', refresh: 'refresh', destroy: 'destroy' },
    { name: 'treasury',     mod: null, init: 'initialize', render: 'render', refresh: 'refresh', destroy: 'destroy' },
    { name: 'notifications',mod: null, init: 'initialize', render: 'render', refresh: 'refresh', destroy: 'destroy' },
    { name: 'approvals',    mod: null, init: 'initialize', render: 'render', refresh: 'refresh', destroy: 'destroy' },
    { name: 'automation',   mod: null, init: 'initialize', render: 'render', refresh: 'refresh', destroy: 'destroy' },
    { name: 'insights',     mod: null, init: 'initialize', render: 'render', refresh: 'refresh', destroy: 'destroy' },
    { name: 'policies',     mod: null, init: 'initialize', render: 'render', refresh: 'refresh', destroy: 'destroy' },
    { name: 'simulation',   mod: null, init: 'initialize', render: 'render', refresh: 'refresh', destroy: 'destroy' },
    { name: 'profiles',     mod: null, init: 'initialize', render: 'render', refresh: 'refresh', destroy: 'destroy' },
    { name: 'settings',     mod: null, init: 'initialize', render: 'render', refresh: 'refresh', destroy: 'destroy' }
  ];

  /* ════════════════════════════════════════════
     MODULE RESOLUTION
  ════════════════════════════════════════════ */

  var MODULE_MAP = {
    wallet:        function () { return typeof WalletRenderer !== 'undefined' ? WalletRenderer : null; },
    dashboard:     function () { return typeof DashboardRenderer !== 'undefined' ? DashboardRenderer : null; },
    missionCtrl:   function () { return typeof MissionControlRenderer !== 'undefined' ? MissionControlRenderer : null; },
    overview:      function () { return typeof OverviewRenderer !== 'undefined' ? OverviewRenderer : null; },
    vault:         function () { return typeof VaultRenderer !== 'undefined' ? VaultRenderer : null; },
    history:       function () { return typeof HistoryRenderer !== 'undefined' ? HistoryRenderer : null; },
    timeline:      function () { return typeof TimelineRenderer !== 'undefined' ? TimelineRenderer : null; },
    reports:       function () { return typeof ReportsRenderer !== 'undefined' ? ReportsRenderer : null; },
    contacts:      function () { return typeof ContactsRenderer !== 'undefined' ? ContactsRenderer : null; },
    scheduler:     function () { return typeof SchedulerRenderer !== 'undefined' ? SchedulerRenderer : null; },
    swap:          function () { return typeof SwapRenderer !== 'undefined' ? SwapRenderer : null; },
    bridge:        function () { return typeof BridgeRenderer !== 'undefined' ? BridgeRenderer : null; },
    treasury:      function () { return typeof TreasuryRenderer !== 'undefined' ? TreasuryRenderer : null; },
    notifications: function () { return typeof NotificationsRenderer !== 'undefined' ? NotificationsRenderer : null; },
    approvals:     function () { return typeof ApprovalsRenderer !== 'undefined' ? ApprovalsRenderer : null; },
    automation:    function () { return typeof AutomationRenderer !== 'undefined' ? AutomationRenderer : null; },
    insights:      function () { return typeof InsightsRenderer !== 'undefined' ? InsightsRenderer : null; },
    policies:      function () { return typeof PoliciesRenderer !== 'undefined' ? PoliciesRenderer : null; },
    simulation:    function () { return typeof SimulationRenderer !== 'undefined' ? SimulationRenderer : null; },
    profiles:      function () { return typeof ProfilesRenderer !== 'undefined' ? ProfilesRenderer : null; },
    settings:      function () { return typeof SettingsRenderer !== 'undefined' ? SettingsRenderer : null; }
  };

  /* ════════════════════════════════════════════
     INITIALIZATION
  ════════════════════════════════════════════ */

  /**
   * Initialize all render modules in registry order.
   * Called by AppBootstrap during startup.
   */
  function initialize() {
    if (_initialized) return;
    _initialized = true;

    var initialized = 0;
    var failed = 0;

    for (var i = 0; i < _registry.length; i++) {
      var entry = _registry[i];
      var resolver = MODULE_MAP[entry.name];
      if (!resolver) continue;

      var mod = resolver();
      entry.mod = mod;

      if (!mod || typeof mod[entry.init] !== 'function') {
        failed++;
        continue;
      }

      try {
        mod[entry.init]();
        initialized++;
      } catch (e) {
        console.warn('[UIRenderer] Failed to init ' + entry.name + ':', e.message);
        failed++;
      }
    }

    console.log('[UIRenderer] Initialized: ' + initialized + '/' + _registry.length + ' render modules (' + failed + ' skipped)');
  }

  /**
   * Render ALL registered modules.
   */
  function renderAll() {
    for (var i = 0; i < _registry.length; i++) {
      var entry = _registry[i];
      var mod = entry.mod;
      if (!mod || typeof mod[entry.render] !== 'function') continue;
      try { mod[entry.render](); } catch (_e) {}
    }
  }

  /**
   * Refresh ALL registered modules.
   */
  function refreshAll() {
    for (var i = 0; i < _registry.length; i++) {
      var entry = _registry[i];
      var mod = entry.mod;
      if (!mod || typeof mod[entry.refresh] !== 'function') continue;
      try { mod[entry.refresh](); } catch (_e) {}
    }
  }

  /**
   * Render a specific module by name.
   * @param {string} name - e.g. 'contacts', 'history', 'swap'
   */
  function render(name) {
    var resolver = MODULE_MAP[name];
    if (!resolver) return;
    var mod = resolver();
    if (mod && typeof mod.render === 'function') {
      try { mod.render(); } catch (_e) {}
    }
  }

  /**
   * Refresh a specific module by name.
   * @param {string} name
   */
  function refresh(name) {
    var resolver = MODULE_MAP[name];
    if (!resolver) return;
    var mod = resolver();
    if (mod && typeof mod.refresh === 'function') {
      try { mod.refresh(); } catch (_e) {}
    }
  }

  /**
   * Destroy all render modules. Called on app teardown.
   */
  function destroy() {
    for (var i = _registry.length - 1; i >= 0; i--) {
      var entry = _registry[i];
      var mod = entry.mod;
      if (!mod || typeof mod[entry.destroy] !== 'function') continue;
      try { mod[entry.destroy](); } catch (_e) {}
      entry.mod = null;
    }
    _initialized = false;
  }

  /**
   * Get render module report.
   * @returns {{ name: string, initialized: boolean }[]}
   */
  function getReport() {
    return _registry.map(function (e) {
      return { name: e.name, initialized: !!e.mod };
    });
  }

  // Hook into AppBootstrap.ready event
  try {
    if (typeof EventBus !== 'undefined' && EventBus.on) {
      EventBus.on('APP_BOOT_COMPLETE', function () { initialize(); });
    }
  } catch (_e) {}

  /** @public */
  window.UIRenderer = {
    VERSION: '1.0.0',
    initialize: initialize,
    renderAll: renderAll,
    refreshAll: refreshAll,
    render: render,
    refresh: refresh,
    destroy: destroy,
    getReport: getReport
  };
})();
