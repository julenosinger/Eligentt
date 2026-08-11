/**
 * Elligentt ProductionConfig — Enable All Migration Flags for Production (Phase 10)
 * On load, enables all migration flags. Disables legacy fallback.
 * Backward compatible: only affects CoreMigrate routing.
 * Attached to: window.ProductionConfig
 */
(function () {
  'use strict';

  var PRODUCTION_FLAGS = [
    'USE_WALLET_DOMAIN', 'USE_PAYMENT_DOMAIN', 'USE_SCHEDULER_DOMAIN',
    'USE_AIW_VALIDATION_ENGINE', 'USE_AIW_EXECUTION_ENGINE', 'USE_AIW_APPROVAL_ENGINE',
    'USE_AIW_VAULT_ENGINE', 'USE_AIW_SIMULATION_ENGINE', 'USE_AIW_HISTORY_ENGINE',
    'USE_AIW_LIMITS_ENGINE', 'USE_TREASURY_DOMAIN', 'USE_SWAP_DOMAIN',
    'USE_BRIDGE_DOMAIN', 'USE_AUT_CONTEXT_ENGINE', 'USE_AUT_INTENT_ENGINE',
    'USE_AUT_MEMORY_ENGINE', 'USE_CONTACTS_DOMAIN', 'USE_HISTORY_DOMAIN',
    'USE_REPORTS_DOMAIN', 'USE_NOTIFICATION_DOMAIN',
    'USE_EXECUTION_COORDINATOR', 'USE_LOCK_MANAGER', 'USE_CACHE_MANAGER',
    'USE_QUEUE_MANAGER', 'USE_AUDIT_MANAGER'
  ];

  /**
   * Enable all production flags. Safe to call multiple times.
   */
  function enableAll() {
    if (typeof MigrationFlags === 'undefined') return { enabled: 0, total: PRODUCTION_FLAGS.length };

    var enabled = 0;
    for (var i = 0; i < PRODUCTION_FLAGS.length; i++) {
      try {
        MigrationFlags.enable(PRODUCTION_FLAGS[i]);
        enabled++;
      } catch (_e) {}
    }

    // Set production guard mode
    try {
      if (typeof ProductionGuard !== 'undefined') ProductionGuard.setMode('production');
    } catch (_e) {}

    console.log('[ProductionConfig] Enabled ' + enabled + '/' + PRODUCTION_FLAGS.length + ' migration flags. Production mode ON.');

    try { if (typeof EventBus !== 'undefined') EventBus.emit('PRODUCTION_CONFIG_APPLIED', { enabled: enabled, total: PRODUCTION_FLAGS.length }); } catch (_e) {}

    return { enabled: enabled, total: PRODUCTION_FLAGS.length };
  }

  function isProduction() {
    try { return typeof MigrationFlags !== 'undefined' && MigrationFlags.isEnabled('USE_WALLET_DOMAIN'); } catch (_e) {}
    return false;
  }

  // Auto-enable on load
  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { setTimeout(enableAll, 10); });
    } else {
      setTimeout(enableAll, 10);
    }
  } catch (_e) {}

  window.ProductionConfig = {
    VERSION: '1.0.0',
    PRODUCTION_FLAGS: PRODUCTION_FLAGS,
    enableAll: enableAll, isProduction: isProduction
  };
})();
