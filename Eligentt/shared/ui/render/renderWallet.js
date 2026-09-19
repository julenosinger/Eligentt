/**
 * WalletRenderer — Wallet UI rendering wrapper (Phase 2)
 * Delegates to existing render functions. Adds EventBus hooks.
 * Attached to: window.WalletRenderer
 */
(function () {
  'use strict';
  var _init = false, _subs = [];

  function initialize() {
    if (_init) return; _init = true;
    if (typeof EventBus !== 'undefined') {
      _subs.push(EventBus.on('WALLET_CONNECTED', function () { refresh(); }));
      _subs.push(EventBus.on('WALLET_DISCONNECTED', function () { refresh(); }));
      _subs.push(EventBus.on('BALANCE_REFRESHED', function () { render(); }));
      _subs.push(EventBus.on('CHAIN_CHANGED', function () { render(); }));
    }
  }
  function render() {
    try { if (typeof updateWalletBadges === 'function') updateWalletBadges(); } catch (_e) {}
    try { if (typeof updateNetworkBadge === 'function' && typeof activeChainId !== 'undefined') updateNetworkBadge(activeChainId); } catch (_e) {}
  }
  function refresh() {
    try { if (typeof refreshBalance === 'function') refreshBalance(); } catch (_e) {}
    render();
  }
  function destroy() { _subs.forEach(function (s) { try { s.off(); } catch (_e) {} }); _subs = []; _init = false; }

  window.WalletRenderer = { VERSION: '1.0.0', initialize: initialize, render: render, refresh: refresh, destroy: destroy };
})();
