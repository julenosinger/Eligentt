/**
 * BridgeRenderer — Bridge UI wrapper (Phase 2)
 * Attached to: window.BridgeRenderer
 */
(function () {
  'use strict';
  var _init = false, _subs = [];

  function initialize() {
    if (_init) return; _init = true;
    if (typeof EventBus !== 'undefined') {
      _subs.push(EventBus.on('PAGE_CHANGED', function (p) { if (p && p.page === 'bridge') render(); }));
      _subs.push(EventBus.on('BALANCE_REFRESHED', function () { render(); }));
      _subs.push(EventBus.on('CHAIN_CHANGED', function () { render(); }));
    }
  }
  function render() {
    try { if (typeof updateBridgeEst === 'function') updateBridgeEst(); } catch (_e) {}
    try { if (typeof refreshBridgeBalances === 'function') refreshBridgeBalances(); } catch (_e2) {}
    try { if (typeof renderXcHistory === 'function') renderXcHistory(); } catch (_e3) {}
  }
  function refresh() {
    try { if (typeof updateBridgeEst === 'function') updateBridgeEst(); } catch (_e) {}
    try { if (typeof refreshBridgeBalances === 'function') refreshBridgeBalances(); } catch (_e2) {}
  }
  function destroy() { _subs.forEach(function (s) { try { s.off(); } catch (_e) {} }); _subs = []; _init = false; }

  window.BridgeRenderer = { VERSION: '1.0.0', initialize: initialize, render: render, refresh: refresh, destroy: destroy };
})();
