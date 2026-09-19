/**
 * Elligentt MigrationFlags — Safe Toggle System (Phase 7)
 * Each migrated function has a flag. Default OFF. Enable after parity verified.
 * Persisted to localStorage. Runtime toggle without restart.
 * Attached to: window.MigrationFlags
 */
(function () {
  'use strict';
  var STORAGE_KEY = 'elligentt_migration_flags_v1';
  var _flags = {};

  // Define all migration targets
  var DEFINITIONS = {
    // Domain Services
    USE_CONTACTS_DOMAIN:     { def: false, desc: 'Route contacts CRUD through ContactsDomain' },
    USE_HISTORY_DOMAIN:      { def: false, desc: 'Route history queries through HistoryDomain' },
    USE_REPORTS_DOMAIN:      { def: false, desc: 'Route report generation through ReportsDomain' },
    USE_SCHEDULER_DOMAIN:    { def: false, desc: 'Route schedule ops through SchedulerDomain' },
    USE_NOTIFICATION_DOMAIN: { def: false, desc: 'Route notifications through NotificationDomain' },
    USE_PAYMENT_DOMAIN:      { def: false, desc: 'Route batch payments through PaymentDomain' },
    USE_SWAP_DOMAIN:         { def: false, desc: 'Route swap ops through SwapDomain' },
    USE_BRIDGE_DOMAIN:       { def: false, desc: 'Route bridge ops through BridgeDomain' },
    USE_TREASURY_DOMAIN:     { def: false, desc: 'Route treasury ops through TreasuryDomain' },
    USE_WALLET_DOMAIN:       { def: false, desc: 'Route wallet ops through WalletDomain' },
    // AI Wallet engines
    USE_AIW_VALIDATION_ENGINE:   { def: false, desc: 'Route validation through AIWValidationEngine' },
    USE_AIW_EXECUTION_ENGINE:    { def: false, desc: 'Route execution through AIWExecutionEngine' },
    USE_AIW_APPROVAL_ENGINE:     { def: false, desc: 'Route approvals through AIWApprovalEngine' },
    USE_AIW_VAULT_ENGINE:        { def: false, desc: 'Route vault ops through AIWVaultEngine' },
    USE_AIW_SIMULATION_ENGINE:   { def: false, desc: 'Route simulations through AIWSimulationEngine' },
    USE_AIW_HISTORY_ENGINE:      { def: false, desc: 'Route history through AIWHistoryEngine' },
    USE_AIW_LIMITS_ENGINE:       { def: false, desc: 'Route limits ops through AIWLimitsEngine' },
    // Autonoma engines
    USE_AUT_CONTEXT_ENGINE:      { def: false, desc: 'Route context through AutContextEngine' },
    USE_AUT_INTENT_ENGINE:       { def: false, desc: 'Route NLU through AutIntentEngine' },
    USE_AUT_MEMORY_ENGINE:       { def: false, desc: 'Route memory through AutMemoryEngine' },
    // System layer
    USE_EXECUTION_COORDINATOR:   { def: false, desc: 'Route executions through ExecutionCoordinator' },
    USE_LOCK_MANAGER:            { def: false, desc: 'Use LockManager for concurrency control' },
    USE_CACHE_MANAGER:           { def: false, desc: 'Use CacheManager for caching' },
    USE_QUEUE_MANAGER:           { def: false, desc: 'Use QueueManager for task scheduling' },
    USE_AUDIT_MANAGER:           { def: false, desc: 'Use AuditManager for audit trail' }
  };

  function _load() {
    try { var raw = localStorage.getItem(STORAGE_KEY); if (raw) _flags = JSON.parse(raw); } catch (_e) { _flags = {}; }
    // Backfill missing flags with defaults
    Object.keys(DEFINITIONS).forEach(function (k) { if (_flags[k] === undefined) _flags[k] = DEFINITIONS[k].def; });
    _save();
  }

  function _save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(_flags)); } catch (_e) {} }

  function isEnabled(flag) { return _flags[flag] === true; }
  function isDisabled(flag) { return !_flags[flag]; }
  function enable(flag) { if (_flags[flag] !== undefined) { _flags[flag] = true; _save(); } }
  function disable(flag) { if (_flags[flag] !== undefined) { _flags[flag] = false; _save(); } }
  function getAll() { return Object.assign({}, _flags); }
  function getEnabled() { return Object.keys(_flags).filter(function (k) { return _flags[k]; }); }
  function getDisabled() { return Object.keys(_flags).filter(function (k) { return !_flags[k]; }); }

  function getCoverage() {
    var total = Object.keys(_flags).length;
    var enabled = getEnabled().length;
    return { total: total, enabled: enabled, disabled: total - enabled, percent: total > 0 ? Math.round((enabled / total) * 100) : 0 };
  }

  _load();

  window.MigrationFlags = {
    VERSION: '1.0.0', DEFINITIONS: DEFINITIONS,
    isEnabled: isEnabled, isDisabled: isDisabled, enable: enable, disable: disable,
    getAll: getAll, getEnabled: getEnabled, getDisabled: getDisabled, getCoverage: getCoverage
  };
})();
