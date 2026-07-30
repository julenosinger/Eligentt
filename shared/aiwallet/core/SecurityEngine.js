/**
 * AIWallet SecurityEngine — Emergency Stop, Permissions, Risk Wrapper (Phase 4)
 * Attached to: window.AIWSecurityEngine
 */
(function () {
  'use strict';
  var _init = false;

  function initialize() { if (_init) return; _init = true; }

  function toggleEmergencyStop() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.toggleEmergencyStop) AIWallet.toggleEmergencyStop(); } catch (_e) {}
  }

  function isEmergencyStopped() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.isEmergencyStopped) return AIWallet.isEmergencyStopped(); } catch (_e) {}
    return false;
  }

  function toggleAutoExec() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.toggleAutoExec) AIWallet.toggleAutoExec(); } catch (_e) {}
  }

  function setMaxRisk(level) {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.setMaxRisk) AIWallet.setMaxRisk(level); } catch (_e) {}
  }

  function togglePauseAgent() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.togglePauseAgent) AIWallet.togglePauseAgent(); } catch (_e) {}
  }

  function revokeAllPermissions() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.revokeAllPerms) AIWallet.revokeAllPerms(); } catch (_e) {}
  }

  function grantPermission() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.grantPermission) AIWallet.grantPermission(); } catch (_e) {}
  }

  function getMode() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.getMode) return AIWallet.getMode(); } catch (_e) {}
    return 'hybrid';
  }

  function setMode(mode) {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.setMode) { AIWallet.setMode(mode); return true; } } catch (_e) {}
    return false;
  }

  function render() {
    try { if (typeof AIWallet !== 'undefined' && AIWallet.renderStatus) AIWallet.renderStatus(); } catch (_e) {}
    try { if (typeof AIWallet !== 'undefined' && AIWallet.renderSecurity) AIWallet.renderSecurity(); } catch (_e2) {}
  }

  function refresh() { render(); }
  function destroy() { _init = false; }

  window.AIWSecurityEngine = {
    VERSION: '1.0.0',
    initialize: initialize,
    toggleEmergencyStop: toggleEmergencyStop, isEmergencyStopped: isEmergencyStopped,
    toggleAutoExec: toggleAutoExec, setMaxRisk: setMaxRisk,
    togglePauseAgent: togglePauseAgent, revokeAllPermissions: revokeAllPermissions,
    grantPermission: grantPermission, getMode: getMode, setMode: setMode,
    render: render, refresh: refresh, destroy: destroy
  };
})();
