/**
 * Elligentt PluginContext — Shared Context for All Plugins (Phase 5)
 * Provides access to kernel services, EventBus, stores, without direct coupling.
 * Attached to: window.PluginContext
 */
(function () {
  'use strict';

  function getContext() {
    return {
      eventBus: typeof EventBus !== 'undefined' ? EventBus : null,
      uiStore: typeof UIStore !== 'undefined' ? UIStore.getSnapshot() : null,
      walletStore: typeof WalletStore !== 'undefined' ? WalletStore.getSnapshot() : null,
      settingsStore: typeof SettingsStore !== 'undefined' ? SettingsStore.getSnapshot() : null,
      featureFlags: typeof FeatureFlags !== 'undefined' ? FeatureFlags.getAll() : null,
      capabilities: typeof CapabilityRegistry !== 'undefined' ? CapabilityRegistry.getAllCapabilities() : [],
      serviceContainer: typeof ServiceContainer !== 'undefined' ? ServiceContainer.getAll() : [],
      pluginCount: typeof PluginRegistry !== 'undefined' ? PluginRegistry.getCount() : 0,
      healthSummary: typeof ModuleHealth !== 'undefined' ? ModuleHealth.getSummary() : null
    };
  }

  function getService(name) {
    try { if (typeof ServiceContainer !== 'undefined') return ServiceContainer.resolve(name); } catch (_e) {}
    return null;
  }

  function isFeatureEnabled(id) {
    try { if (typeof FeatureFlags !== 'undefined') return FeatureFlags.isEnabled(id); } catch (_e) {}
    return true;
  }

  function emit(eventName, payload) {
    try { if (typeof EventBus !== 'undefined') EventBus.emit(eventName, payload); } catch (_e) {}
  }

  window.PluginContext = {
    VERSION: '1.0.0',
    getContext: getContext, getService: getService,
    isFeatureEnabled: isFeatureEnabled, emit: emit
  };
})();
