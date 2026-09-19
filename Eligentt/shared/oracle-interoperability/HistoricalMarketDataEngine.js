/**
 * HistoricalMarketDataEngine — Market snapshot history
 * Background processing only. Never blocks UI.
 * Stores: 5m, 15m, 30m, 1h snapshots (localStorage).
 */
(function(){
  'use strict';

  var STORE_KEY = 'elligentt_historical_market_v1';
  var MAX_SNAPS = { '5m': 288, '15m': 96, '30m': 48, '1h': 720 };
  var _history = { '5m': [], '15m': [], '30m': [], '1h': [] };
  var _timer = null;
  var _running = false;

  function _load(){
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw){ var parsed = JSON.parse(raw); if (parsed) _history = parsed; }
    } catch(_e){}
  }

  function _save(){
    try {
      var copy = {};
      Object.keys(_history).forEach(function(k){
        copy[k] = _history[k].slice(-(MAX_SNAPS[k] || 100));
      });
      localStorage.setItem(STORE_KEY, JSON.stringify(copy));
    } catch(_e){}
  }

  function _collect(){
    if (_running) return;
    _running = true;
    try {
      var snap = null;
      if (typeof OracleInterop !== 'undefined' && OracleInterop.getMarketPrices){
        snap = OracleInterop.getMarketPrices();
      }
      if (!snap || !snap.prices || snap.at === 0){ _running = false; return; }
      var entry = { ts: snap.at || Math.floor(Date.now()/1000), prices: Object.assign({}, snap.prices), sources: Object.assign({}, snap.sources || {}) };
      Object.keys(MAX_SNAPS).forEach(function(interval){
        var list = _history[interval];
        var last = list[list.length - 1];
        var intSec = { '5m': 300, '15m': 900, '30m': 1800, '1h': 3600 }[interval] || 300;
        if (!last || (entry.ts - last.ts) >= intSec){
          list.push(entry);
          if (list.length > MAX_SNAPS[interval]) list.shift();
        }
      });
      _save();
    } catch(_e){} finally { _running = false; }
  }

  function getHistoricalPrice(asset, interval, count){
    var list = _history[interval] || _history['15m'];
    var results = [];
    var take = Math.min(count || 20, list.length);
    for (var i = list.length - take; i < list.length; i++){
      if (list[i] && list[i].prices && list[i].prices[asset] !== undefined){
        results.push({ ts: list[i].ts, price: list[i].prices[asset] });
      }
    }
    return results;
  }

  function getPriceHistory(asset){
    return {
      '5m': getHistoricalPrice(asset, '5m', 60),
      '15m': getHistoricalPrice(asset, '15m', 30),
      '30m': getHistoricalPrice(asset, '30m', 20),
      '1h': getHistoricalPrice(asset, '1h', 24)
    };
  }

  function getHistoricalAnalytics(asset){
    var list = _history['15m'];
    if (!list.length) return null;
    var prices = [];
    for (var i = 0; i < list.length; i++){
      if (list[i] && list[i].prices && list[i].prices[asset] !== undefined){
        prices.push(list[i].prices[asset]);
      }
    }
    if (!prices.length) return null;
    var min = prices[0], max = prices[0], sum = 0;
    for (var j = 0; j < prices.length; j++){
      if (prices[j] < min) min = prices[j];
      if (prices[j] > max) max = prices[j];
      sum += prices[j];
    }
    var avg = sum / prices.length;
    var first = prices[0], last = prices[prices.length - 1];
    var change = last - first;
    var changePct = first > 0 ? (change / first) * 100 : 0;
    return {
      asset: asset, min: min, max: max, avg: avg,
      open: first, close: last,
      change: change, changePct: changePct,
      snapshots: prices.length,
      period: '15m intervals'
    };
  }

  function start(){
    if (_timer) return;
    _load();
    _timer = setInterval(_collect, 300000); // every 5 minutes
    setTimeout(_collect, 10000); // first collection after 10s
  }

  function stop(){ if (_timer){ clearInterval(_timer); _timer = null; } }

  function forceSnapshot(){ _collect(); }

  start();

  if (typeof window !== 'undefined'){
    var base = window.OracleInterop || {};
    base.Historical = {
      getHistoricalPrice: getHistoricalPrice,
      getPriceHistory: getPriceHistory,
      getHistoricalAnalytics: getHistoricalAnalytics,
      forceSnapshot: forceSnapshot,
      start: start, stop: stop
    };
    window.OracleInterop = base;
  }
})();
