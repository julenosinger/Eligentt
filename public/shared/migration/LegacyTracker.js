/**
 * Elligentt LegacyTracker — Migration Coverage & Dead Code Detection (Phase 7)
 * Tracks: migrated/pending/deprecated/dead functions. Generates coverage report.
 * Attached to: window.LegacyTracker
 */
(function () {
  'use strict';

  var _functions = {}; // name → { status, oldRef, newRef, migratedAt }

  function track(name, oldRef, newRef, status) {
    _functions[name] = {
      name: name,
      status: status || 'pending', // 'pending' | 'migrated' | 'deprecated' | 'dual'
      oldAvailable: typeof oldRef !== 'undefined' && oldRef !== null,
      newAvailable: typeof newRef !== 'undefined' && newRef !== null,
      migratedAt: status === 'migrated' ? Date.now() : null
    };
  }

  function markMigrated(name) { if (_functions[name]) { _functions[name].status = 'migrated'; _functions[name].migratedAt = Date.now(); } }
  function markDeprecated(name) { if (_functions[name]) _functions[name].status = 'deprecated'; }

  function getStatus(name) { return _functions[name] || null; }

  function getCoverage() {
    var all = Object.keys(_functions);
    var migrated = all.filter(function (k) { return _functions[k].status === 'migrated'; });
    var pending = all.filter(function (k) { return _functions[k].status === 'pending'; });
    var deprecated = all.filter(function (k) { return _functions[k].status === 'deprecated'; });
    var dual = all.filter(function (k) { return _functions[k].status === 'dual'; });
    return {
      total: all.length,
      migrated: migrated.length,
      pending: pending.length,
      deprecated: deprecated.length,
      dual: dual.length,
      percent: all.length > 0 ? Math.round((migrated.length / all.length) * 100) : 0,
      migratedList: migrated,
      pendingList: pending
    };
  }

  function getAll() { return Object.assign({}, _functions); }
  function clear() { _functions = {}; }

  // Auto-track known legacy functions
  var KNOWN = [
    'renderContacts', 'renderSchedules', 'renderQueueTable', 'renderPayLinks', 'renderInvoices',
    'renderReports', 'renderTemplates', 'renderTable', 'renderPoolList', 'renderMyLPPositions',
    'renderXcHistory', 'renderFeeRevenue', 'renderSwapTokenList',
    'updateSwapRate', 'updateBridgeEst', 'updateQueueStats', 'updateInvStats', 'updateStats',
    'checkDueSchedules', 'loadPersistedRecipients', 'loadBatcherAddresses',
    'connectWallet', 'disconnectWallet', 'refreshBalance', 'switchNetwork',
    'executeSwap', 'executeBridge', 'executeBridgeOrTurbo', 'executeTurboBridge',
    'signTx', 'openModal', 'closeModal', 'toast', 'showToast', 'showPage',
    'vaultRefreshUI', 'scheduleCreate', 'scheduleUpdate', 'scheduleDelete',
    'AIWallet.validateIntent', 'AIWallet.submitIntent', 'AIWallet.executeIntent',
    'AutonomaCore.process'
  ];

  KNOWN.forEach(function (k) { track(k, typeof window[k] !== 'undefined' ? window[k] : null, null, 'pending'); });

  window.LegacyTracker = {
    VERSION: '1.0.0', track: track, markMigrated: markMigrated, markDeprecated: markDeprecated,
    getStatus: getStatus, getCoverage: getCoverage, getAll: getAll, clear: clear
  };
})();
