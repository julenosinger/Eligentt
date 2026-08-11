/**
 * Elligentt AgentGovernanceManager — AI Agent Governance (Phase 17.7)
 * Capability registry, permission matrix, execution limits, reputation.
 * Attached to: window.AgentGovernanceManager
 */
(function () {
  'use strict';
  var _agents = {};

  function register(agentId, config) {
    _agents[agentId] = {
      id: agentId,
      capabilities: config.capabilities || [],
      permissions: config.permissions || [],
      limits: config.limits || { maxOpsPerDay: 50, maxAmountUSD: 10000 },
      reputation: { score: 100, completions: 0, failures: 0 },
      status: 'registered',
      registeredAt: Date.now()
    };
    try { if (typeof AgentManager !== 'undefined') AgentManager.setStatus(agentId, 'registered'); } catch (_e) {}
    return true;
  }

  function canExecute(agentId, capability, params) {
    var agent = _agents[agentId];
    if (!agent) return { allowed: false, reason: 'Agent not registered' };
    if (agent.capabilities.indexOf(capability) === -1) return { allowed: false, reason: 'Capability not granted' };

    var amount = Number(params.amount) || 0;
    if (amount > agent.limits.maxAmountUSD) return { allowed: false, reason: 'Exceeds max amount limit' };

    return { allowed: true };
  }

  function recordExecution(agentId, success, latencyMs) {
    var agent = _agents[agentId];
    if (!agent) return;
    agent.reputation.completions++;
    if (!success) agent.reputation.failures++;
    var total = agent.reputation.completions;
    agent.reputation.score = Math.max(0, Math.round(100 - (agent.reputation.failures / Math.max(total, 1)) * 100));
    try { if (typeof AgentManager !== 'undefined') AgentManager.recordExecution(agentId, latencyMs || 0, success); } catch (_e) {}
  }

  function getAgent(agentId) { return _agents[agentId] ? Object.assign({}, _agents[agentId]) : null; }
  function getAll() { return Object.keys(_agents).map(function (k) { return Object.assign({}, _agents[k]); }); }
  function getReputation(agentId) { return _agents[agentId] ? _agents[agentId].reputation : null; }

  function getGovernanceReport() {
    return {
      totalAgents: Object.keys(_agents).length,
      activeAgents: Object.values(_agents).filter(function (a) { return a.status === 'active'; }).length,
      totalCapabilities: Object.values(_agents).reduce(function (s, a) { return s + a.capabilities.length; }, 0),
      agents: Object.keys(_agents).map(function (k) { return { id: k, reputation: _agents[k].reputation.score }; })
    };
  }

  // Register built-in agents
  register('autonoma', { capabilities: ['nlp', 'reasoning', 'planning', 'execution', 'memory'], permissions: ['intent_create', 'intent_read'], limits: { maxOpsPerDay: 100, maxAmountUSD: 50000 } });
  register('treasury_agent', { capabilities: ['treasury', 'vault', 'allocation'], permissions: ['treasury_read', 'treasury_allocate'], limits: { maxOpsPerDay: 20, maxAmountUSD: 100000 } });
  register('bridge_agent', { capabilities: ['bridge', 'cctp', 'crosschain'], permissions: ['bridge_execute', 'bridge_monitor'], limits: { maxOpsPerDay: 30, maxAmountUSD: 50000 } });

  window.AgentGovernanceManager = {
    VERSION: '17.0.0',
    register: register, canExecute: canExecute, recordExecution: recordExecution,
    getAgent: getAgent, getAll: getAll, getReputation: getReputation,
    getGovernanceReport: getGovernanceReport
  };
})();
