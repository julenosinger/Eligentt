/**
 * HistoryPlugin — Transaction History Feature Plugin (Phase 5)
 * Attached to: window.HistoryPlugin
 */
(function () {
  'use strict';
  var plugin = {
    id: 'history', version: '1.0.0', dependencies: ['eventBus'],
    initialize: function () { try { if (typeof HistoryDomain !== 'undefined') HistoryDomain.initialize(); } catch (_e) {} },
    start: function () {
      try { if (typeof CapabilityRegistry !== 'undefined') { CapabilityRegistry.registerCapability('history.query', 'history', 'Query transaction history'); CapabilityRegistry.registerCapability('history.export', 'history', 'Export transaction history'); }} catch (_e) {}
    },
    stop: function () { try { if (typeof HistoryDomain !== 'undefined') HistoryDomain.destroy(); } catch (_e) {} },
    destroy: function () {},
    health: function () { return { available: typeof HistoryDomain !== 'undefined' }; },
    diagnostics: function () { return {}; },
    capabilities: function () { return ['history.query', 'history.export']; }
  };
  window.HistoryPlugin = plugin;
})();
