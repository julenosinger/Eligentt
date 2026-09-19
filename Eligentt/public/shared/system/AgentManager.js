/**
 * Elligentt AgentManager — Multi-Agent Registry (Phase 6)
 * Supports multiple AI agents: Autonoma, Treasury, Bridge, Swap, custom.
 * Each agent: id, version, capabilities, health, status, permissions, metrics.
 * Attached to: window.AgentManager
 */
(function () {
  'use strict';
  var _agents = {};

  function register(agent) {
    if (!agent || !agent.id) return false;
    if (_agents[agent.id]) return false;
    _agents[agent.id] = {
      id: agent.id, name: agent.name || agent.id, version: agent.version || '1.0.0',
      type: agent.type || 'ai', status: 'registered', health: 'initializing',
      capabilities: agent.capabilities || [], permissions: agent.permissions || [],
      metrics: { executions: 0, failures: 0, avgLatencyMs: 0 }, registeredAt: Date.now(), meta: agent.meta || {}
    };
    try { if (typeof EventBus !== 'undefined') EventBus.emit('AGENT_REGISTERED', { id: agent.id }); } catch (_e) {}
    return true;
  }

  function get(id) { return _agents[id] || null; }
  function getAll() { return Object.values(_agents); }
  function getCount() { return Object.keys(_agents).length; }
  function getByCapability(cap) { return getAll().filter(function (a) { return a.capabilities.indexOf(cap) !== -1; }); }

  function setStatus(id, status) { if (_agents[id]) _agents[id].status = status; }
  function setHealth(id, health) { if (_agents[id]) _agents[id].health = health; }
  function recordExecution(id, latencyMs, success) {
    var a = _agents[id]; if (!a) return;
    a.metrics.executions++;
    if (!success) a.metrics.failures++;
    a.metrics.avgLatencyMs = a.metrics.executions > 0 ? Math.round(((a.metrics.avgLatencyMs * (a.metrics.executions - 1)) + latencyMs) / a.metrics.executions) : latencyMs;
  }

  function getMetrics(id) { return _agents[id] ? _agents[id].metrics : null; }
  function getAllMetrics() { var r = {}; Object.keys(_agents).forEach(function (k) { r[k] = _agents[k].metrics; }); return r; }

  function clear() { _agents = {}; }

  // Register built-in agents
  try { register({ id: 'autonoma', name: 'Autonoma', type: 'ai', capabilities: ['nlp', 'reasoning', 'planning', 'execution'] }); } catch (_e) {}
  try { register({ id: 'treasury_agent', name: 'Treasury Agent', type: 'ai', capabilities: ['treasury', 'vault', 'allocation'] }); } catch (_e2) {}
  try { register({ id: 'bridge_agent', name: 'Bridge Agent', type: 'ai', capabilities: ['bridge', 'cctp', 'crosschain'] }); } catch (_e3) {}

  window.AgentManager = {
    VERSION: '1.0.0', register: register, get: get, getAll: getAll, getCount: getCount,
    getByCapability: getByCapability, setStatus: setStatus, setHealth: setHealth,
    recordExecution: recordExecution, getMetrics: getMetrics, getAllMetrics: getAllMetrics, clear: clear
  };
})();
