/**
 * Autonoma Agent Reputation — On-chain reputation tracking
 * Tracks execution success rates, maintains reputation score.
 * Integrates with ERC-8004 ReputationRegistry for on-chain attestation.
 * Attached to window.AgentReputation
 */
(function(){
  'use strict';

  var REP_KEY = 'elligentt_agent_reputation_v1';
  var stats = null;

  var defaultStats = function(){
    return {
      successfulExecutions: 0,
      failedExecutions: 0,
      cancelledOperations: 0,
      totalOperations: 0,
      averagePlanningTime: 0,
      totalPlanningTime: 0,
      averageExecutionTime: 0,
      totalExecutionTime: 0,
      simulationAccuracy: 80,
      permitAccuracy: 80,
      riskAccuracy: 80,
      completionRate: 100,
      bridgeSuccessRate: 100,
      treasurySuccessRate: 100,
      paymentSuccessRate: 100,
      swapSuccessRate: 100,
      lastUpdated: Date.now(),
      reputationScore: 50
    };
  };

  function load(){
    try {
      var r=localStorage.getItem(REP_KEY);
      if(r) stats=JSON.parse(r);
    } catch(e){ stats=null; }
    if(!stats) stats=defaultStats();
  }

  function save(){
    try { localStorage.setItem(REP_KEY, JSON.stringify(stats)); } catch(e){}
  }

  function recordSuccess(operation, duration, planningTime){
    stats.successfulExecutions++;
    stats.totalOperations++;
    if(planningTime){ stats.totalPlanningTime+=planningTime; stats.averagePlanningTime=Math.round(stats.totalPlanningTime/stats.successfulExecutions); }
    if(duration){ stats.totalExecutionTime+=duration; stats.averageExecutionTime=Math.round(stats.totalExecutionTime/stats.successfulExecutions); }
    updateOperationRate(operation, 'success');
    recalculateScores();
    stats.lastUpdated=Date.now();
    save();

    // Sync with AgentWalletManager
    if(typeof AgentWalletManager!=='undefined'){
      AgentWalletManager.recordExecution('success', duration);
      AgentWalletManager.updateReputation(stats);
    }
  }

  function recordFailure(operation){
    stats.failedExecutions++;
    stats.totalOperations++;
    updateOperationRate(operation, 'failure');
    recalculateScores();
    stats.lastUpdated=Date.now();
    save();

    if(typeof AgentWalletManager!=='undefined'){
      AgentWalletManager.recordExecution('failed', 0);
      AgentWalletManager.updateReputation(stats);
    }
  }

  function recordCancellation(){
    stats.cancelledOperations++;
    stats.totalOperations++;
    recalculateScores();
    stats.lastUpdated=Date.now();
    save();

    if(typeof AgentWalletManager!=='undefined'){
      AgentWalletManager.recordExecution('cancelled', 0);
    }
  }

  function updateOperationRate(operation, result){
    var map={ bridge:'bridgeSuccessRate', treasury:'treasurySuccessRate', payment:'paymentSuccessRate', swap:'swapSuccessRate' };
    var key=map[operation];
    if(!key) return;

    var total=stats.successfulExecutions+stats.failedExecutions;
    if(total===0) return;

    if(result==='success'){
      stats[key]=Math.min(100, stats[key]+2);
    } else {
      stats[key]=Math.max(0, stats[key]-5);
    }
  }

  function recalculateScores(){
    var total=stats.successfulExecutions+stats.failedExecutions;
    if(total===0){
      stats.completionRate=100;
      stats.reputationScore=50;
    } else {
      stats.completionRate=Math.round((stats.successfulExecutions/total)*100);
      stats.reputationScore=Math.min(100, Math.max(10,
        50+Math.round((stats.successfulExecutions-stats.failedExecutions*2)/Math.max(1,total)*50)));
    }
  }

  function getReputation(){
    return JSON.parse(JSON.stringify(stats));
  }

  function getReputationScore(){
    return stats?stats.reputationScore:50;
  }

  function getReputationGrade(){
    var s=stats?stats.reputationScore:50;
    if(s>=90) return { grade:'S', label:'Exceptional', color:'#06F7E9' };
    if(s>=75) return { grade:'A', label:'Excellent', color:'#22c55e' };
    if(s>=60) return { grade:'B', label:'Good', color:'#4f8ef7' };
    if(s>=40) return { grade:'C', label:'Average', color:'#f59e0b' };
    if(s>=20) return { grade:'D', label:'Poor', color:'#f97316' };
    return { grade:'F', label:'Critical', color:'#ef4444' };
  }

  /* ── On-chain reputation recording (uses validator wallet - must be different from agent owner) ── */
  async function recordOnChainReputation(validatorSigner, agentId, score, tag, domain){
    if(typeof ethers==='undefined') throw new Error('ethers.js not loaded');
    if(!validatorSigner || !agentId) throw new Error('Validator signer and agent ID required');

    var ABI=typeof AgentIdentity!=='undefined'?AgentIdentity.getReputationRegistryABI():[];
    if(ABI.length===0) throw new Error('Reputation registry ABI not available');

    var REPUTATION_REGISTRY=typeof AgentIdentity!=='undefined'?AgentIdentity.REPUTATION_REGISTRY:'0x8004B663056A597Dffe9eCcC1965A193B7388713';
    var feedbackHash=ethers.keccak256(ethers.toUtf8Bytes(tag||'successful_execution'));

    var contract=new ethers.Contract(REPUTATION_REGISTRY, ABI, validatorSigner);
    var tx=await contract.giveFeedback(agentId, score||95, domain||0, tag||'successful_execution','','','',feedbackHash);
    var receipt=await tx.wait();

    return { txHash:receipt.hash, agentId:agentId, score:score, tag:tag };
  }

  /* ── On-chain reputation query ── */
  async function queryOnChainReputation(agentId){
    if(typeof ethers==='undefined') throw new Error('ethers.js not loaded');
    var provider=new ethers.JsonRpcProvider(typeof AgentIdentity!=='undefined'?AgentIdentity.ARC_RPC:'https://rpc.testnet.arc.network');
    var REPUTATION_REGISTRY=typeof AgentIdentity!=='undefined'?AgentIdentity.REPUTATION_REGISTRY:'0x8004B663056A597Dffe9eCcC1965A193B7388713';
    var ABI=typeof AgentIdentity!=='undefined'?AgentIdentity.getReputationRegistryABI():[];

    var contract=new ethers.Contract(REPUTATION_REGISTRY, ABI, provider);
    var result=await contract.getFeedback(agentId);
    return {
      totalScore:Number(result.totalScore),
      count:Number(result.count),
      domainCount:result.domainCount.map(function(d){return Number(d);})
    };
  }

  load();

  window.AgentReputation = {
    recordSuccess:recordSuccess,
    recordFailure:recordFailure,
    recordCancellation:recordCancellation,
    getReputation:getReputation,
    getReputationScore:getReputationScore,
    getReputationGrade:getReputationGrade,
    recordOnChainReputation:recordOnChainReputation,
    queryOnChainReputation:queryOnChainReputation
  };
})();
