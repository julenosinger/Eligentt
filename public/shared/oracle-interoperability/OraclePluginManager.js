/**
 * OraclePluginManager — Plugin architecture for oracle providers
 * Chainlink is default. Extensible for future providers.
 * Never modifies existing oracle functionality.
 */
(function(){
  'use strict';

  var _plugins = {};
  var _activePlugin = null;

  function registerPlugin(name, config){
    if (_plugins[name]) return false;
    _plugins[name] = Object.assign({
      name: name, active: false, type: config.type || 'oracle',
      getPrice: config.getPrice || null,
      getStatus: config.getStatus || null,
      getFeeds: config.getFeeds || null,
      metadata: config.metadata || {}
    }, config);
    return true;
  }

  function unregisterPlugin(name){
    if (!_plugins[name]) return false;
    if (_activePlugin === name) _activePlugin = null;
    delete _plugins[name];
    return true;
  }

  function activatePlugin(name){
    if (!_plugins[name]) return false;
    _activePlugin = name;
    _plugins[name].active = true;
    // Deactivate others
    Object.keys(_plugins).forEach(function(k){ if (k !== name) _plugins[k].active = false; });
    return true;
  }

  function getActivePlugin(){ return _activePlugin ? (_plugins[_activePlugin] ? Object.assign({}, _plugins[_activePlugin]) : null) : null; }

  function getAllPlugins(){
    var list = [];
    Object.keys(_plugins).forEach(function(k){ list.push(Object.assign({ name: k }, _plugins[k])); });
    return list;
  }

  function getPlugin(name){ return _plugins[name] ? Object.assign({}, _plugins[name]) : null; }

  // Register Chainlink as default plugin
  setTimeout(function(){
    registerPlugin('chainlink', {
      type: 'oracle',
      getPrice: function(asset){
        try {
          if (typeof OracleInterop !== 'undefined' && OracleInterop.getPrice){
            return OracleInterop.getPrice(asset);
          }
        } catch(_e){}
        return null;
      },
      getStatus: function(){
        try {
          if (typeof OracleInterop !== 'undefined' && OracleInterop.getStatus){
            return OracleInterop.getStatus();
          }
        } catch(_e){}
        return null;
      },
      getFeeds: function(){
        try {
          if (typeof OracleInterop !== 'undefined' && OracleInterop.getAvailableFeeds){
            return OracleInterop.getAvailableFeeds();
          }
        } catch(_e){}
        return [];
      },
      metadata: { version: '1.0.0', provider: 'Chainlink', network: 'Arc Testnet', router: '0xdE4E7FED43FAC37EB21aA0643d9852f75332eab8' }
    });
    activatePlugin('chainlink');
  }, 2000);

  if (typeof window !== 'undefined'){
    var base = window.OracleInterop || {};
    base.PluginManager = {
      registerPlugin: registerPlugin,
      unregisterPlugin: unregisterPlugin,
      activatePlugin: activatePlugin,
      getActivePlugin: getActivePlugin,
      getAllPlugins: getAllPlugins,
      getPlugin: getPlugin
    };
    window.OracleInterop = base;
  }
})();
