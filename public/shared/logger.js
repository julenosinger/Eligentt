const Logger = (() => {
  'use strict';

  const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
  let _minLevel = 1;

  function _ts() { return new Date().toISOString(); }

  function _fmt(level, action, data) {
    const entry = { level, action, timestamp: _ts() };
    if (data) {
      if (data.wallet) entry.wallet = data.wallet;
      if (data.txHash) entry.txHash = data.txHash;
      if (data.intentId) entry.intentId = data.intentId;
      if (data.amount !== undefined) entry.amount = data.amount;
      if (data.asset) entry.asset = data.asset;
      if (data.chain) entry.chain = data.chain;
      if (data.status) entry.status = data.status;
      if (data.error) entry.error = data.error;
      if (data.duration !== undefined) entry.duration = data.duration;
      if (data.module) entry.module = data.module;
    }
    return entry;
  }

  function _emit(level, action, data) {
    if (LEVELS[level] < _minLevel) return;
    const entry = _fmt(level, action, data);
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn('[Elligentt]', JSON.stringify(entry));
  }

  function setLevel(level) {
    if (LEVELS[level] !== undefined) _minLevel = LEVELS[level];
  }

  function debug(action, data) { _emit('debug', action, data); }
  function info(action, data) { _emit('info', action, data); }
  function warn(action, data) { _emit('warn', action, data); }
  function error(action, data) { _emit('error', action, data); }

  function paymentCreated(d) { info('payment_created', d); }
  function paymentVerified(d) { info('payment_verified', d); }
  function relayerSent(d) { info('relayer_sent', d); }
  function bridgeCompleted(d) { info('bridge_completed', d); }
  function walletConnected(d) { info('wallet_connected', d); }
  function walletDisconnected(d) { info('wallet_disconnected', d); }
  function authLogin(d) { info('auth_login', d); }
  function authLogout(d) { info('auth_logout', d); }
  function txSubmitted(d) { info('tx_submitted', d); }
  function txConfirmed(d) { info('tx_confirmed', d); }
  function txFailed(d) { error('tx_failed', d); }

  function timed(action, fn, data) {
    const start = performance.now();
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(r => {
        info(action, { ...data, duration: Math.round(performance.now() - start) });
        return r;
      }).catch(e => {
        error(action, { ...data, duration: Math.round(performance.now() - start), error: e.message });
        throw e;
      });
    }
    info(action, { ...data, duration: Math.round(performance.now() - start) });
    return result;
  }

  return {
    setLevel, debug, info, warn, error,
    paymentCreated, paymentVerified, relayerSent, bridgeCompleted,
    walletConnected, walletDisconnected, authLogin, authLogout,
    txSubmitted, txConfirmed, txFailed, timed,
  };
})();

if (typeof window !== 'undefined') window.Logger = Logger;
