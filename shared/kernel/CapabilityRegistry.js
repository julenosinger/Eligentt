/**
 * Elligentt CapabilityRegistry — Capability Discovery & Access Control (Phase 5)
 * Plugins register capabilities. Kernel grants access. Tracks declarative feature map.
 * Attached to: window.CapabilityRegistry
 */
(function () {
  'use strict';
  var _caps = {}; // capabilityId → { provider, description }
  var _grants = {}; // pluginId → [capabilityId]

  function registerCapability(id, providerId, description) {
    _caps[id] = { provider: providerId, description: description || '', registeredAt: Date.now() };
    try { if (typeof EventBus !== 'undefined') EventBus.emit('CAPABILITY_REGISTERED', { id: id, provider: providerId }); } catch (_e) {}
  }

  function grant(pluginId, capabilityId) {
    if (!_grants[pluginId]) _grants[pluginId] = [];
    if (_grants[pluginId].indexOf(capabilityId) === -1) _grants[pluginId].push(capabilityId);
  }

  function hasCapability(pluginId, capabilityId) {
    return _grants[pluginId] && _grants[pluginId].indexOf(capabilityId) !== -1;
  }

  function getCapabilities(pluginId) { return _grants[pluginId] || []; }
  function getAllCapabilities() { return Object.keys(_caps); }
  function getCapabilityInfo(id) { return _caps[id] || null; }
  function getProviderFor(capabilityId) { return _caps[capabilityId] ? _caps[capabilityId].provider : null; }

  function clear() { _caps = {}; _grants = {}; }

  window.CapabilityRegistry = {
    VERSION: '1.0.0',
    registerCapability: registerCapability, grant: grant,
    hasCapability: hasCapability, getCapabilities: getCapabilities,
    getAllCapabilities: getAllCapabilities, getCapabilityInfo: getCapabilityInfo,
    getProviderFor: getProviderFor, clear: clear
  };
})();
