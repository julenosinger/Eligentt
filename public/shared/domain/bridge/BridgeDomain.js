/**
 * BridgeDomain — Cross-chain bridge orchestration (Phase 3)
 * Wraps existing bridge/turbo bridge execution. Never duplicates logic.
 * Attached to: window.BridgeDomain
 */
(function () {
  'use strict';
  var _init = false;

  function initialize() { if (_init) return; _init = true; }

  function validate(params) {
    var p = params || {};
    if (!p.amount || Number(p.amount) <= 0) return { valid: false, reason: 'Invalid amount' };
    if (!p.fromChain || !p.toChain) return { valid: false, reason: 'Source and destination chains required' };
    if (p.fromChain === p.toChain) return { valid: false, reason: 'Same chain' };
    try {
      if (typeof walletAddress === 'undefined' || !walletAddress) return { valid: false, reason: 'Wallet not connected' };
    } catch (_e) { return { valid: false, reason: 'Wallet error' }; }
    return { valid: true };
  }

  function executeStandard(fromChain, toChain, amount, token) {
    try {
      if (typeof executeBridge === 'function') { executeBridge(); return true; }
    } catch (e) {
      try { if (typeof ErrorHandler !== 'undefined') ErrorHandler.handle(e, { source: 'bridge', operation: 'standard' }); } catch (_e) {}
    }
    return false;
  }

  function executeTurbo(srcChainId, amount) {
    try {
      if (typeof executeTurboBridge === 'function') { executeTurboBridge(); return true; }
    } catch (e) {
      try { if (typeof ErrorHandler !== 'undefined') ErrorHandler.handle(e, { source: 'bridge', operation: 'turbo' }); } catch (_e) {}
    }
    return false;
  }

  function executeBridgeOrTurbo() {
    try {
      if (typeof executeBridgeOrTurbo === 'function') { executeBridgeOrTurbo(); return true; }
    } catch (e) {}
    return false;
  }

  function getEstimate() {
    try { if (typeof updateBridgeEst === 'function') updateBridgeEst(); } catch (_e) {}
    return null;
  }

  function refresh() {
    try { if (typeof updateBridgeEst === 'function') updateBridgeEst(); } catch (_e) {}
    try { if (typeof refreshBridgeBalances === 'function') refreshBridgeBalances(); } catch (_e2) {}
  }

  function destroy() { _init = false; }

  window.BridgeDomain = {
    VERSION: '1.0.0',
    initialize: initialize, validate: validate, getEstimate: getEstimate,
    executeStandard: executeStandard, executeTurbo: executeTurbo,
    executeBridgeOrTurbo: executeBridgeOrTurbo, refresh: refresh, destroy: destroy
  };
})();
