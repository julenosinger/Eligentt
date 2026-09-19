/**
 * DashboardPlugin — Dashboard Feature Plugin (Phase 5)
 * Attached to: window.DashboardPlugin
 */
(function () {
  'use strict';
  var plugin = {
    id: 'dashboard', version: '1.0.0', dependencies: ['wallet', 'eventBus'],
    initialize: function () { try { if (typeof DashboardRenderer !== 'undefined') DashboardRenderer.initialize(); } catch (_e) {} },
    start: function () {
      try { if (typeof CapabilityRegistry !== 'undefined') { CapabilityRegistry.registerCapability('dashboard.render', 'dashboard', 'Render portfolio dashboard'); }} catch (_e) {}
    },
    stop: function () { try { if (typeof DashboardRenderer !== 'undefined') DashboardRenderer.destroy(); } catch (_e) {} },
    destroy: function () {},
    health: function () { return { available: typeof DashboardRenderer !== 'undefined' }; },
    diagnostics: function () { return {}; },
    capabilities: function () { return ['dashboard.render']; }
  };
  window.DashboardPlugin = plugin;
})();
