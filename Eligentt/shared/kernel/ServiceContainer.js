/**
 * Elligentt ServiceContainer — Service Locator / DI Container (Phase 5)
 * Plugins resolve services through the container. No direct dependencies.
 * Attached to: window.ServiceContainer
 */
(function () {
  'use strict';
  var _services = {};  // name → { instance, type, singleton }

  function register(name, instance, opts) {
    var o = opts || {};
    _services[name] = { instance: instance, type: o.type || 'service', singleton: o.singleton !== false };
    try { if (typeof EventBus !== 'undefined') EventBus.emit('SERVICE_REGISTERED', { name: name, type: o.type }); } catch (_e) {}
  }

  function resolve(name) {
    if (!_services[name]) return null;
    var entry = _services[name];
    if (typeof entry.instance === 'function' && !entry.singleton) {
      try { return entry.instance(); } catch (_e) { return null; }
    }
    return entry.instance;
  }

  function has(name) { return !!_services[name]; }
  function getAll() { return Object.keys(_services); }
  function unregister(name) { delete _services[name]; }
  function clear() { _services = {}; }

  window.ServiceContainer = {
    VERSION: '1.0.0',
    register: register, resolve: resolve, has: has,
    getAll: getAll, unregister: unregister, clear: clear
  };
})();
