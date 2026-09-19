/**
 * Elligentt Contract Registry — Trusted contracts with reputation scoring (Phase 6)
 * Maintains known contracts, tracks reputation after successful executions.
 * Attached to window.ContractRegistry
 */
(function(){
  'use strict';

  var KNOWN_CONTRACTS = {
    /* Treasury / Vault */
    '0xbfc9e': { name: 'Treasury Vault', type: 'treasury', trust: 'high', category: 'treasury', chains: ['Arc Testnet','Arc'], verified: true, interactions: 0, lastInteraction: null },
    /* Circle CCTP */
    '0x8FE6': { name: 'CCTP TokenMessenger', type: 'bridge', trust: 'high', category: 'bridge', chains: ['Arc Testnet','Base Sepolia','Ethereum Sepolia'], verified: true, interactions: 0, lastInteraction: null },
    '0xE737': { name: 'CCTP MsgTransmitter', type: 'bridge', trust: 'high', category: 'bridge', chains: ['Arc Testnet'], verified: true, interactions: 0, lastInteraction: null },
    /* Elligentt Contracts */
    '0x18076d992005186AeB13AC5270CaD6E27DB95247': { name: 'ElligentPool AMM', type: 'swap', trust: 'high', category: 'swap', chains: ['Arc Testnet'], verified: true, interactions: 0, lastInteraction: null },
    '0x5294': { name: 'Memo Contract', type: 'contract', trust: 'high', category: 'contract', chains: ['Arc Testnet'], verified: true, interactions: 0, lastInteraction: null },
    /* Safe / Multisig */
    '0xd9db270c': { name: 'Safe (Gnosis)', type: 'multisig', trust: 'high', category: 'multisig', chains: ['*'], verified: true, interactions: 0, lastInteraction: null },
    /* Permit2 */
    '0x000000000022D473030F116dDEE9F6B43aC78BA3': { name: 'Permit2', type: 'permit2', trust: 'high', category: 'permit', chains: ['*'], verified: true, interactions: 0, lastInteraction: null },
    /* MultiSend */
    '0xMultiSend': { name: 'MultiSend Executor', type: 'multisend', trust: 'high', category: 'payment', chains: ['Arc Testnet'], verified: true, interactions: 0, lastInteraction: null }
  };

  var REPUTATION_STORE = {};
  var STORAGE_KEY = 'elligentt_contract_reputation_v1';

  function loadReputation(){
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if(raw) REPUTATION_STORE = JSON.parse(raw);
    } catch(e){ REPUTATION_STORE = {}; }
  }
  function saveReputation(){
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(REPUTATION_STORE)); } catch(e){}
  }

  function lookup(addr){
    if(!addr) return null;
    if(KNOWN_CONTRACTS[addr]) return KNOWN_CONTRACTS[addr];
    // Partial match
    var keys = Object.keys(KNOWN_CONTRACTS);
    for(var i=0; i<keys.length; i++){
      if(addr.toLowerCase().startsWith(keys[i].toLowerCase())){
        return KNOWN_CONTRACTS[keys[i]];
      }
    }
    // Check reputation store
    if(REPUTATION_STORE[addr]) return REPUTATION_STORE[addr];
    return null;
  }

  function isKnown(addr){
    return lookup(addr) !== null;
  }

  function getTrustLevel(addr){
    var entry = lookup(addr);
    if(entry) return entry.trust || 'unknown';
    return 'unknown';
  }

  function recordInteraction(addr, result){
    var entry = lookup(addr);
    if(entry){
      entry.interactions = (entry.interactions || 0) + 1;
      entry.lastInteraction = Date.now();
      if(result === 'success'){
        if(entry.trust === 'unknown') entry.trust = 'low';
        else if(entry.trust === 'low' && entry.interactions > 3) entry.trust = 'medium';
        else if(entry.trust === 'medium' && entry.interactions > 10) entry.trust = 'high';
      } else {
        entry.trust = entry.trust === 'high' ? 'medium' : 'low';
      }
    } else {
      // New contract - store with initial reputation
      REPUTATION_STORE[addr] = {
        name: 'Unknown (' + (addr.length > 10 ? addr.substring(0,8) + '...' : addr) + ')',
        type: 'unknown',
        trust: result === 'success' ? 'low' : 'unknown',
        category: 'unknown',
        chains: [],
        verified: false,
        interactions: 1,
        lastInteraction: Date.now()
      };
    }
    saveReputation();
  }

  function getAllKnown(){
    var all = {};
    var keys = Object.keys(KNOWN_CONTRACTS);
    for(var i=0; i<keys.length; i++){
      all[keys[i]] = Object.assign({}, KNOWN_CONTRACTS[keys[i]]);
    }
    var repKeys = Object.keys(REPUTATION_STORE);
    for(var j=0; j<repKeys.length; j++){
      all[repKeys[j]] = Object.assign({}, REPUTATION_STORE[repKeys[j]]);
    }
    return all;
  }

  function getTrustedByCategory(category){
    var trusted = [];
    var keys = Object.keys(KNOWN_CONTRACTS);
    for(var i=0; i<keys.length; i++){
      if(KNOWN_CONTRACTS[keys[i]].category === category && (KNOWN_CONTRACTS[keys[i]].trust === 'high' || KNOWN_CONTRACTS[keys[i]].trust === 'medium')){
        trusted.push(KNOWN_CONTRACTS[keys[i]]);
      }
    }
    return trusted;
  }

  function fmtTrust(level){
    var map = { high: 'High', medium: 'Medium', low: 'Low', unknown: 'Unknown' };
    return map[level] || 'Unknown';
  }

  function trustColor(level){
    var map = { high: '#22c55e', medium: '#f59e0b', low: '#ef4444', unknown: '#6b7280' };
    return map[level] || '#6b7280';
  }

  loadReputation();

  window.ContractRegistry = {
    lookup: lookup,
    isKnown: isKnown,
    getTrustLevel: getTrustLevel,
    recordInteraction: recordInteraction,
    getAllKnown: getAllKnown,
    getTrustedByCategory: getTrustedByCategory,
    fmtTrust: fmtTrust,
    trustColor: trustColor,
    KNOWN_CONTRACTS: KNOWN_CONTRACTS
  };
})();
