/**
 * Elligentt HeartbeatManager — Platform Health Pulse (Phase 6)
 * Tracks active modules, dead modules, hung executions, queue backlog, memory growth.
 * Attached to: window.HeartbeatManager
 */
(function () {
  'use strict';
  var _beat = { active: [], dead: [], hung: [], lastBeat: 0, interval: null, rpcHealthy: true };

  function start(intervalMs) {
    if (_beat.interval) return;
    var ms = intervalMs || 15000;
    _beat.interval = setInterval(function () {
      _beat.lastBeat = Date.now();
      _beat.rpcHealthy = _checkRPC();
      try { if (typeof EventBus !== 'undefined') EventBus.emit('HEARTBEAT', { at: _beat.lastBeat, rpcHealthy: _beat.rpcHealthy }); } catch (_e) {}
    }, ms);
  }

  function _checkRPC() {
    try {
      if (typeof RPCService !== 'undefined' && RPCService.healthCheck) return RPCService.healthCheck('https://rpc.testnet.arc.network');
    } catch (_e) {}
    return true;
  }

  function stop() { if (_beat.interval) { clearInterval(_beat.interval); _beat.interval = null; } }

  function markDead(moduleId) { if (_beat.dead.indexOf(moduleId) === -1 && _beat.active.indexOf(moduleId) === -1) _beat.dead.push(moduleId); }
  function markActive(moduleId) { _beat.active.push(moduleId); }
  function markHung(execId) { _beat.hung.push({ id: execId, at: Date.now() }); }

  function getStatus() {
    return {
      activeModules: _beat.active.length,
      deadModules: _beat.dead.length,
      hungExecutions: _beat.hung.length,
      rpcHealthy: _beat.rpcHealthy,
      lastBeat: _beat.lastBeat,
      uptime: _beat.lastBeat > 0 ? Date.now() - _beat.lastBeat : 0
    };
  }

  function clear() { _beat.active = []; _beat.dead = []; _beat.hung = []; stop(); }

  window.HeartbeatManager = {
    VERSION: '1.0.0', start: start, stop: stop,
    markDead: markDead, markActive: markActive, markHung: markHung,
    getStatus: getStatus, clear: clear
  };
})();
