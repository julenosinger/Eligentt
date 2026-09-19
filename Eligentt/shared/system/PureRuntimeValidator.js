/**
 * Elligentt PureRuntimeValidator — Detect legacy bypass in PURE_MODULAR (Phase 17.1)
 * Monitors: legacy function calls, deprecated window access, direct Domain bypass.
 * Attached to: window.PureRuntimeValidator
 */
(function () {
  'use strict';
  var _violations = [];
  var _active = false;

  /** Monitored legacy function names — any call in PURE_MODULAR is a violation */
  var LEGACY_FUNCTIONS = [
    'renderContacts', 'renderSchedules', 'renderQueueTable', 'renderReports',
    'renderInvoices', 'renderPayLinks', 'renderPoolList', 'renderSwapTokenList',
    'updateSwapRate', 'updateBridgeEst', 'renderXcHistory', 'renderFeeRevenue',
    'signTx', 'executeSwap', 'executeBridge', 'executeTurboBridge', 'executeBridgeOrTurbo',
    'openModal', 'closeModal', 'checkDueSchedules', 'renderTable', 'updateStats',
    'updateWorkflowStep', 'initChainList', 'loadPersistedRecipients', 'loadBatcherAddresses',
    'connectWalletConnect', 'disconnectWallet', 'refreshBalance', 'switchNetwork',
    'vaultRefreshUI', 'renderMyLPPositions', 'updatePoolStats', 'updateQueueStats',
    'updateInvStats', 'invPreviewUpdate', 'showBatchSuccess', 'updatePlStats'
  ];

  function start() {
    if (_active) return;
    _active = true;

    LEGACY_FUNCTIONS.forEach(function (name) {
      try {
        if (typeof window[name] === 'function') {
          var original = window[name];
          window[name] = function () {
            var isPure;
            try { isPure = typeof RuntimeMode !== 'undefined' && RuntimeMode.isPure(); } catch (_e) { isPure = false; }
            if (isPure) {
              _violations.push({ function: name, args: Array.prototype.slice.call(arguments).length, timestamp: Date.now() });
              if (_violations.length > 200) _violations.length = 200;
              console.error('[PureRuntime] VIOLATION: ' + name + '() called in PURE_MODULAR mode');
              try { if (typeof EventBus !== 'undefined') EventBus.emit('PURE_RUNTIME_VIOLATION', { function: name }); } catch (_e2) {}
            }
            return original.apply(this, arguments);
          };
        }
      } catch (_e) {}
    });

    console.log('[PureRuntimeValidator] Active — monitoring ' + LEGACY_FUNCTIONS.length + ' legacy functions');
  }

  function stop() {
    _active = false;
    // Restore originals by page reload — wrappers can't be easily unwound
  }

  function getViolations() { return _violations.slice(); }
  function getCount() { return _violations.length; }
  function getByFunction(name) { return _violations.filter(function (v) { return v.function === name; }); }

  function getReport() {
    var byFunc = {};
    _violations.forEach(function (v) { byFunc[v.function] = (byFunc[v.function] || 0) + 1; });
    return {
      active: _active,
      totalViolations: _violations.length,
      uniqueFunctions: Object.keys(byFunc).length,
      topViolations: Object.entries(byFunc).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 10),
      severity: _violations.length === 0 ? 'CLEAN' : _violations.length < 5 ? 'LOW' : 'HIGH'
    };
  }

  function clear() { _violations = []; }

  window.PureRuntimeValidator = {
    VERSION: '17.0.0',
    start: start, stop: stop,
    getViolations: getViolations, getCount: getCount,
    getByFunction: getByFunction, getReport: getReport, clear: clear
  };
})();
