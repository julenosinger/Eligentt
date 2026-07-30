/**
 * Elligentt ModuleHealth — Plugin Health Monitor (Phase 5)
 * Tracks: initialized/running/stopped/error/recovering/disabled.
 * Attached to: window.ModuleHealth
 */
(function () {
  'use strict';
  var _health = {}; // pluginId → { status, lastCheck, errors, warnings, uptime }

  var STATUSES = ['initialized', 'running', 'stopped', 'error', 'recovering', 'disabled'];

  function setHealth(pluginId, status, detail) {
    _health[pluginId] = {
      status: status,
      lastCheck: Date.now(),
      errors: (detail && detail.errors) || 0,
      warnings: (detail && detail.warnings) || 0,
      detail: detail || {}
    };
    try {
      if (typeof EventBus !== 'undefined') EventBus.emit('PLUGIN_HEALTH_CHANGED', { id: pluginId, status: status, detail: detail });
    } catch (_e) {}
  }

  function getHealth(pluginId) { return _health[pluginId] || { status: 'unknown' }; }
  function getAll() { return Object.assign({}, _health); }
  function getByStatus(status) {
    var result = {};
    var keys = Object.keys(_health);
    for (var i = 0; i < keys.length; i++) { if (_health[keys[i]].status === status) result[keys[i]] = _health[keys[i]]; }
    return result;
  }

  function getSummary() {
    var summary = { total: Object.keys(_health).length };
    STATUSES.forEach(function (s) { summary[s] = 0; });
    var keys = Object.keys(_health);
    for (var i = 0; i < keys.length; i++) {
      var st = _health[keys[i]].status;
      if (summary[st] !== undefined) summary[st]++; else summary[st] = 1;
    }
    return summary;
  }

  function clear() { _health = {}; }

  window.ModuleHealth = {
    VERSION: '1.0.0',
    STATUSES: STATUSES, setHealth: setHealth, getHealth: getHealth,
    getAll: getAll, getByStatus: getByStatus, getSummary: getSummary, clear: clear
  };
})();
