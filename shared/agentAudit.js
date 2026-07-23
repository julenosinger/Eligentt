/**
 * Autonoma Agent Audit — Immutable Execution Audit Records
 * Every execution generates an immutable record stored locally.
 * Stores execution ID, authorization ID, agent wallet, identity, planner version,
 * simulation hash, risk report, executed contract, chain, tx hash, timestamp, result.
 * Attached to window.AgentAudit
 */
(function(){
  'use strict';

  var AUDIT_KEY = 'elligentt_agent_audit_v1';
  var MAX_RECORDS = 500;
  var auditRecords = [];

  function load(){
    try {
      var r=localStorage.getItem(AUDIT_KEY);
      if(r) auditRecords=JSON.parse(r);
    } catch(e){ auditRecords=[]; }
  }

  function save(){
    try {
      var trimmed=auditRecords.slice(0, MAX_RECORDS);
      localStorage.setItem(AUDIT_KEY, JSON.stringify(trimmed));
    } catch(e){}
  }

  /* ── Record an execution audit entry ── */
  function recordExecution(opts){
    var agentWallet=typeof AgentWalletManager!=='undefined'?AgentWalletManager.getAgentAddress():null;
    var agentId=typeof AgentWalletManager!=='undefined'?AgentWalletManager.getAgentId():null;
    var identity=typeof AgentIdentity!=='undefined'?AgentIdentity.getDisplayIdentity():null;

    var entry={
      // Core identifiers
      executionId: 'exec_'+Date.now()+'_'+Math.random().toString(36).substr(2,8),
      authorizationId: opts.authorizationId||'',
      agentWallet: agentWallet||'',
      erc8004Identity: agentId||'',
      agentName: identity?identity.name:'Autonoma',

      // Planning data
      plannerVersion: opts.plannerVersion||'1.0.0',
      planId: opts.planId||'',

      // Simulation data
      simulationHash: opts.simulationHash||'',
      simulationResult: opts.simulationResult||'',

      // Risk data
      riskReport: opts.riskReport||null,
      riskLevel: opts.riskLevel||'LOW',
      confidenceScore: opts.confidenceScore||0,

      // Execution data
      operation: opts.operation||'',
      executedContract: opts.executedContract||'',
      chain: opts.chain||'Arc Testnet',
      network: opts.network||'Arc Testnet',
      transactionHash: opts.transactionHash||'',
      amount: opts.amount||0,
      asset: opts.asset||'USDC',

      // Policy data
      executionPolicy: opts.executionPolicy||'default',
      policyValidation: opts.policyValidation||null,

      // Results
      result: opts.result||'unknown',
      timestamp: Date.now(),
      duration: opts.duration||0,
      gasUsed: opts.gasUsed||0,
      error: opts.error||null,

      // Trust layer
      trustLayer: opts.trustLayer||null,

      // Additional metadata
      metadata: opts.metadata||{}
    };

    auditRecords.unshift(entry);
    save();

    // Also record in ExecutionHistory if available
    if(typeof ExecutionHistory!=='undefined'){
      try {
        ExecutionHistory.recordExecution({
          operation:entry.operation, amount:entry.amount, asset:entry.asset,
          chain:entry.chain, contract:entry.executedContract,
          gas:entry.gasUsed.toString(), duration:entry.duration,
          result:entry.result, txHash:entry.transactionHash,
          permitId:entry.authorizationId
        });
      } catch(e){}
    }

    return entry;
  }

  /* ── Query audit records ── */
  function getRecords(filter, limit){
    var all=auditRecords.slice(0, limit||100);
    if(!filter) return all;

    if(filter==='today'){
      var today=new Date(); today.setUTCHours(0,0,0,0);
      return all.filter(function(r){return r.timestamp>=today.getTime();});
    }
    if(filter==='week'){
      return all.filter(function(r){return r.timestamp>=Date.now()-604800000;});
    }
    if(filter==='month'){
      return all.filter(function(r){return r.timestamp>=Date.now()-2592000000;});
    }
    if(filter==='failed'){
      return all.filter(function(r){return r.result==='failed';});
    }
    if(filter==='success'){
      return all.filter(function(r){return r.result==='success';});
    }
    return all.filter(function(r){return r.operation===filter;});
  }

  function getRecord(executionId){
    return auditRecords.find(function(r){return r.executionId===executionId;});
  }

  /* ── Statistics ── */
  function getStats(){
    var all=auditRecords;
    var now=Date.now();
    var today=all.filter(function(r){return r.timestamp>=now-86400000;});
    var week=all.filter(function(r){return r.timestamp>=now-604800000;});
    var month=all.filter(function(r){return r.timestamp>=now-2592000000;});

    var byOp={};
    var byChain={};
    var totalAmount=0;
    var failedCount=0;
    var successCount=0;

    for(var i=0;i<all.length;i++){
      var r=all[i];
      byOp[r.operation]=(byOp[r.operation]||0)+1;
      byChain[r.chain]=(byChain[r.chain]||0)+1;
      totalAmount+=(r.amount||0);
      if(r.result==='failed') failedCount++;
      if(r.result==='success') successCount++;
    }

    var total=all.length;
    return {
      total:total, today:today.length, week:week.length, month:month.length,
      totalAmount:totalAmount, failedCount:failedCount, successCount:successCount,
      successRate:total>0?Math.round((successCount/total)*100):100,
      topOp:Object.entries(byOp).sort(function(a,b){return b[1]-a[1];}).slice(0,5),
      topChain:Object.entries(byChain).sort(function(a,b){return b[1]-a[1];}).slice(0,3),
      avgDuration:all.length>0?Math.round(all.reduce(function(s,r){return s+(r.duration||0);},0)/all.length):0
    };
  }

  /* ── Export ── */
  function exportAuditLog(format){
    var records=auditRecords.slice();
    if(format==='csv'){
      var header='executionId,operation,amount,asset,chain,txHash,result,timestamp,duration\n';
      return header+records.map(function(r){
        return [r.executionId,r.operation,r.amount,r.asset,r.chain,r.transactionHash,r.result,r.timestamp,r.duration].join(',');
      }).join('\n');
    }
    return JSON.stringify(records, null, 2);
  }

  function clearAudit(){
    auditRecords=[];
    save();
  }

  function fmtDate(ts){ return new Date(ts).toLocaleString(); }

  load();

  window.AgentAudit = {
    recordExecution:recordExecution,
    getRecords:getRecords,
    getRecord:getRecord,
    getStats:getStats,
    exportAuditLog:exportAuditLog,
    clearAudit:clearAudit,
    fmtDate:fmtDate,
    get count(){ return auditRecords.length; }
  };
})();
