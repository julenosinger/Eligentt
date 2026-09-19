/**
 * MissionControlPlugin — Mission Control Dashboard Plugin (Phase 5)
 * Attached to: window.MissionControlPlugin
 */
(function () {
  'use strict';
  var plugin = {
    id: 'missionControl', version: '1.0.0', dependencies: ['aiwallet', 'eventBus'],
    initialize: function () { try { if (typeof AIWMissionEngine !== 'undefined') AIWMissionEngine.initialize(); } catch (_e) {} },
    start: function () {
      try { if (typeof CapabilityRegistry !== 'undefined') { CapabilityRegistry.registerCapability('mission.overview', 'missionControl', 'Portfolio overview'); CapabilityRegistry.registerCapability('mission.spending', 'missionControl', 'Spending capacity'); }} catch (_e) {}
    },
    stop: function () { try { if (typeof AIWMissionEngine !== 'undefined') AIWMissionEngine.destroy(); } catch (_e) {} },
    destroy: function () {},
    health: function () { return { available: typeof AIWMissionEngine !== 'undefined' }; },
    diagnostics: function () {
      try { if (typeof AIWMissionEngine !== 'undefined') return AIWMissionEngine.getPortfolioData(); } catch (_e) {}
      return {};
    },
    capabilities: function () { return ['mission.overview', 'mission.spending']; }
  };
  window.MissionControlPlugin = plugin;
})();
