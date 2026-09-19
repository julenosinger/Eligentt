/**
 * Elligentt PluginRegistry — Centralized Plugin Registration (Phase 5)
 * Discovers, registers, and provides lookup for all plugins.
 * Attached to: window.PluginRegistry
 */
(function () {
  'use strict';
  var _plugins = {};
  var _byDep = {};

  function register(plugin) {
    if (!plugin || !plugin.id) { console.warn('[PluginRegistry] Invalid plugin — missing id'); return false; }
    if (_plugins[plugin.id]) { console.warn('[PluginRegistry] Duplicate plugin: "' + plugin.id + '"'); return false; }
    _plugins[plugin.id] = plugin;

    // Index by dependencies for reverse lookup
    var deps = plugin.dependencies || [];
    for (var i = 0; i < deps.length; i++) {
      if (!_byDep[deps[i]]) _byDep[deps[i]] = [];
      _byDep[deps[i]].push(plugin.id);
    }

    try { if (typeof EventBus !== 'undefined') EventBus.emit('PLUGIN_REGISTERED', { id: plugin.id, version: plugin.version }); } catch (_e) {}
    return true;
  }

  function get(id) { return _plugins[id] || null; }
  function getAll() { return Object.values(_plugins); }
  function getIds() { return Object.keys(_plugins); }
  function getCount() { return Object.keys(_plugins).length; }

  function getByCapability(capability) {
    return getAll().filter(function (p) {
      var caps = p.capabilities ? p.capabilities() : [];
      return caps.indexOf(capability) !== -1;
    });
  }

  function getDependents(pluginId) { return _byDep[pluginId] || []; }

  function has(id) { return !!_plugins[id]; }
  function unregister(id) { delete _plugins[id]; }
  function clear() { _plugins = {}; _byDep = {}; }

  window.PluginRegistry = {
    VERSION: '1.0.0',
    register: register, get: get, getAll: getAll, getIds: getIds,
    getCount: getCount, getByCapability: getByCapability,
    getDependents: getDependents, has: has, unregister: unregister, clear: clear
  };
})();
