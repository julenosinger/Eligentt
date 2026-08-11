/**
 * Elligentt Module Loader — Phase 5 Remediation
 * Lazy loads non-critical modules. Eliminates 80+ synchronous script tags.
 * Critical modules load immediately. Non-critical load deferred.
 * Attached to window.ModuleLoader
 */
(function(){
  'use strict';

  var loaded = {};
  var pending = {};
  var basePath = '/';

  /* ════════════════════════════════════════
     MODULE CLASSIFICATION
  ════════════════════════════════════════ */

  // CRITICAL — must load before any user interaction
  var CRITICAL = [
    'config/system.js', 'config/chains.js', 'config/contracts.js',
    'config/cctp.js', 'config/fees.js', 'config/slippage.js',
    'shared/rpcManager.js', 'shared/walletManager.js', 'shared/auth.js',
    'shared/logger.js', 'shared/jsonFix.js', 'shared/storageManager.js',
    'shared/keyMigration.js'
  ];

  // ESSENTIAL — loaded immediately after critical
  var ESSENTIAL = [
    'shared/permitEngine.js', 'shared/riskEngine.js',
    'shared/contractRegistry.js', 'shared/contractRegistryFix.js',
    'shared/policyEngine.js', 'shared/treasuryGuard.js',
    'shared/multicall.js'
  ];

  // DEFERRED — loaded after page render
  var DEFERRED = [
    'shared/aiSmartWallet.js', 'shared/autonomaCore.js', 'shared/autonomaAgent.js',
    'shared/agentWalletManager.js', 'shared/agentAuthorization.js',
    'shared/agentIdentity.js', 'shared/agentSession.js', 'shared/agentAudit.js',
    'shared/agentReputation.js', 'shared/agentScheduleExecutor.js',
    'shared/executionQueue.js', 'shared/executionPlanner.js',
    'shared/executionWatchdog.js', 'shared/invariantEngine.js',
    'shared/securityAttackLab.js', 'shared/permissionCards.js',
    'shared/trustLayer.js', 'shared/missionEngine.js',
    'shared/financialContext.js', 'shared/aiRecommendations.js'
  ];

  // LAZY — loaded on demand when user navigates to feature
  var LAZY = {
    'page-batch': [
      'shared/BatchExecutionEngine.js', 'shared/ExecutionAggregator.js',
      'shared/CrossChainTransferRouter.js', 'shared/paymentQueueRemediation.js'
    ],
    'page-bridge': [
      'shared/CCTPV2InboundEngine.js', 'shared/CircleAttestationMonitor.js',
      'shared/CCTPFinalityEngine.js', 'shared/BridgeRecoveryEngine.js',
      'shared/CCTPHealthMonitor.js', 'shared/AutonomaCCTPV2Integration.js'
    ],
    'page-pool': [
      'shared/poolAbiDiscovery.js', 'shared/poolRegistryModule.js',
      'shared/priceImpact.js', 'shared/liquidityHealth.js',
      'shared/liquidityProtection.js', 'shared/poolHealthCheck.js',
      'shared/poolStateManager.js', 'shared/poolDataValidator.js',
      'shared/poolRetryManager.js', 'shared/poolReserveSnapshot.js',
      'shared/poolWatcher.js', 'shared/priceOracleEngine.js',
      'shared/twapEngine.js', 'shared/poolMonitor.js',
      'shared/anomalyDetection.js', 'shared/historicalMetrics.js',
      'shared/lpAnalytics.js', 'shared/poolAlertSystem.js',
      'shared/economicMonitoring.js'
    ],
    'page-treasury': [
      'shared/treasuryIndexer.js', 'shared/applicationLedger.js',
      'shared/treasurySync.js', 'shared/schedulerFix.js'
    ],
    'page-schedule': [
      'shared/schedulerFix.js', 'shared/paymentQueueRemediation.js'
    ],
    'page-autonoma': [
      'shared/autonomaNlu.js', 'shared/autonomaConsolidation.js',
      'shared/autonomaDocumentIntelligence.js'
    ],
    'page-balance': [
      'shared/ubMerchantHub.js'
    ]
  };

  // DORMANT — loaded but never used (Phase 2 classification)
  var DORMANT = [
    'shared/oracle-interoperability/OracleRegistry.js',
    'shared/oracle-interoperability/HistoricalMarketDataEngine.js',
    'shared/oracle-interoperability/OracleHealthMonitor.js',
    'shared/oracle-interoperability/TreasuryAnalyticsEngine.js',
    'shared/oracle-interoperability/AIRecommendationEngine.js',
    'shared/oracle-interoperability/LiquidityPoolSecurityEngine.js',
    'shared/oracle-interoperability/CrossChainAnalyticsEngine.js',
    'shared/oracle-interoperability/OraclePluginManager.js',
    'shared/oracle-interoperability/OracleDashboardEngine.js',
    'shared/oracleInterop.js'
  ];

  // DEPRECATED — features being removed/migrated
  var DEPRECATED = [
    'shared/executionQueue.js' // Migrated to ScheduleEngine
  ];

  /* ════════════════════════════════════════
     LOADER FUNCTIONS
  ════════════════════════════════════════ */

  function loadScript(path) {
    if (loaded[path]) return Promise.resolve();
    if (pending[path]) return pending[path];

    if (window.__ELLIGENTT_BUNDLE && window.__ELLIGENTT_BUNDLE.files &&
        window.__ELLIGENTT_BUNDLE.files.indexOf(path) !== -1) {
      loaded[path] = true;
      return Promise.resolve();
    }

    // Skip dormant modules
    if (DORMANT.indexOf(path) !== -1) {
      loaded[path] = true;
      return Promise.resolve();
    }

    var fullPath = path.startsWith('http') ? path : basePath + path;

    var promise = new Promise(function(resolve, reject) {
      var script = document.createElement('script');
      script.src = fullPath;
      script.async = true;
      script.onload = function() {
        loaded[path] = true;
        delete pending[path];
        resolve();
      };
      script.onerror = function() {
        console.warn('[ModuleLoader] Failed to load:', path);
        loaded[path] = true; // Mark as loaded to prevent retry storms
        delete pending[path];
        resolve(); // Resolve anyway — don't block app
      };
      document.head.appendChild(script);
    });

    pending[path] = promise;
    return promise;
  }

  function loadList(list) {
    return Promise.all(list.map(loadScript));
  }

  function isLoaded(path) { return !!loaded[path]; }

  /**
   * Load modules for a specific page/feature.
   * Called when user navigates to a tab.
   */
  function loadForPage(pageId) {
    var modules = LAZY[pageId];
    if (!modules) return Promise.resolve();
    return loadList(modules);
  }

  /**
   * Pre-load critical + essential modules.
   * Called immediately on app init.
   */
  function loadCore() {
    return loadList(CRITICAL.concat(ESSENTIAL));
  }

  /**
   * Deferred loading — called after page becomes interactive.
   */
  function loadDeferred() {
    return loadList(DEFERRED);
  }

  /**
   * Get module classification report.
   */
  function getReport() {
    var total = CRITICAL.length + ESSENTIAL.length + DEFERRED.length;
    var lazyTotal = 0;
    var pageKeys = Object.keys(LAZY);
    for (var i = 0; i < pageKeys.length; i++) lazyTotal += LAZY[pageKeys[i]].length;

    return {
      criticalLoaded: CRITICAL.filter(function(m) { return loaded[m]; }).length,
      essentialLoaded: ESSENTIAL.filter(function(m) { return loaded[m]; }).length,
      deferredLoaded: DEFERRED.filter(function(m) { return loaded[m]; }).length,
      dormantSkipped: DORMANT.length,
      deprecatedSkipped: DEPRECATED.length,
      totalCritical: CRITICAL.length,
      totalEssential: ESSENTIAL.length,
      totalDeferred: DEFERRED.length,
      totalLazy: lazyTotal,
      totalDormant: DORMANT.length,
      totalDeprecated: DEPRECATED.length,
      savingsPercent: Math.round((DORMANT.length / (total + lazyTotal + DORMANT.length + DEPRECATED.length)) * 100)
    };
  }

  /* ════════════════════════════════════════
     AUTO-LOAD ON PAGE NAVIGATION
  ════════════════════════════════════════ */
  function _observePageChanges() {
    var observer = new MutationObserver(function(mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (m.type === 'attributes' && m.attributeName === 'class') {
          var el = m.target;
          if (el.classList && el.classList.contains('active')) {
            var pageId = el.id;
            if (LAZY[pageId]) {
              loadForPage(pageId).catch(function(){});
            }
          }
        }
      }
    });

    // Observe all page containers
    var pages = document.querySelectorAll('.page');
    for (var j = 0; j < pages.length; j++) {
      observer.observe(pages[j], { attributes: true, attributeFilter: ['class'] });
    }
  }

  /* ════════════════════════════════════════
     INITIALIZATION
  ════════════════════════════════════════ */

  function init() {
    loadCore().then(function() {
      // Core loaded — app functional
      console.log('[ModuleLoader] Core modules loaded:', CRITICAL.length + ESSENTIAL.length);

      // Deferred loading
      setTimeout(function() {
        loadDeferred().then(function() {
          console.log('[ModuleLoader] All modules loaded. Report:', JSON.stringify(getReport()));
        });
      }, 1000);

      // Start observing page changes for lazy loading
      setTimeout(_observePageChanges, 2000);
    });
  }

  window.ModuleLoader = {
    loadScript: loadScript,
    loadList: loadList,
    loadForPage: loadForPage,
    loadCore: loadCore,
    loadDeferred: loadDeferred,
    isLoaded: isLoaded,
    getReport: getReport,
    init: init,

    // Classifications
    CRITICAL: CRITICAL,
    ESSENTIAL: ESSENTIAL,
    DEFERRED: DEFERRED,
    LAZY: LAZY,
    DORMANT: DORMANT,
    DEPRECATED: DEPRECATED
  };
})();
