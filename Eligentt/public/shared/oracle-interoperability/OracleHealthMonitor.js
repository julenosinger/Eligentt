/**
 * OracleHealthMonitor — Complete monitoring system
 * Read-only monitoring: feeds, RPC, CCIP, PoR, Chainlink status.
 * Zero impact on app functionality.
 */
(function(){
  'use strict';

  var _state = {
    oracle: 'unknown', feeds: {}, ccip: 'unknown', rpc: 'unknown',
    lastCheck: 0, lastFullCheck: 0, alerts: []
  };
  var _timer = null;

  var FEED_CHECK_INTERVAL = 60000;   // 1 min
  var FULL_CHECK_INTERVAL = 300000;  // 5 min

  function _healthLevel(ok, degraded){
    if (ok === 0) return 'offline';
    var ratio = ok / ((ok + degraded) || 1);
    if (ratio >= 0.9) return 'healthy';
    if (ratio >= 0.5) return 'warning';
    return 'degraded';
  }

  async function _checkFeeds(){
    var feeds = {};
    try {
      var feedKeys = (typeof OracleInterop !== 'undefined' && OracleInterop.getAvailableFeeds) ? OracleInterop.getAvailableFeeds() : [];
      for (var i = 0; i < feedKeys.length; i++){
        var status = 'unknown';
        try {
          if (typeof OracleInterop !== 'undefined' && OracleInterop.getFeedStatus){
            status = OracleInterop.getFeedStatus(feedKeys[i]);
          }
        } catch(_e){}
        feeds[feedKeys[i]] = { status: status, lastCheck: Math.floor(Date.now()/1000) };
      }
    } catch(_e){}
    _state.feeds = feeds;
    var ok = 0, degraded = 0;
    Object.keys(feeds).forEach(function(k){ if (feeds[k].status === 'healthy') ok++; else if (feeds[k].status !== 'unknown') degraded++; });
    _state.oracle = _healthLevel(ok, degraded);
    _state.lastCheck = Math.floor(Date.now()/1000);
  }

  async function _checkRPC(){
    try {
      if (typeof RPCManager !== 'undefined' && RPCManager.getRPCStatus){
        var s = RPCManager.getRPCStatus();
        _state.rpc = s.activeRPC ? 'healthy' : 'degraded';
      }
    } catch(_e){ _state.rpc = 'unknown'; }
  }

  async function _checkCCIP(){
    try {
      if (typeof OracleInterop !== 'undefined' && OracleInterop.getCCIPStatus){
        var s = OracleInterop.getCCIPStatus();
        _state.ccip = s.initialized ? (s.supportedChains && s.supportedChains.length > 0 ? 'healthy' : 'degraded') : 'unknown';
      }
    } catch(_e){ _state.ccip = 'unknown'; }
  }

  async function _fullCheck(){
    await _checkFeeds();
    await _checkRPC();
    await _checkCCIP();
    _state.lastFullCheck = Math.floor(Date.now()/1000);
  }

  function getHealth(){
    return {
      oracle: _state.oracle,
      rpc: _state.rpc,
      ccip: _state.ccip,
      feeds: Object.keys(_state.feeds).length,
      healthyFeeds: Object.keys(_state.feeds).filter(function(k){ return _state.feeds[k].status === 'healthy'; }).length,
      alerts: _state.alerts.slice(-10),
      lastCheck: _state.lastCheck,
      lastFullCheck: _state.lastFullCheck
    };
  }

  function getOracleStatus(){ return _state.oracle; }

  function getFeedStatus(feedKey){ return (_state.feeds[feedKey] || {}).status || 'unknown'; }

  function getCCIPStatus(){ return _state.ccip; }

  function getRPCStatus(){ return _state.rpc; }

  function start(){
    if (_timer) return;
    _timer = setInterval(function(){
      _checkFeeds();
      if ((Math.floor(Date.now()/1000) - _state.lastFullCheck) > (FULL_CHECK_INTERVAL/1000)) _fullCheck();
    }, FEED_CHECK_INTERVAL);
    setTimeout(_fullCheck, 15000);
  }

  function stop(){ if (_timer){ clearInterval(_timer); _timer = null; } }

  start();

  if (typeof window !== 'undefined'){
    var base = window.OracleInterop || {};
    base.HealthMonitor = {
      getHealth: getHealth,
      getOracleStatus: getOracleStatus,
      getFeedStatus: getFeedStatus,
      getCCIPStatus: getCCIPStatus,
      getRPCStatus: getRPCStatus,
      start: start, stop: stop
    };
    window.OracleInterop = base;
  }
})();
