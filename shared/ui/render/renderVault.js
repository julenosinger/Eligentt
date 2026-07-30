/**
 * VaultRenderer — AI Wallet Vault & Gas UI wrapper (Phase 2)
 * Attached to: window.VaultRenderer
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
  function render() {
    try {
      if (typeof AIWallet !== 'undefined' && AIWallet.renderVaultPanel) AIWallet.renderVaultPanel();
    } catch (_e) {}
  }
  function refresh() { render(); }
  function destroy() { _subs.forEach(function (s) { try { s.off(); } catch (_e) {} }); _subs = []; _init = false; }

  window.VaultRenderer = { VERSION: '1.0.0', initialize: initialize, render: render, refresh: refresh, destroy: destroy };
})();
