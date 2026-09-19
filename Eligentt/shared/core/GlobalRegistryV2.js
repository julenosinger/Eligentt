/**
 * Elligentt GlobalRegistryV2 — Clean Global Namespace Manager (Phase 19)
 *
 * Reduces window.* to ONLY essential infrastructure globals.
 * All application state MUST flow through Stores, Domains, or this Registry.
 *
 * Allowed window globals (phase 19):
 *   Essential:
 *     window.App               — Application shell reference
 *     window.EventBus           — Inter-module communication
 *     window.AppBootstrap       — Startup orchestrator
 *     window.ApplicationKernel  — Kernel orchestrator
 *     window.SystemManager      — System layer orchestrator
 *     window.RuntimeMode        — Mode control
 *     window.ethers             — Blockchain library
 *     window.DOMPurify          — XSS sanitizer
 *     window.QRCode             — QR code generator
 *
 *   Infrastructure (migrated to registry):
 *     Registered via GlobalRegistryV2.register() — accessible via GlobalRegistryV2.get()
 *
 * Deprecation path:
 *   Before: window.walletAddress
 *   After:  WalletStore.get("address")
 *
 *   Before: window.recipients
 *   After:  PaymentStore.get("recipients")
 *
 *   Before: window.swapAmount
 *   After:  SwapStore.get("amount")
 *
 * Attached to: window.GlobalRegistryV2
 *
 * @module GlobalRegistryV2
 * @version 19.0.0
 */
