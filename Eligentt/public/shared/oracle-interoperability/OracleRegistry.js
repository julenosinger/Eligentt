/**
 * OracleRegistry — Centralized oracle feed registry
 * Phase 2, read-only. Extends window.OracleInterop (additive).
 */
(function(){
  'use strict';

  var _feeds = {};

  function _initDefaults(){
    var base = (typeof OracleInterop !== 'undefined' && OracleInterop.FEED_REGISTRY) ? OracleInterop.FEED_REGISTRY : {};
    Object.keys(base).forEach(function(k){
      _feeds[k] = Object.assign({ registered: true, source: 'chainlink', health: 'healthy', lastCheck: 0 }, base[k]);
    });
  }

  function registerFeed(feedKey, config){
    if (!feedKey || !config) return false;
    if (_feeds[feedKey]) return false; // no overwrite
    _feeds[feedKey] = Object.assign({ registered: true, source: config.source || 'custom', health: 'unknown', lastCheck: 0 }, config);
    return true;
  }

  function unregisterFeed(feedKey){
    if (!_feeds[feedKey]) return false;
    delete _feeds[feedKey];
    return true;
  }

  function getFeed(feedKey){ return _feeds[feedKey] ? Object.assign({}, _feeds[feedKey]) : null; }

  function getAllFeeds(){
    var list = [];
    Object.keys(_feeds).forEach(function(k){ list.push(Object.assign({ key: k }, _feeds[k])); });
    return list;
  }

  function supportedFeeds(){
    return Object.keys(_feeds).filter(function(k){ return _feeds[k].registered === true; });
  }

  function feedStatus(feedKey){
    var f = _feeds[feedKey];
    if (!f) return 'not_found';
    if (!f.registered) return 'disabled';
    return f.health || 'unknown';
  }

  function validateFeed(feedKey){
    var f = _feeds[feedKey];
    if (!f) return { valid: false, reason: 'not_found' };
    if (!f.address || f.address.length < 42) return { valid: false, reason: 'invalid_address' };
    if (!f.decimals || f.decimals < 1) return { valid: false, reason: 'invalid_decimals' };
    return { valid: true, feedKey: feedKey, address: f.address, decimals: f.decimals };
  }

  function updateFeedHealth(feedKey, health){
    if (_feeds[feedKey]){ _feeds[feedKey].health = health; _feeds[feedKey].lastCheck = Math.floor(Date.now()/1000); }
  }

  _initDefaults();

  if (typeof window !== 'undefined'){
    var base = window.OracleInterop || {};
    base.Registry = {
      registerFeed: registerFeed,
      unregisterFeed: unregisterFeed,
      getFeed: getFeed,
      getAllFeeds: getAllFeeds,
      supportedFeeds: supportedFeeds,
      feedStatus: feedStatus,
      validateFeed: validateFeed,
      updateFeedHealth: updateFeedHealth
    };
    window.OracleInterop = base;
  }
})();
