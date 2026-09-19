/**
 * Elligentt GlobalCleanupManager — Classify KEEP | MIGRATE for All window Globals (Phase 18.3)
 * Attached to: window.GlobalCleanupManager
 */
(function () {
  'use strict';

  /** Globals that MUST remain on window (infrastructure) */
  var KEEP = [
    'App', 'EventBus', 'AppBootstrap', 'ApplicationKernel', 'SystemManager',
    'ethers', 'DOMPurify', 'QRCode', 'toast', 'showToast', 'showPage',
    'RuntimeMode', 'ProductionConfig', 'ProductionGuard',
    'GlobalRegistry', 'GlobalCleanupManager'
  ];

  /** Globals that have been migrated to Stores and can be deprecated */
  var MIGRATE = [
    { name: 'walletAddress', target: 'WalletStore.get("address")' },
    { name: 'activeChainId', target: 'WalletStore.get("chainId")' },
    { name: 'recipients',    target: 'PaymentStore.get("recipients")' },
    { name: 'swapAmount',    target: 'SwapStore.get("amount")' },
    { name: 'schedules',     target: 'SchedulerDomain.getAll()' },
    { name: 'contacts',      target: 'ContactsDomain.getAll()' },
    { name: 'txHistory',     target: 'HistoryDomain.getAll()' }
  ];

  function classifyAll() {
    var report = { keep: [], migrate: [], unknown: [], total: 0, generatedAt: new Date().toISOString() };

    try {
      var allKeys = Object.keys(window);
      report.total = allKeys.length;

      allKeys.forEach(function (k) {
        if (KEEP.indexOf(k) !== -1 || k.indexOf('_') === 0 || k.length > 50) return;
        if (typeof window[k] === 'object' || typeof window[k] === 'function') {
          var migrated = MIGRATE.find(function (m) { return m.name === k; });
          if (migrated) {
            report.migrate.push({ name: k, target: migrated.target });
          } else if (k.length < 40 && k.indexOf('$') === -1 && k.indexOf('webkit') === -1 && k.indexOf('on') !== 0) {
            report.unknown.push({ name: k, type: typeof window[k] });
          }
        }
      });
    } catch (_e) {}

    report.keepCount = report.keep.length;
    report.migrateCount = report.migrate.length;
    report.unknownCount = report.unknown.length;

    console.log('[GlobalCleanupManager] ' + report.migrateCount + ' migratable. ' + report.unknownCount + ' unknown. KEEP: ' + KEEP.length);
    return report;
  }

  function getKeepList() { return KEEP.slice(); }
  function getMigrateList() { return MIGRATE.slice(); }

  window.GlobalCleanupManager = {
    VERSION: '18.0.0',
    KEEP: KEEP, MIGRATE: MIGRATE,
    classifyAll: classifyAll, getKeepList: getKeepList, getMigrateList: getMigrateList
  };
})();
