/**
 * Elligentt SwapStore — Swap State Management (Phase 14.5)
 * Migrates: swapAmount, swapFrom, swapTo, slippage, quote globals.
 * Attached to: window.SwapStore
 */
(function () {
  'use strict';
  var _state = { amount: 0, fromToken: 'USDC', toToken: 'EURC', slippage: '0.5', quote: null, loading: false };

  function get(key) { return _state[key]; }
  function set(key, val) { _state[key] = val; try { if (typeof EventBus !== 'undefined') EventBus.emit('SWAP_STATE_CHANGED', { key: key, value: val }); } catch (_e) {} }
  function getSnapshot() { return Object.assign({}, _state); }
  function reset() { _state = { amount: 0, fromToken: 'USDC', toToken: 'EURC', slippage: '0.5', quote: null, loading: false }; }

  window.SwapStore = { VERSION: '14.0.0', get: get, set: set, getSnapshot: getSnapshot, reset: reset };
})();
