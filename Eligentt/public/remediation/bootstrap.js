/**
 * Elligentt Remediation Bootstrap — Phase 5
 * Load order: THIS FILE MUST LOAD FIRST after config/*.js files.
 * It installs all remediation patches in the correct order.
 *
 * Deployment: Add ONE script tag before all /shared/* modules:
 *   <script src="/remediation/bootstrap.js"></script>
 *
 * This eliminates the need for 80+ individual script tags.
 * ModuleLoader handles lazy loading of non-critical modules.
 */
(function(){
  'use strict';

  var REMEDIATION_VERSION = '5.0.0';
  var started = false;

  /* ════════════════════════════════════════
     STEP 1: JSON Fix (must install BEFORE any module writes to localStorage)
  ════════════════════════════════════════ */
  // JSONFix auto-installs on load — no action needed if jsonFix.js is loaded

  /* ════════════════════════════════════════
     STEP 2: Load critical modules via ModuleLoader
     (Replaces 80+ individual <script> tags)
  ════════════════════════════════════════ */
  function start() {
    if (started) return;
    started = true;

    console.log('[ElligenttRemediation] v' + REMEDIATION_VERSION + ' starting...');

    if (typeof window.ModuleLoader !== 'undefined') {
      window.ModuleLoader.init();
    }

    /* ── Run key migration after storage is available ── */
    setTimeout(function() {
      if (typeof window.KeyMigration !== 'undefined') {
        window.KeyMigration.runMigration().then(function(report) {
          console.log('[KeyMigration] Complete:', JSON.stringify(report));
        }).catch(function(e) {
          console.error('[KeyMigration] Error:', e.message);
        });
      }
    }, 3000);

    /* ── Install all fixes after modules load ── */
    setTimeout(function() {
      if (typeof window.PaymentQueueRemediation !== 'undefined') {
        window.PaymentQueueRemediation.install();
      }
      if (typeof window.ContractRegistryFix !== 'undefined') {
        window.ContractRegistryFix.install();
      }
      if (typeof window.SchedulerFix !== 'undefined') {
        window.SchedulerFix.install();
      }
      if (typeof window.AutonomaConsolidation !== 'undefined') {
        window.AutonomaConsolidation.install();
      }
      if (typeof window.SwapIsolation !== 'undefined') {
        window.SwapIsolation.install();
      }
    }, 5000);
  }

  /* ── Get remediation status ── */
  function getStatus() {
    return {
      version: REMEDIATION_VERSION,
      started: started,
      fixes: {
        keyMigration: typeof window.KeyMigration !== 'undefined' && window.KeyMigration.hasMigrated(),
        storageManager: typeof window.StorageManager !== 'undefined',
        jsonFix: typeof window.JSONFix !== 'undefined' && window.JSONFix.isInstalled(),
        treasurySync: typeof window.TreasurySync !== 'undefined',
        paymentQueue: typeof window.PaymentQueueRemediation !== 'undefined' && window.PaymentQueueRemediation.isInstalled(),
        contractRegistry: typeof window.ContractRegistryFix !== 'undefined',
        schedulerFix: typeof window.SchedulerFix !== 'undefined',
        autonomaConsolidation: typeof window.AutonomaConsolidation !== 'undefined' && window.AutonomaConsolidation.isInstalled(),
        swapIsolation: typeof window.SwapIsolation !== 'undefined' && window.SwapIsolation.isInstalled(),
        moduleLoader: typeof window.ModuleLoader !== 'undefined'
      }
    };
  }

  /* ── Auto-start on DOM ready ── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      setTimeout(start, 500);
    });
  } else {
    setTimeout(start, 500);
  }

  window.ElligenttRemediation = {
    start: start,
    getStatus: getStatus,
    version: REMEDIATION_VERSION
  };
})();
