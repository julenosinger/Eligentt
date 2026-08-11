/**
 * AIWalletCore — Modular AI Smart Wallet Orchestrator (Phase 4)
 *
 * Ties 15+ engine modules together. No business implementation.
 * Routes public API calls to the correct engine. Maintains backward compatibility.
 * The original aiSmartWallet.js remains fully functional — this is an additive layer.
 *
 * Attached to: window.AIWalletCore
 *
 * @module aiWalletCore
 * @version 1.0.0
 */
(function () {
  'use strict';

  var _initialized = false;

  /** Registry of all engine modules */
  var _engines = [
    { name: 'storage',      api: 'AIWStorageEngine',     mod: null },
    { name: 'validation',   api: 'AIWValidationEngine',  mod: null },
    { name: 'execution',    api: 'AIWExecutionEngine',   mod: null },
    { name: 'approval',     api: 'AIWApprovalEngine',    mod: null },
    { name: 'security',     api: 'AIWSecurityEngine',    mod: null },
    { name: 'simulation',   api: 'AIWSimulationEngine',  mod: null },
    { name: 'vault',        api: 'AIWVaultEngine',       mod: null },
    { name: 'workflow',     api: 'AIWWorkflowEngine',    mod: null },
    { name: 'automation',   api: 'AIWAutomationEngine',  mod: null },
    { name: 'mission',      api: 'AIWMissionEngine',     mod: null },
    { name: 'history',      api: 'AIWHistoryEngine',     mod: null },
    { name: 'limits',       api: 'AIWLimitsEngine',      mod: null },
    { name: 'profiles',     api: 'AIWProfilesEngine',    mod: null },
    { name: 'funding',      api: 'AIWFundingEngine',     mod: null },
    { name: 'notification', api: 'AIWNotificationEngine',mod: null }
  ];

  /** Map public API names to engine + method */
  var _routes = {
    // Validation
    validateIntent:     { engine: 'validation',   method: 'validate' },
    isEmergencyStopped: { engine: 'security',     method: 'isEmergencyStopped' },

    // Execution
    submitIntent:       { engine: 'execution',    method: 'submit' },
    executeIntent:      { engine: 'execution',    method: 'execute' },
    cancelIntent:       { engine: 'execution',    method: 'cancel' },
    getIntents:         { engine: 'execution',    method: 'getIntents' },

    // Approval
    approve:            { engine: 'approval',     method: 'approve' },
    reject:             { engine: 'approval',     method: 'reject' },

    // Security
    toggleEmergencyStop:{ engine: 'security',     method: 'toggleEmergencyStop' },
    setMode:            { engine: 'security',     method: 'setMode' },
    getMode:            { engine: 'security',     method: 'getMode' },
    revokeAll:          { engine: 'security',     method: 'revokeAllPermissions' },
    grantPerm:          { engine: 'security',     method: 'grantPermission' },

    // Simulation
    runSimulation:      { engine: 'simulation',   method: 'run' },
    simToIntent:        { engine: 'simulation',   method: 'convertToIntent' },

    // Vault
    setVaultAllocation: { engine: 'vault',        method: 'setAllocation' },
    topupNow:           { engine: 'vault',        method: 'topupNow' },
    saveGasConfig:      { engine: 'vault',        method: 'saveGasConfig' },

    // Workflow
    createWorkflow:     { engine: 'workflow',     method: 'create' },
    toggleWorkflow:     { engine: 'workflow',     method: 'toggle' },
    deleteWorkflow:     { engine: 'workflow',     method: 'remove' },

    // Automation
    createAutomation:   { engine: 'automation',   method: 'create' },

    // Mission/Overview
    refreshPortfolio:   { engine: 'mission',      method: 'refreshPortfolio' },

    // History/Reports
    getHistory:         { engine: 'history',      method: 'getHistory' },
    generateReport:     { engine: 'history',      method: 'generateReport' },

    // Limits
    saveLimits:         { engine: 'limits',       method: 'saveLimits' },

    // Profiles
    applyProfile:       { engine: 'profiles',     method: 'apply' },

    // Funding
    fundingSubmit:      { engine: 'funding',      method: 'submit' },
    openWizard:         { engine: 'funding',      method: 'openWizard' },

    // Assistant
    sendAssistant:      { engine: 'notification', method: 'sendAssistantMessage' }
  };

  /** Resolve an engine by name */
  function _resolve(engineName) {
    for (var i = 0; i < _engines.length; i++) {
      if (_engines[i].name === engineName) return _engines[i].mod;
    }
    return null;
  }

  /** Initialize all engines */
  function initialize() {
    if (_initialized) return;
    _initialized = true;

    var ok = 0, failed = 0;

    for (var i = 0; i < _engines.length; i++) {
      var entry = _engines[i];
      try {
        var apiRef = typeof window[entry.api] !== 'undefined' ? window[entry.api] : null;
        entry.mod = apiRef;
      } catch (_e) { entry.mod = null; }

      if (!entry.mod || typeof entry.mod.initialize !== 'function') {
        failed++;
        continue;
      }

      try {
        entry.mod.initialize();
        ok++;
      } catch (e) {
        console.warn('[AIWalletCore] Init failed: ' + entry.name, e.message);
        failed++;
      }
    }

    console.log('[AIWalletCore] Initialized ' + ok + '/' + _engines.length + ' engines (' + failed + ' skipped)');
  }

  /**
   * Execute a public API method by name.
   * @param {string} method - Public API name (e.g. 'validateIntent', 'submitIntent')
   * @param {Array} args - Arguments to pass
   * @returns {*}
   */
  function exec(method, args) {
    var route = _routes[method];
    if (!route) return null;

    var engine = _resolve(route.engine);
    if (!engine || typeof engine[route.method] !== 'function') return null;

    try {
      return engine[route.method].apply(engine, args || []);
    } catch (e) {
      try { if (typeof ErrorHandler !== 'undefined') ErrorHandler.handle(e, { source: 'aiwalletcore', operation: method }); } catch (_e) {}
      return null;
    }
  }

  /** Refresh all engines */
  function refreshAll() {
    for (var i = 0; i < _engines.length; i++) {
      var mod = _engines[i].mod;
      if (!mod || typeof mod.refresh !== 'function') continue;
      try { mod.refresh(); } catch (_e) {}
    }
  }

  /** Full render refresh (when tab becomes active) */
  function onShow() {
    initialize();
    refreshAll();
    // Also trigger the original AIWallet.onShow for complete backward compat
    try { if (typeof AIWallet !== 'undefined' && AIWallet.onShow) AIWallet.onShow(); } catch (_e) {}
  }

  function destroy() {
    for (var i = _engines.length - 1; i >= 0; i--) {
      var mod = _engines[i].mod;
      if (!mod || typeof mod.destroy !== 'function') continue;
      try { mod.destroy(); } catch (_e) {}
      _engines[i].mod = null;
    }
    _initialized = false;
  }

  function getReport() {
    return _engines.map(function (e) { return { name: e.name, api: e.api, ready: !!e.mod }; });
  }

  // Hook into boot
  try {
    if (typeof EventBus !== 'undefined' && EventBus.on) {
      EventBus.on('APP_BOOT_COMPLETE', function () { initialize(); });
    }
  } catch (_e) {}

  /** @public */
  window.AIWalletCore = {
    VERSION: '1.0.0',
    initialize: initialize, exec: exec, refreshAll: refreshAll,
    onShow: onShow, destroy: destroy, getReport: getReport,
    _routes: _routes
  };
})();
