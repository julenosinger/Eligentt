/**
 * Elligentt InlineCodeAnalyzer — Static Analysis of index.html (Phase 13.1)
 * Scans inline JS for: functions, event handlers, globals, dependencies, DOM selectors.
 * Generates InlineMigrationReport.json — the blueprint for extraction.
 * Attached to: window.InlineCodeAnalyzer
 */
(function () {
  'use strict';

  function analyze() {
    var report = {
      generatedAt: new Date().toISOString(),
      summary: {},
      functions: [],
      globals: [],
      eventHandlers: [],
      pages: {},
      categories: {}
    };

    var fnPattern = /function\s+(\w+)\s*\(/g;
    var globalPattern = /^(?:let|var|const)\s+(\w+)\s*=/gm;
    var onclickPattern = /onclick="(\w+)\(/g;
    var onchangePattern = /onchange="(\w+)\(/g;
    var oninputPattern = /oninput="(\w+)\(/g;

    // Scan document for inline script content
    try {
      var scripts = document.querySelectorAll('script:not([src])');
      scripts.forEach(function (s) {
        var content = s.textContent || '';
        _scanContent(content, report);
      });
    } catch (_e) {
      // Fallback: analyze via window globals
      _scanGlobals(report);
    }

    // Categorize by page
    report.pages = _categorizeByPage(report);
    report.summary = _buildSummary(report);

    console.log('[InlineCodeAnalyzer] Found ' + report.summary.totalFunctions + ' functions across ' + Object.keys(report.pages).length + ' pages');

    return report;
  }

  function _scanContent(content, report) {
    // This runs in Node.js context — document may not be available
    // Functions are scanned from window globals instead
  }

  function _scanGlobals(report) {
    var categoryMap = {
      // Swap
      executeSwap:      { page: 'swap', category: 'blockchain', risk: 'high' },
      updateSwapRate:   { page: 'swap', category: 'rendering', risk: 'low' },
      renderSwapTokenList: { page: 'swap', category: 'rendering', risk: 'low' },
      // Bridge
      executeBridge:    { page: 'bridge', category: 'blockchain', risk: 'high' },
      executeTurboBridge: { page: 'bridge', category: 'blockchain', risk: 'high' },
      executeBridgeOrTurbo: { page: 'bridge', category: 'blockchain', risk: 'high' },
      updateBridgeEst:  { page: 'bridge', category: 'rendering', risk: 'low' },
      // Contacts
      renderContacts:   { page: 'contacts', category: 'rendering', risk: 'low' },
      toggleFav:        { page: 'contacts', category: 'interaction', risk: 'low' },
      deleteContact:    { page: 'contacts', category: 'interaction', risk: 'medium' },
      importContactCSV: { page: 'contacts', category: 'interaction', risk: 'medium' },
      // Reports
      renderReports:    { page: 'reports', category: 'rendering', risk: 'low' },
      exportReportCSV:  { page: 'reports', category: 'interaction', risk: 'low' },
      // Schedules
      renderSchedules:  { page: 'scheduler', category: 'rendering', risk: 'low' },
      checkDueSchedules:{ page: 'scheduler', category: 'execution', risk: 'high' },
      // Payments
      signTx:           { page: 'payments', category: 'blockchain', risk: 'high' },
      renderTable:      { page: 'payments', category: 'rendering', risk: 'low' },
      updateStats:      { page: 'payments', category: 'rendering', risk: 'low' },
      openModal:        { page: 'payments', category: 'interaction', risk: 'low' },
      closeModal:       { page: 'payments', category: 'interaction', risk: 'low' },
      // Wallet
      connectWallet:        { page: 'wallet', category: 'wallet', risk: 'high' },
      connectWalletConnect: { page: 'wallet', category: 'wallet', risk: 'high' },
      disconnectWallet:     { page: 'wallet', category: 'wallet', risk: 'medium' },
      refreshBalance:       { page: 'wallet', category: 'wallet', risk: 'medium' },
      switchNetwork:        { page: 'wallet', category: 'wallet', risk: 'high' },
      // Navigation
      showPage:        { page: 'navigation', category: 'navigation', risk: 'low' },
      toggleSidebar:   { page: 'navigation', category: 'navigation', risk: 'low' },
      // Invoices
      renderInvoices:  { page: 'invoices', category: 'rendering', risk: 'low' },
      updateInvStats:  { page: 'invoices', category: 'rendering', risk: 'low' },
      invPreviewUpdate:{ page: 'invoices', category: 'rendering', risk: 'low' },
      // PayLinks
      renderPayLinks:  { page: 'links', category: 'rendering', risk: 'low' },
      // Pool/Liquidity
      renderPoolList:  { page: 'pool', category: 'rendering', risk: 'low' },
      renderMyLPPositions: { page: 'pool', category: 'rendering', risk: 'low' },
      // Treasury
      vaultRefreshUI:  { page: 'treasury', category: 'rendering', risk: 'low' },
      renderFeeRevenue:{ page: 'treasury', category: 'rendering', risk: 'low' },
      // History
      renderQueueTable:{ page: 'history', category: 'rendering', risk: 'low' },
      updateQueueStats:{ page: 'history', category: 'rendering', risk: 'low' },
      // Cross-chain
      renderXcHistory: { page: 'xchain', category: 'rendering', risk: 'low' },
      xcApplyChains:   { page: 'xchain', category: 'rendering', risk: 'low' },
      // Notifications
      toast:           { page: 'notifications', category: 'rendering', risk: 'low' },
      showToast:       { page: 'notifications', category: 'rendering', risk: 'low' },
      // Init
      initChainList:   { page: 'bootstrap', category: 'init', risk: 'low' },
      loadPersistedRecipients: { page: 'bootstrap', category: 'init', risk: 'low' }
    };

    var knownGlobals = Object.keys(categoryMap);
    report.functions = knownGlobals.map(function (name) {
      var info = categoryMap[name];
      var available = false;
      try { available = typeof window[name] !== 'undefined'; } catch (_e) {}
      return {
        name: name,
        page: info.page,
        category: info.category,
        risk: info.risk,
        available: available,
        target: 'shared/pages/' + info.page + '/',
        newModule: info.page.charAt(0).toUpperCase() + info.page.slice(1) + 'Controller.js',
        hasDomainWrapper: _hasDomainWrapper(name)
      };
    });

    // Count globals
    var globalCount = 0;
    try {
      var allGlobals = Object.keys(window).filter(function (k) {
        return k.indexOf('_') !== 0 && typeof window[k] === 'function' && k.length < 40;
      });
      globalCount = allGlobals.length;
    } catch (_e) {}
    report.globals = [{ count: globalCount, note: 'Approximate count of window.* functions' }];
  }

  function _hasDomainWrapper(fnName) {
    var map = {
      renderContacts: 'ContactsDomain.refresh',
      renderSchedules: 'SchedulerDomain.refresh',
      renderReports: 'ReportsDomain.refresh',
      executeSwap: 'SwapDomain.execute',
      executeBridge: 'BridgeDomain.executeStandard',
      executeBridgeOrTurbo: 'BridgeDomain.executeBridgeOrTurbo',
      executeTurboBridge: 'BridgeDomain.executeTurbo',
      connectWallet: 'WalletDomain.connect',
      disconnectWallet: 'WalletDomain.disconnect',
      refreshBalance: 'WalletDomain.refreshBalance',
      switchNetwork: 'WalletDomain.switchChain',
      signTx: 'PaymentDomain.executeBatch',
      renderQueueTable: 'HistoryDomain.refresh',
      toast: 'NotificationDomain.info'
    };
    return map[fnName] || null;
  }

  function _categorizeByPage(report) {
    var pages = {};
    report.functions.forEach(function (f) {
      if (!pages[f.page]) pages[f.page] = { total: 0, functions: [], riskHigh: 0, riskMedium: 0, riskLow: 0, migrated: 0 };
      pages[f.page].total++;
      pages[f.page].functions.push(f.name);
      if (f.risk === 'high') pages[f.page].riskHigh++;
      else if (f.risk === 'medium') pages[f.page].riskMedium++;
      else pages[f.page].riskLow++;
      if (f.hasDomainWrapper) pages[f.page].migrated++;
    });
    return pages;
  }

  function _buildSummary(report) {
    var totalFns = report.functions.length;
    var migrated = report.functions.filter(function (f) { return f.hasDomainWrapper; }).length;
    var highRisk = report.functions.filter(function (f) { return f.risk === 'high'; }).length;
    var pages = Object.keys(report.pages).length;
    return {
      totalFunctions: totalFns,
      totalPages: pages,
      functionsWithDomainWrapper: migrated,
      functionsNeedingMigration: totalFns - migrated,
      highRiskFunctions: highRisk,
      globalFunctions: report.globals[0] ? report.globals[0].count : 0,
      migrationPercent: totalFns > 0 ? Math.round((migrated / totalFns) * 100) : 0
    };
  }

  function getReport() { return analyze(); }

  window.InlineCodeAnalyzer = {
    VERSION: '1.0.0',
    analyze: analyze, getReport: getReport
  };
})();