(function () {
  'use strict';

  var _registry = {};
  var _essentialGlobals = {};
  var _deprecatedAccess = {};
  var _accessLog = {};

  /** Phase 19 allowed global set — everything else is a violation in PURE_MODULAR */
  var ALLOWED = [
    'App', 'EventBus', 'AppBootstrap', 'ApplicationKernel', 'SystemManager',
    'RuntimeMode', 'ethers', 'DOMPurify', 'QRCode',
    'GlobalRegistry', 'GlobalRegistryV2',
    'PageLoader', 'PageController', 'EventDelegator',
    'PureExecutionGuard', 'PureRuntimeValidator',
    'ProductionGuard', 'ProductionConfig',
    'ObservabilityCenter', 'AuditManager',
    'SecurityCenter', 'IntentSecurity',
    'ErrorHandler', 'Telemetry', 'Logger',
    'WalletStore', 'PaymentStore', 'SwapStore', 'PoolStore',
    'AIWalletStore', 'AutonomaStore', 'SettingsStore', 'UIStore',
    'CoreMigrate'
  ];

  /* ── Registration ──────────────────────────────────────── */

  function register(name, module, opts) {
    var o = opts || {};
    _registry[name] = {
      module: module,
      type: o.type || 'unknown',
      domain: o.domain || null,
      version: o.version || 'unknown',
      essential: o.essential || false,
      registeredAt: Date.now()
    };

    if (o.essential) {
      _essentialGlobals[name] = true;
    }

    _accessLog[name] = 0;
  }

  /* ── Access ────────────────────────────────────────────── */

  function get(name) {
    _accessLog[name] = (_accessLog[name] || 0) + 1;
    var entry = _registry[name];
    if (!entry) return null;
    return entry.module;
  }

  /**
   * Get with deprecation awareness.
   * @param {string} name
   * @param {string} [deprecatedFor] — the new name to recommend
   */
  function getWithDeprecation(name, deprecatedFor) {
    _deprecatedAccess[name] = (_deprecatedAccess[name] || 0) + 1;
    if (deprecatedFor) {
      try {
        var isPure = typeof RuntimeMode !== 'undefined' && RuntimeMode.isPure();
        if (isPure) {
          console.warn('[GlobalRegistryV2] DEPRECATED: ' + name + ' → use ' + deprecatedFor);
        }
      } catch (_e) {}
    }
    return get(name);
  }

  /* ── Validation ─────────────────────────────────────────── */

  /**
   * Check if a window property is allowed in PURE_MODULAR mode.
   * @param {string} key
   * @returns {{ allowed: boolean, reason: string }}
   */
  function isAllowedGlobal(key) {
    if (ALLOWED.indexOf(key) !== -1) return { allowed: true, reason: 'EXPLICITLY_ALLOWED' };
    if (key.indexOf('_') === 0) return { allowed: true, reason: 'INTERNAL_PREFIX' };
    if (key.indexOf('$') !== -1) return { allowed: true, reason: 'FRAMEWORK_BINDING' };
    if (key.indexOf('webkit') === 0) return { allowed: true, reason: 'BROWSER_INTERNAL' };
    if (key.indexOf('on') === 0 && key.length < 15) return { allowed: true, reason: 'BROWSER_EVENT' };

    if (_registry[key] && _registry[key].essential) {
      return { allowed: true, reason: 'REGISTERED_ESSENTIAL' };
    }

    return { allowed: false, reason: 'NOT_ALLOWED_IN_PURE_MODULAR — migrate to Store, Domain, or Registry' };
  }

  /**
   * Scan all window properties and report violations.
   * @returns {Object}
   */
  function auditGlobals() {
    var report = { allowed: [], violations: [], total: 0, generatedAt: new Date().toISOString() };

    try {
      var keys = Object.keys(window).filter(function (k) {
        return k.length < 60 && k.indexOf('$') === -1 && k.indexOf('webkit') === -1;
      });
      report.total = keys.length;

      keys.forEach(function (k) {
        var check = isAllowedGlobal(k);
        if (check.allowed) {
          report.allowed.push(k);
        } else {
          report.violations.push({
            name: k,
            type: typeof window[k],
            suggestion: _getMigrationSuggestion(k)
          });
        }
      });
    } catch (_e) {}

    report.allowedCount = report.allowed.length;
    report.violationCount = report.violations.length;
    report.compliancePercent = report.total > 0 ? Math.round((report.allowedCount / report.total) * 100) : 100;
    report.registeredCount = Object.keys(_registry).length;

    return report;
  }

  function _getMigrationSuggestion(name) {
    var map = {
      'walletAddress':   'WalletStore.get("address")',
      'activeChainId':   'WalletStore.get("chainId")',
      'recipients':      'PaymentStore.get("recipients")',
      'swapAmount':      'SwapStore.get("amount")',
      'schedules':       'SchedulerDomain.getAll()',
      'contacts':        'ContactsDomain.getAll()',
      'txHistory':       'HistoryDomain.getAll()',
      'activeWalletType': 'WalletStore.get("walletType")'
    };
    return map[name] || 'GlobalRegistryV2.register("' + name + '", value)';
  }

  /* ── Auto-registration ──────────────────────────────────── */

  function autoRegister() {
    var modules = {
      'WalletStore':    { type: 'store',    domain: 'wallet',     essential: true },
      'PaymentStore':   { type: 'store',    domain: 'payments',   essential: true },
      'SwapStore':      { type: 'store',    domain: 'swap',       essential: true },
      'PoolStore':      { type: 'store',    domain: 'pool',       essential: true },
      'AIWalletStore':  { type: 'store',    domain: 'aiwallet',   essential: true },
      'AutonomaStore':  { type: 'store',    domain: 'autonoma',   essential: true },
      'SettingsStore':  { type: 'store',    domain: 'settings',   essential: true },
      'UIStore':        { type: 'store',    domain: 'ui',         essential: true },
      'PageLoader':     { type: 'system',   domain: 'navigation', essential: true },
      'PageController': { type: 'system',   domain: 'navigation', essential: true },
      'EventDelegator': { type: 'system',   domain: 'events',     essential: true },
      'ErrorHandler':   { type: 'system',   domain: 'system',     essential: true },
      'Telemetry':      { type: 'system',   domain: 'system',     essential: true },
      'Logger':         { type: 'system',   domain: 'system',     essential: true }
    };

    Object.keys(modules).forEach(function (name) {
      try {
        if (typeof window[name] !== 'undefined') {
          register(name, window[name], modules[name]);
        }
      } catch (_e) {}
    });

    console.log('[GlobalRegistryV2] Auto-registered ' + Object.keys(_registry).length + ' modules');
  }

  /* ── Utilities ──────────────────────────────────────────── */

  /** @returns {string[]} */
  function getAllRegistered() { return Object.keys(_registry); }

  /** @returns {number} */
  function getRegisteredCount() { return Object.keys(_registry).length; }

  /** @returns {Object} */
  function getReport() {
    return {
      version: '19.0.0',
      registered: getRegisteredCount(),
      essential: Object.keys(_essentialGlobals).length,
      allowedGlobals: ALLOWED.length,
      mostAccessed: Object.entries(_accessLog).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 10),
      deprecatedAccess: Object.keys(_deprecatedAccess).length
    };
  }

  /**
   * Clean deprecated access tracking.
   */
  function clearDeprecated() { _deprecatedAccess = {}; }

  /**
   * Get the allowed globals list for reference.
   * @returns {string[]}
   */
  function getAllowedList() { return ALLOWED.slice(); }

  /** @public */
  window.GlobalRegistryV2 = {
    VERSION: '19.0.0',
    ALLOWED: ALLOWED,
    register: register,
    get: get,
    getWithDeprecation: getWithDeprecation,
    isAllowedGlobal: isAllowedGlobal,
    auditGlobals: auditGlobals,
    autoRegister: autoRegister,
    getAllRegistered: getAllRegistered,
    getRegisteredCount: getRegisteredCount,
    getReport: getReport,
    getAllowedList: getAllowedList,
    clearDeprecated: clearDeprecated
  };

  // Auto-register on load
  try { autoRegister(); } catch (_e) {}
})();
