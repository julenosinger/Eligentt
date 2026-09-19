/**
 * TreasuryDomain — Vault & treasury orchestration (Phase 3)
 * Wraps existing treasury/vault functions. Never duplicates logic.
 * Attached to: window.TreasuryDomain
 */
(function () {
  'use strict';
  var _init = false;

  function initialize() { if (_init) return; _init = true; }

  function getVaultBalance(token) {
    try {
      if (typeof VaultStore !== 'undefined' && VaultStore.get) return VaultStore.get();
    } catch (_e) {}
    return null;
  }

  function loadVaultState() {
    try { if (typeof vaultRefreshUI === 'function') vaultRefreshUI(); } catch (_e) {}
  }

  async function refreshVault() {
    try { if (typeof vaultRefreshAll === 'function') await vaultRefreshAll(); } catch (_e) { try { if (typeof vaultRefreshUI === 'function') vaultRefreshUI(); } catch (_e2) {} }
  }

  function getFeeRevenue() {
    try { if (typeof renderFeeRevenue === 'function') renderFeeRevenue(); } catch (_e) {}
    return null;
  }

  function executeDeposit(amount, token) {
    try {
      if (typeof AIWallet !== 'undefined' && AIWallet.fundingSubmit) { AIWallet.fundingSubmit(); return true; }
    } catch (e) {}
    return false;
  }

  function refresh() {
    try { if (typeof vaultRefreshUI === 'function') vaultRefreshUI(); } catch (_e) {}
    try { if (typeof renderFeeRevenue === 'function') renderFeeRevenue(); } catch (_e2) {}
  }

  function destroy() { _init = false; }

  window.TreasuryDomain = {
    VERSION: '1.0.0',
    initialize: initialize, getVaultBalance: getVaultBalance, loadVaultState: loadVaultState,
    refreshVault: refreshVault, getFeeRevenue: getFeeRevenue, executeDeposit: executeDeposit,
    refresh: refresh, destroy: destroy
  };
})();
