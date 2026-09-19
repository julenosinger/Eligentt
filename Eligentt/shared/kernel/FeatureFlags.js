/**
 * Elligentt FeatureFlags — Runtime Feature Toggle System (Phase 5)
 * Supports runtime enable/disable/experimental/internal/deprecated.
 * No feature behavior changes by default.
 * Attached to: window.FeatureFlags
 */
(function () {
  'use strict';
  var STORAGE_KEY = 'elligentt_feature_flags_v1';

  var _flags = {};

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) _flags = JSON.parse(raw);
    } catch (_e) { _flags = {}; }
  }
  function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(_flags)); } catch (_e) {} }

  var DEFAULT_STATES = ['enabled', 'disabled', 'experimental', 'internal', 'deprecated', 'future'];

  function register(id, opts) {
    var o = opts || {};
    if (!_flags[id]) {
      _flags[id] = { state: o.default || 'enabled', description: o.description || '', version: o.version || '1.0.0' };
    }
    save();
  }

  function isEnabled(id) {
    return _flags[id] && _flags[id].state === 'enabled';
  }

  function isExperimental(id) {
    return _flags[id] && _flags[id].state === 'experimental';
  }

  function isDisabled(id) { return !_flags[id] || _flags[id].state === 'disabled'; }

  function enable(id) {
    if (_flags[id]) { _flags[id].state = 'enabled'; save(); }
    try { if (typeof EventBus !== 'undefined') EventBus.emit('FEATURE_FLAG_CHANGED', { id: id, state: 'enabled' }); } catch (_e) {}
  }

  function disable(id) {
    if (_flags[id]) { _flags[id].state = 'disabled'; save(); }
    try { if (typeof EventBus !== 'undefined') EventBus.emit('FEATURE_FLAG_CHANGED', { id: id, state: 'disabled' }); } catch (_e) {}
  }

  function setState(id, state) {
    if (DEFAULT_STATES.indexOf(state) === -1) return false;
    if (_flags[id]) { _flags[id].state = state; save(); }
    try { if (typeof EventBus !== 'undefined') EventBus.emit('FEATURE_FLAG_CHANGED', { id: id, state: state }); } catch (_e) {}
    return true;
  }

  function getAll() { return Object.assign({}, _flags); }

  function getState(id) { return _flags[id] ? _flags[id].state : 'unknown'; }

  load();

  window.FeatureFlags = {
    VERSION: '1.0.0',
    register: register, isEnabled: isEnabled, isExperimental: isExperimental,
    isDisabled: isDisabled, enable: enable, disable: disable,
    setState: setState, getAll: getAll, getState: getState,
    STORAGE_KEY: STORAGE_KEY
  };
})();
