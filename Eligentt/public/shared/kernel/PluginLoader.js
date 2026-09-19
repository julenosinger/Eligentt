/**
 * Elligentt PluginLoader — Plugin Discovery & Dynamic Loading (Phase 5)
 * Discovers plugins from registry. Loads them in dependency order. Handles failures.
 * Attached to: window.PluginLoader
 */
(function () {
  'use strict';

  /**
   * Load all registered plugins in dependency-resolved order.
   * Each plugin: register → validate → initialize → start.
   * @returns {{ loaded: number, failed: number, order: string[] }}
   */
  function loadAll() {
    var plugins;
    try {
      if (typeof PluginRegistry !== 'undefined') plugins = PluginRegistry.getAll();
    } catch (_e) { plugins = []; }

    if (!plugins.length) {
      console.log('[PluginLoader] No plugins registered');
      return { loaded: 0, failed: 0, order: [] };
    }

    // Validate dependency graph
    var validation;
    try {
      if (typeof DependencyResolver !== 'undefined') validation = DependencyResolver.validateGraph(plugins);
    } catch (_e) { validation = { valid: false, missing: [], circular: [] }; }

    if (!validation.valid) {
      console.warn('[PluginLoader] Dependency graph invalid:', validation);
    }

    // Resolve load order
    var order;
    try {
      if (typeof DependencyResolver !== 'undefined') order = DependencyResolver.getResolutionOrder(plugins);
    } catch (_e) { order = plugins.map(function (p) { return p.id; }); }

    var loaded = 0;
    var failed = 0;

    for (var i = 0; i < order.length; i++) {
      var pluginId = order[i];
      var plugin;
      try { plugin = typeof PluginRegistry !== 'undefined' ? PluginRegistry.get(pluginId) : null; } catch (_e) { plugin = null; }

      if (!plugin) { failed++; continue; }

      // Initialize
      try {
        if (typeof PluginLifecycle !== 'undefined') {
          PluginLifecycle.initialize(plugin);
          PluginLifecycle.start(plugin);
          loaded++;
        }
      } catch (e) {
        failed++;
        console.warn('[PluginLoader] Failed to load plugin "' + pluginId + '":', e.message);
        try {
          if (typeof ModuleHealth !== 'undefined') ModuleHealth.setHealth(pluginId, 'error', { error: e.message });
        } catch (_e2) {}
      }

      // Mark healthy
      try {
        if (typeof ModuleHealth !== 'undefined') ModuleHealth.setHealth(pluginId, 'running');
      } catch (_e3) {}
    }

    console.log('[PluginLoader] Loaded ' + loaded + '/' + plugins.length + ' plugins (' + failed + ' failed)');
    if (typeof EventBus !== 'undefined') EventBus.emit('PLUGINS_LOADED', { loaded: loaded, failed: failed, order: order });

    return { loaded: loaded, failed: failed, order: order };
  }

  /** Lazy-load a single plugin by ID */
  function loadPlugin(pluginId) {
    try {
      if (typeof PluginRegistry === 'undefined') return false;
      var plugin = PluginRegistry.get(pluginId);
      if (!plugin) return false;
      if (typeof PluginLifecycle === 'undefined') return false;

      PluginLifecycle.initialize(plugin);
      PluginLifecycle.start(plugin);

      if (typeof ModuleHealth !== 'undefined') ModuleHealth.setHealth(pluginId, 'running');
      return true;
    } catch (e) {
      console.warn('[PluginLoader] Lazy load failed for "' + pluginId + '":', e.message);
      try { if (typeof ModuleHealth !== 'undefined') ModuleHealth.setHealth(pluginId, 'error', { error: e.message }); } catch (_e) {}
      return false;
    }
  }

  /** Stop all plugins in reverse order */
  function unloadAll() {
    try {
      if (typeof PluginRegistry === 'undefined') return;
      var plugins = PluginRegistry.getAll().reverse();
      for (var i = 0; i < plugins.length; i++) {
        try {
          if (typeof PluginLifecycle !== 'undefined') { PluginLifecycle.stop(plugins[i]); PluginLifecycle.destroy(plugins[i]); }
        } catch (_e) {}
      }
    } catch (_e2) {}
  }

  window.PluginLoader = {
    VERSION: '1.0.0',
    loadAll: loadAll, loadPlugin: loadPlugin, unloadAll: unloadAll
  };
})();
