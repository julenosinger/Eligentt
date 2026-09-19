/**
 * AIWallet VaultEngine — Vault Allocations & Gas Wrapper (Phase 4)
 * Attached to: window.AIWVaultEngine
 */
(function () {
  'use strict';
  var _init = false, _subs = [];

  function initialize() {
    if (_init) return; _init = true;
    if (typeof EventBus !== 'undefined') {
      _subs.push(EventBus.on('BALANCE_REFRESHED', function () { render(); }));
    }
  }

  function setAllocation() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.setVaultAlloc) { AIWallet.setVaultAlloc(); return true; } } catch (_e) {}
    return false;
  }

  function getVaultView(token) {
    try { if (typeof AIWallet !== 'undefined' && AIWallet._vaultView) return AIWallet._vaultView(token); } catch (_e) {}
    return null;
  }

  function getGasConfig() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet._getGasCfg) return AIWallet._getGasCfg(); } catch (_e) {}
    return null;
  }

  function getGasStatus() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet._getGasStatus) return AIWallet._getGasStatus(); } catch (_e) {}
    return null;
  }

  function saveGasConfig() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.saveGasCfg) { AIWallet.saveGasCfg(); return true; } } catch (_e) {}
    return false;
  }

  function topupNow() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.topupNow) { AIWallet.topupNow(); return true; } } catch (_e) {}
    return false;
  }

  function toggleTopup() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.toggleTopup) AIWallet.toggleTopup(); } catch (_e) {}
  }

  function render() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.renderVaultPanel) AIWallet.renderVaultPanel(); } catch (_e) {}
  }

  function refresh() { render(); }
  function destroy() { _subs.forEach(function (s) { try { s.off(); } catch (_e) {} }); _subs = []; _init = false; }

  window.AIWVaultEngine = {
    VERSION: '1.0.0',
    initialize: initialize, setAllocation: setAllocation, getVaultView: getVaultView,
    getGasConfig: getGasConfig, getGasStatus: getGasStatus, saveGasConfig: saveGasConfig,
    topupNow: topupNow, toggleTopup: toggleTopup,
    render: render, refresh: refresh, destroy: destroy
  };
})();
