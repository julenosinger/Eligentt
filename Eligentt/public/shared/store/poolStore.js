/**
 * Elligentt PoolStore — Liquidity Pool State (Phase 15)
 * Migrates: pool list, TVL, LP positions, filters.
 * Attached to: window.PoolStore
 */
(function () {
  'use strict';
  var _state = { pools: [], lpPositions: [], tvl: 0, filter: 'all' };
  function get(key) { return _state[key]; }
  function set(key, val) { _state[key] = val; try { if (typeof EventBus !== 'undefined') EventBus.emit('POOL_STATE_CHANGED', { key: key }); } catch (_e) {} }
  function getSnapshot() { return Object.assign({}, _state); }
  window.PoolStore = { VERSION: '15.0.0', get: get, set: set, getSnapshot: getSnapshot };
})();
