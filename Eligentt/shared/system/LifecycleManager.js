/**
 * Elligentt LifecycleManager — Global Lifecycle Orchestrator (Phase 6)
 * Manages bootstrap → running → shutdown lifecycle for all layers.
 * Attached to: window.LifecycleManager
 */
(function () {
  'use strict';
  var _state = 'uninitialized';
  var STATES = ['uninitialized', 'booting', 'running', 'degraded', 'shutting_down', 'stopped'];

  function setState(s) { if (STATES.indexOf(s) !== -1) { _state = s; try { if (typeof EventBus !== 'undefined') EventBus.emit('LIFECYCLE_CHANGED', { state: s }); } catch (_e) {} } }
  function getState() { return _state; }

  function boot() {
    setState('booting');
    try { if (typeof SystemManager !== 'undefined' && SystemManager.boot) SystemManager.boot(); } catch (_e) {}
    setState('running');
  }

  function shutdown() {
    setState('shutting_down');
    try { if (typeof ApplicationKernel !== 'undefined' && ApplicationKernel.shutdown) ApplicationKernel.shutdown(); } catch (_e) {}
    setState('stopped');
  }

  window.LifecycleManager = {
    VERSION: '1.0.0', STATES: STATES,
    setState: setState, getState: getState, boot: boot, shutdown: shutdown
  };
})();
