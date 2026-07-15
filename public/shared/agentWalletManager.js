/**
 * Autonoma Agent Wallet Manager — Persistent Agent Wallet with ERC-8004 Identity
 * Creates/manages a dedicated Agent Wallet for Autonoma.
 * This wallet represents Autonoma itself and persists between sessions.
 * All operations require explicit user authorization before execution.
 * Attached to window.AgentWalletManager
 */
(function(){
  'use strict';

  var WALLET_KEY = 'elligentt_agent_wallet_v1';
  var SESSION_KEY = 'elligentt_agent_session_v1';
  var ARC_RPC = 'https://arc-testnet.drpc.org';
  var ARC_CHAIN_ID = 5042002;

  var agentWallet = null;
  var agentProvider = null;
  var agentState = null;
  var initialized = false;

  function loadState(){
    try {
      var raw = localStorage.getItem(WALLET_KEY);
      if(raw) agentState = JSON.parse(raw);
    } catch(e){ agentState = null; }
    if(!agentState){
      agentState = {
        agentId: null, walletAddress: null,
        identityTokenId: null, identityRegistered: false, identityTxHash: null,
        registrationDate: null, version: '1.0.0', metadataURI: null,
        capabilities: ['swap','bridge','treasury','payments','contracts','vault','crosschain','permit','recurring','scheduled','reimbursement','treasury_deposit'],
        supportedChains: ['Arc Testnet','Base','Ethereum','Arbitrum','Optimism','Polygon','Robinhood'],
        status: 'active', sessionStatus: 'inactive',
        reputationScore: 50, developer: 'Elligentt', identityNFT: null,
        verificationStatus: 'unverified', pausedUntil: null,
        executionCount: 0, successfulExecutions: 0, failedExecutions: 0,
        cancelledOperations: 0, totalPlanningTime: 0, totalExecutionTime: 0,
        simulationAccuracy: 0, permitAccuracy: 0, riskAccuracy: 0,
        completionRate: 0, bridgeSuccessRate: 0, treasurySuccessRate: 0,
        paymentSuccessRate: 0, swapSuccessRate: 0
      };
      saveState();
    }
    return agentState;
  }

  function saveState(){
    try { localStorage.setItem(WALLET_KEY, JSON.stringify(agentState)); } catch(e){}
  }

  function createAgentWallet(){
    if(typeof ethers === 'undefined'){
      console.warn('[AgentWalletManager] ethers.js not loaded');
      return null;
    }
    try {
      agentProvider = getAgentProvider();
      agentWallet = ethers.Wallet.createRandom();
      agentWallet = agentWallet.connect(agentProvider);
      if(agentState){
        agentState.walletAddress = agentWallet.address;
        agentState.registrationDate = agentState.registrationDate || Date.now();
        saveState();
      }
      return agentWallet;
    } catch(e){
      console.error('[AgentWalletManager] Failed to create wallet:', e);
      return null;
    }
  }

  function restoreAgentWallet(privateKey){
    if(typeof ethers === 'undefined') return null;
    try {
      agentProvider = getAgentProvider();
      agentWallet = new ethers.Wallet(privateKey, agentProvider);
      if(agentState){
        agentState.walletAddress = agentWallet.address;
        saveState();
      }
      return agentWallet;
    } catch(e){ return null; }
  }

  function getOrCreateWallet(){
    if(agentWallet) return agentWallet;
    loadState();
    if(agentState && agentState.walletPrivateKey){
      return restoreAgentWallet(agentState.walletPrivateKey);
    }
    try {
      var existingRaw = localStorage.getItem(SESSION_KEY);
      if(existingRaw){
        var existing = JSON.parse(existingRaw);
        if(existing && existing.privateKey){
          return restoreAgentWallet(existing.privateKey);
        }
      }
    } catch(e){}
    var w = createAgentWallet();
    if(w && agentState){
      var sess = { privateKey: w.privateKey, createdAt: Date.now() };
      try { localStorage.setItem(SESSION_KEY, JSON.stringify(sess)); } catch(e){}
    }
    return w;
  }

  function getAgentWallet(){
    if(agentWallet) return agentWallet;
    if(agentState && agentState.walletPrivateKey) return restoreAgentWallet(agentState.walletPrivateKey);
    return getOrCreateWallet();
  }

  function getAgentAddress(){
    var w = getOrCreateWallet();
    return w ? w.address : null;
  }

  function getAgentSigner(){
    var w = getAgentWallet();
    if(!w) return null;
    var p = getAgentProvider();
    if(!w.provider || w.provider._getConnection !== p._getConnection){
      try { w = w.connect(p); agentWallet = w; } catch(e){}
    }
    return w;
  }

  function getAgentProvider(){
    if(agentProvider) return agentProvider;
    agentProvider = new ethers.JsonRpcProvider(ARC_RPC);
    return agentProvider;
  }

  function setAgentId(id){
    if(!agentState) loadState();
    agentState.agentId = id;
    saveState();
  }

  function getAgentId(){
    if(!agentState) loadState();
    return agentState && agentState.agentId ? agentState.agentId : null;
  }

  function registerIdentity(tokenId, txHash, metadataURI){
    if(!agentState) loadState();
    agentState.identityTokenId = tokenId;
    agentState.identityTxHash = txHash;
    agentState.identityRegistered = true;
    agentState.metadataURI = metadataURI || agentState.metadataURI;
    agentState.registrationDate = agentState.registrationDate || Date.now();
    saveState();
  }

  function setStatus(status){
    if(!agentState) loadState();
    agentState.status = status;
    saveState();
  }

  function pause(){
    setStatus('paused');
    agentState.pausedUntil = null;
    agentState.sessionStatus = 'paused';
    saveState();
  }

  function resume(){
    setStatus('active');
    agentState.pausedUntil = null;
    agentState.sessionStatus = 'active';
    saveState();
  }

  function isPaused(){
    if(!agentState) loadState();
    return agentState.status === 'paused' || (agentState.pausedUntil && agentState.pausedUntil > Date.now());
  }

  function isActive(){
    if(!agentState) loadState();
    return agentState.status === 'active' && !(agentState.pausedUntil && agentState.pausedUntil > Date.now());
  }

  function getFullState(){
    if(!agentState) loadState();
    return Object.assign({}, agentState, {
      walletAddress: agentWallet ? agentWallet.address : (agentState ? agentState.walletAddress : null),
      isPaused: isPaused(),
      isActive: isActive()
    });
  }

  function updateReputation(stats){
    if(!agentState) loadState();
    var keys = ['reputationScore','executionCount','successfulExecutions','failedExecutions',
      'cancelledOperations','totalPlanningTime','totalExecutionTime',
      'simulationAccuracy','permitAccuracy','riskAccuracy','completionRate',
      'bridgeSuccessRate','treasurySuccessRate','paymentSuccessRate','swapSuccessRate'];
    for(var i=0;i<keys.length;i++){
      if(stats[keys[i]] !== undefined) agentState[keys[i]] = stats[keys[i]];
    }
    saveState();
  }

  function recordExecution(result, duration){
    if(!agentState) loadState();
    agentState.executionCount = (agentState.executionCount||0) + 1;
    if(result === 'success') agentState.successfulExecutions = (agentState.successfulExecutions||0) + 1;
    else if(result === 'failed') agentState.failedExecutions = (agentState.failedExecutions||0) + 1;
    else if(result === 'cancelled') agentState.cancelledOperations = (agentState.cancelledOperations||0) + 1;
    if(duration) agentState.totalExecutionTime = (agentState.totalExecutionTime||0) + duration;
    var total = agentState.successfulExecutions + agentState.failedExecutions;
    if(total > 0){
      agentState.completionRate = Math.round((agentState.successfulExecutions / total) * 100);
      agentState.reputationScore = Math.min(100, Math.max(10,
        50 + Math.round((agentState.successfulExecutions - agentState.failedExecutions * 2) / Math.max(1, total) * 50)));
    }
    saveState();
  }

  function recordOperationSuccess(operation){
    if(!agentState) loadState();
    var map = { bridge:'bridgeSuccessRate', treasury:'treasurySuccessRate', payment:'paymentSuccessRate', swap:'swapSuccessRate' };
    var key = map[operation];
    if(key){
      agentState[key] = Math.min(100, (agentState[key]||0) + 2);
      saveState();
    }
  }

  function load(){ 
    loadState();
    return agentState;
  }

  function getCapabilities(){ return agentState ? agentState.capabilities : []; }
  function getSupportedChains(){ return agentState ? agentState.supportedChains : []; }
  function getReputationScore(){ return agentState ? agentState.reputationScore : 0; }
  function getVerificationStatus(){ return agentState ? agentState.verificationStatus : 'unverified'; }

  function isIdentityRegistered(){ return agentState ? !!agentState.identityRegistered : false; }

  function exportAgentData(){
    var s = getFullState();
    return JSON.parse(JSON.stringify(s));
  }

  function resetAgent(){
    agentWallet = null;
    agentProvider = null;
    agentState = null;
    try { localStorage.removeItem(WALLET_KEY); } catch(e){}
    try { localStorage.removeItem(SESSION_KEY); } catch(e){}
  }

  // Security: never expose private key
  function getSecureWalletSummary(){
    var w = getOrCreateWallet();
    var s = getFullState();
    delete s.walletPrivateKey;
    return s;
  }

  load();

  window.AgentWalletManager = {
    getOrCreateWallet: getOrCreateWallet,
    getAgentWallet: getAgentWallet,
    getAgentAddress: getAgentAddress,
    getAgentSigner: getAgentSigner,
    getAgentProvider: getAgentProvider,
    setAgentId: setAgentId,
    getAgentId: getAgentId,
    registerIdentity: registerIdentity,
    setStatus: setStatus,
    pause: pause,
    resume: resume,
    isPaused: isPaused,
    isActive: isActive,
    getFullState: getFullState,
    getSecureWalletSummary: getSecureWalletSummary,
    updateReputation: updateReputation,
    recordExecution: recordExecution,
    recordOperationSuccess: recordOperationSuccess,
    getCapabilities: getCapabilities,
    getSupportedChains: getSupportedChains,
    getReputationScore: getReputationScore,
    getVerificationStatus: getVerificationStatus,
    isIdentityRegistered: isIdentityRegistered,
    exportAgentData: exportAgentData,
    resetAgent: resetAgent,
    load: load,
    get walletAddress(){ return getAgentAddress(); },
    get agentId(){ return getAgentId(); },
    ARC_RPC: ARC_RPC,
    ARC_CHAIN_ID: ARC_CHAIN_ID
  };
})();

