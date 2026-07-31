/**
 * Elligentt PureModularAudit — Phase 19.5 Legacy Dependency Audit
 *
 * Scans ALL legacy functions, detects runtime usage, hidden dependencies,
 * direct calls, fallback calls, unregistered globals, and inline handlers.
 *
 * Cutover is NOT allowed if:
 *   UNKNOWN > 0
 *   ACTIVE LEGACY CALLS > 0
 *
 * Attached to: window.PureModularAudit
 *
 * @module PureModularAudit
 * @version 19.5.0
 */
(function () {
  'use strict';

  var ALL_LEGACY = [
    'executeSwap','executeBridgeOrTurbo','executeTurboBridge','signTx',
    'renderContacts','renderReports','renderInvoices','renderSchedules',
    'connectWalletConnect','disconnectWallet','refreshBalance','switchNetwork',
    'renderQueueTable','renderPayLinks','renderPoolList','renderXcHistory',
    'renderFeeRevenue','renderTemplates','updateSwapRate','updateBridgeEst',
    'checkDueSchedules','vaultRefreshUI','renderSwapTokenList','renderMyLPPositions',
    'openModal','closeModal','updateStats','updateWorkflowStep','initChainList',
    'updateSelectedCount','updateBottomBar','updatePlStats','updatePoolStats',
    'updateQueueStats','updateInvStats','invPreviewUpdate','showBatchSuccess',
    'loadPersistedRecipients','loadBatcherAddresses','renderTable',
    'autonomaInit','autonomaHandleCSV','autonomaHandleFile','autonomaNewChat',
    'autonomaSend','autonomaSendQuick','autonomaOptimizeSwap'
  ];

  function audit() {
    var report = {
      generatedAt: new Date().toISOString(),
      version: '19.5.0',
      totalLegacyFunctions: ALL_LEGACY.length,
      activeCalls: [],
      inactiveFunctions: [],
      fallbackCalls: [],
      unknownCalls: [],
      safeToRemove: [],
      blocked: [],
      keep: [],
      inlineHandlers: _scanInlineHandlers(),
      unregisteredGlobals: _scanGlobals(),
      hiddenDependencies: _scanHiddenDeps(),
      summary: null
    };

    ALL_LEGACY.forEach(function (name) {
      var status = _checkFunction(name);
      if (status.exists) {
        if (status.hasActiveCallers) {
          report.activeCalls.push(status);
        } else {
          report.inactiveFunctions.push(status);
        }
        if (status.hasFallback) {
          report.fallbackCalls.push(status);
        }
        if (status.classification === 'SAFE_REMOVE') {
          report.safeToRemove.push(status);
        } else if (status.classification === 'BLOCKED') {
          report.blocked.push(status);
        } else if (status.classification === 'KEEP') {
          report.keep.push(status);
        } else {
          report.unknownCalls.push(status);
        }
      }
    });

    report.summary = _generateSummary(report);
    return report;
  }

  function _checkFunction(name) {
    var entry = {
      name: name,
      exists: typeof window[name] === 'function',
      replacement: _getReplacement(name),
      hasActiveCallers: false,
      callCount: 0,
      hasFallback: false,
      isGuarded: false,
      classification: 'UNKNOWN'
    };

    if (!entry.exists) {
      entry.classification = 'SAFE_REMOVE';
      return entry;
    }

    entry.isGuarded = _isGuarded(name);
    entry.callCount = _estimateCallers(name);
    entry.hasActiveCallers = entry.callCount > 0;
    entry.hasFallback = _hasFallbackPath(name);

    if (entry.isGuarded && entry.replacement) {
      if (entry.hasActiveCallers) {
        entry.classification = 'BLOCKED';
      } else {
        entry.classification = 'SAFE_REMOVE';
      }
    } else if (!entry.replacement) {
      entry.classification = 'KEEP';
    } else {
      entry.classification = 'UNKNOWN';
    }

    return entry;
  }

  function _getReplacement(name) {
    var map = {};
    try {
      if (typeof PureExecutionGuard !== 'undefined') {
        map = PureExecutionGuard.getBlockMap();
        if (map[name]) return map[name].replacement;
      }
    } catch (_e) {}
    return null;
  }

  function _isGuarded(name) {
    try {
      if (typeof PureExecutionGuard !== 'undefined') {
        var check = PureExecutionGuard.isBlocked(name);
        return check.blocked;
      }
    } catch (_e) {}
    return false;
  }

  function _estimateCallers(name) {
    var count = 0;
    try {
      var all = document.querySelectorAll('script:not([src])');
      all.forEach(function (s) {
        if (s.textContent && s.textContent.indexOf(name) !== -1) {
          count += (s.textContent.match(new RegExp('\\b' + name + '\\b', 'g')) || []).length;
        }
      });
    } catch (_e) {}
    try {
      var body = document.body ? document.body.innerHTML : '';
      if (body.indexOf(name + '(') !== -1) count++;
    } catch (_e2) {}
    return count;
  }

  function _hasFallbackPath(name) {
    try {
      if (typeof CoreMigrate === 'undefined') return false;
      var src = CoreMigrate.toString();
      return src.indexOf(name) !== -1;
    } catch (_e) {}
    return false;
  }

  function _scanInlineHandlers() {
    var report = { onclick: 0, onchange: 0, oninput: 0, onkeyup: 0, onsubmit: 0, total: 0 };
    try {
      ['onclick','onchange','oninput','onkeyup','onsubmit'].forEach(function (attr) {
        report[attr] = document.querySelectorAll('[' + attr + ']').length;
      });
      report.total = report.onclick + report.onchange + report.oninput + report.onkeyup + report.onsubmit;
    } catch (_e) {}
    return report;
  }

  function _scanGlobals() {
    var report = { total: 0, allowed: 0, violations: [] };
    try {
      var keys = Object.keys(window).filter(function (k) {
        return k.indexOf('_') !== 0 && k.indexOf('$') === -1 && k.length < 50;
      });
      report.total = keys.length;
      keys.forEach(function (k) {
        try {
          if (typeof GlobalRegistryV2 !== 'undefined') {
            var check = GlobalRegistryV2.isAllowedGlobal(k);
            if (check.allowed) report.allowed++;
            else if (typeof window[k] === 'function' && k.indexOf('webkit') === -1 && k.indexOf('on') !== 0) {
              report.violations.push({ name: k, type: typeof window[k] });
            }
          }
        } catch (_e) {}
      });
    } catch (_e2) {}
    return report;
  }

  function _scanHiddenDeps() {
    var deps = [];
    try {
      if (typeof CoreMigrate !== 'undefined') {
        Object.keys(CoreMigrate).forEach(function (k) {
          if (k === 'VERSION') return;
          var fn = CoreMigrate[k];
          if (typeof fn === 'function') {
            var src = fn.toString();
            if (src.indexOf('try') !== -1 && src.indexOf('catch') !== -1) {
              deps.push({ name: 'CoreMigrate.' + k, hasLegacyFallback: true });
            }
          }
        });
      }
    } catch (_e) {}
    return { count: deps.length, items: deps };
  }

  function _generateSummary(report) {
    var canCutover = report.unknownCalls.length === 0 && report.activeCalls.length === 0;

    return {
      totalLegacyFunctions: report.totalLegacyFunctions,
      totalActiveCalls: report.activeCalls.length,
      totalFallbackCalls: report.fallbackCalls.length,
      totalUnknownCalls: report.unknownCalls.length,
      totalSafeToRemove: report.safeToRemove.length,
      totalBlocked: report.blocked.length,
      totalKeep: report.keep.length,
      inlineHandlersTotal: report.inlineHandlers.total,
      unregisteredGlobals: report.unregisteredGlobals.violations.length,
      hiddenDependencies: report.hiddenDependencies.count,
      cutoverAllowed: canCutover,
      cutoverBlockers: canCutover ? [] : [
        report.unknownCalls.length > 0 ? report.unknownCalls.length + ' UNKNOWN calls' : null,
        report.activeCalls.length > 0 ? report.activeCalls.length + ' ACTIVE calls' : null
      ].filter(Boolean)
    };
  }

  function quickAudit() {
    var a = audit();
    return {
      total: a.totalLegacyFunctions,
      active: a.summary.totalActiveCalls,
      unknown: a.summary.totalUnknownCalls,
      safe: a.summary.totalSafeToRemove,
      blocked: a.summary.totalBlocked,
      handlers: a.summary.inlineHandlersTotal,
      globals: a.summary.unregisteredGlobals,
      cutoverReady: a.summary.cutoverAllowed
    };
  }

  function getActiveFunctions() {
    return audit().activeCalls.map(function (f) { return f.name; });
  }

  function getBlockedFunctions() {
    return audit().blocked.map(function (f) { return f.name; });
  }

  window.PureModularAudit = {
    VERSION: '19.5.0',
    audit: audit,
    quickAudit: quickAudit,
    getActiveFunctions: getActiveFunctions,
    getBlockedFunctions: getBlockedFunctions,
    ALL_LEGACY: ALL_LEGACY
  };
})();
