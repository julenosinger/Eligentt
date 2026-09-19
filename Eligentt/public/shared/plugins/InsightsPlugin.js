/**
 * InsightsPlugin — AI Recommendations Plugin (Phase 5)
 * Attached to: window.InsightsPlugin
 */
(function () {
  'use strict';
  var plugin = {
    id: 'insights', version: '1.0.0', dependencies: ['aiwallet', 'eventBus'],
    initialize: function () { try { if (typeof InsightsRenderer !== 'undefined') InsightsRenderer.initialize(); } catch (_e) {} },
    start: function () {
      try { if (typeof CapabilityRegistry !== 'undefined') { CapabilityRegistry.registerCapability('insights.recommend', 'insights', 'Generate AI recommendations'); }} catch (_e) {}
    },
    stop: function () { try { if (typeof InsightsRenderer !== 'undefined') InsightsRenderer.destroy(); } catch (_e) {} },
    destroy: function () {},
    health: function () { return { available: typeof InsightsRenderer !== 'undefined' }; },
    diagnostics: function () { return {}; },
    capabilities: function () { return ['insights.recommend']; }
  };
  window.InsightsPlugin = plugin;
})();
