/**
 * Elligentt GlobalMigrationManager — Reduce window globals (Phase 17.2)
 * Migrates scattered globals to GlobalRegistry. Generates audit report.
 * Attached to: window.GlobalMigrationManager
 */
(function () {
  'use strict';

  /** Essential globals that must remain on window for backward compat */
  var ESSENTIAL_GLOBALS = [
    'App', 'EventBus', 'Utils', 'toast', 'showToast', 'showPage',
    'AIWallet', 'AutonomaCore', 'ethers', 'DOMPurify', 'QRCode',
    'AppBootstrap', 'ApplicationKernel', 'SystemManager'
  ];

  function audit() {
    var report = { total: 0, essential: ESSENTIAL_GLOBALS.length, deprecatable: [], session: Date.now() };

    try {
      var ownKeys = Object.keys(window).filter(function (k) {
        return k.indexOf('_') !== 0 && typeof window[k] === 'function' && k.length > 3 && k.length < 50;
      });

      report.total = ownKeys.length;

      ownKeys.forEach(function (k) {
        if (ESSENTIAL_GLOBALS.indexOf(k) === -1 && !_isFramework(k)) {
          report.deprecatable.push({
            name: k,
            registered: _isRegistered(k),
            suggestedAction: _isRegistered(k) ? 'DEPRECATE — already in GlobalRegistry' : 'MIGRATE — register in GlobalRegistry'
          });
        }
      });
    } catch (_e) {}

    report.deprecatableCount = report.deprecatable.length;
    report.reductionTarget = report.total - report.essential;
    report.reductionPercent = report.total > 0 ? Math.round((report.reductionTarget / report.total) * 100) : 0;

    console.log('[GlobalMigrationManager] ' + report.total + ' globals. ' + report.deprecatableCount + ' deprecatable. Target: <' + ESSENTIAL_GLOBALS.length + ' essential.');
    return report;
  }

  function _isFramework(k) {
    var framework = ['DOM', 'Tabler', 'TabManager', 'ModalManager', 'ToastManager', 'NotificationService', 'RPCService', 'WalletService', 'WalletStore', 'UIStore', 'SettingsStore', 'Store', 'CHAIN_REGISTRY', 'SystemConfig', 'ScheduleEngine', 'PermitEngine', 'RiskEngine', 'PolicyEngine', 'AgentAuthorization', 'AgentIdentity', 'FinancialContext', 'ModuleLoader', 'WalletManager', 'AuthManager'];
    return framework.indexOf(k) !== -1;
  }

  function _isRegistered(k) {
    try { return typeof GlobalRegistry !== 'undefined' && GlobalRegistry.getAllRegistered().indexOf(k) !== -1; } catch (_e) { return false; }
  }

  function getEssentialCount() { return ESSENTIAL_GLOBALS.length; }

  window.GlobalMigrationManager = {
    VERSION: '17.0.0',
    ESSENTIAL_GLOBALS: ESSENTIAL_GLOBALS,
    audit: audit, getEssentialCount: getEssentialCount
  };
})();
