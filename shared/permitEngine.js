/**
 * Elligentt Permit Engine — In-Chat Permission & Permit System
 * Session permits, conditional permits, scheduled execution, smart checks, audit log
 * Phases 4+5: Conditional permits + scheduled/recurring execution
 * Attached to window.PermitEngine
 */
(function(){
  'use strict';

  const STORAGE_KEY = 'elligentt_permits_v2';
  const AUDIT_KEY   = 'elligentt_permit_audit_v1';
  const SCHEDULED_KEY = 'elligentt_scheduled_permits_v1';

  var permits = [];
  var auditLog = [];
  var sessionWallet = null;
  var scheduledPermits = [];
  var schedulerInterval = null;

  function load(){
    try { var raw = localStorage.getItem(STORAGE_KEY); if(raw) permits = JSON.parse(raw); } catch(e){ permits = []; }
    try { var raw2 = localStorage.getItem(AUDIT_KEY); if(raw2) auditLog = JSON.parse(raw2); } catch(e){ auditLog = []; }
    try { var raw3 = localStorage.getItem(SCHEDULED_KEY); if(raw3) scheduledPermits = JSON.parse(raw3); } catch(e){ scheduledPermits = []; }
    invalidateExpired();
  }

  function save(){
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(permits)); } catch(e){}
    try { localStorage.setItem(AUDIT_KEY, JSON.stringify(auditLog).substring(0, 50000)); } catch(e){}
  }
  function saveScheduled(){ try { localStorage.setItem(SCHEDULED_KEY, JSON.stringify(scheduledPermits)); } catch(e){} }

  function invalidateExpired(){
    var now = Date.now();
    permits = permits.filter(function(p){ return p.status !== 'revoked' && p.expiresAt > now; });
    permits.forEach(function(p){ if(p.expiresAt <= now) p.status = 'expired'; });
    save();
  }

  /* ── Session Wallet ── */
  function getSessionWallet(){
    if(sessionWallet) return sessionWallet;
    try {
      if(typeof ethers !== 'undefined'){
        var swKey = 'elligentt_session_wallet_v1';
        var existing = localStorage.getItem(swKey);
        if(existing){ sessionWallet = new ethers.Wallet(existing); }
        else { var w = ethers.Wallet.createRandom(); localStorage.setItem(swKey, w.privateKey); sessionWallet = w; }
      }
    } catch(e){}
    return sessionWallet;
  }
  function getSessionWalletAddress(){ var sw = getSessionWallet(); return sw ? sw.address : null; }

  /* ── Audit Log ── */
  function recordAudit(permitId, operation, data, result){
    var entry = {
      timestamp: Date.now(), permitId: permitId,
      wallet: (typeof walletAddress !== 'undefined') ? walletAddress : (getSessionWalletAddress() || 'unknown'),
      operation: operation, contract: (data && data.contract) || '',
      chain: (data && data.network) || 'Arc Testnet', amount: (data && data.amount) || 0,
      result: result || 'success'
    };
    auditLog.unshift(entry); if(auditLog.length > 500) auditLog.length = 500; save();
  }

  /* ── Grant ── */
  function grant(opts){
    invalidateExpired();
    var id = 'permit_' + Date.now() + '_' + Math.random().toString(36).substr(2,6);
    var now = Date.now();
    var permit = {
      id: id, type: opts.type || 'spend', asset: opts.asset || 'USDC',
      maxAmount: opts.maxAmount || 0, usedAmount: 0,
      destination: opts.destination || '*', network: opts.network || 'Arc Testnet',
      expiresAt: now + (opts.durationMs || 1800000),
      allowedOps: opts.allowedOps || [], contract: opts.contract || '',
      purpose: opts.purpose || '', status: 'active', grantedAt: now, lastUsed: null,
      conditions: opts.conditions || null, schedule: opts.schedule || null,
      maxUses: opts.maxUses || null, useCount: 0
    };
    permits.unshift(permit); save();
    recordAudit(id, 'GRANTED', opts, null);
    return permit;
  }

  /* ── Revoke ── */
  function revoke(id, reason){
    var p = permits.find(function(x){ return x.id === id; });
    if(!p) return false;
    p.status = 'revoked'; p.revokedAt = Date.now(); p.revokeReason = reason || 'User requested';
    save(); recordAudit(id, 'REVOKED', null, reason);
    return true;
  }
  function revokeAll(reason){
    var r = reason || 'Revoke all';
    permits.forEach(function(p){ if(p.status==='active'){p.status='revoked';p.revokedAt=Date.now();p.revokeReason=r;} });
    save(); recordAudit('all','REVOKED_ALL',null,r);
    return true;
  }
  function revokeByType(type, reason){
    var count=0;
    permits.forEach(function(p){ if(p.status==='active'&&p.type===type){p.status='revoked';p.revokedAt=Date.now();p.revokeReason=reason||'Revoked by type';count++;} });
    if(count>0) save(); return count;
  }
  function revokeByOperation(op, reason){
    var count=0;
    permits.forEach(function(p){ if(p.status==='active'&&p.allowedOps.indexOf(op)!==-1){p.status='revoked';p.revokedAt=Date.now();p.revokeReason='Revoked operation: '+op;count++;} });
    if(count>0) save(); return count;
  }
  function disableOperation(op, reason){
    var count=0;
    permits.forEach(function(p){ if(p.status==='active'){var idx=p.allowedOps.indexOf(op);if(idx!==-1){p.allowedOps.splice(idx,1);count++;}} });
    if(count>0) save(); return count;
  }

  /* ── Validate Conditions (Phase 4) ── */
  function validateConditions(permit){
    if(!permit.conditions) return { valid: true, failed: [] };
    var failed = [];
    var cond = permit.conditions;
    if(cond.windowStart !== undefined && cond.windowEnd !== undefined){
      var h = new Date().getUTCHours();
      if(h < cond.windowStart || h >= cond.windowEnd) failed.push('Outside execution window ('+cond.windowStart+':00-'+cond.windowEnd+':00 UTC)');
    }
    if(cond.maxGasUsd !== undefined && cond.maxGasUsd !== null){}
    if(cond.destinationOnline === false) failed.push('Destination chain is offline');
    if(cond.treasuryHealthy === false) failed.push('Treasury health check failed');
    return { valid: failed.length === 0, failed: failed };
  }

  /* ── Smart Check (with conditions + maxUses) ── */
  function checkCoverage(opts){
    invalidateExpired();
    var now = Date.now(), required = opts.amount || 0, asset = opts.asset || 'USDC';
    var network = opts.network || 'Arc Testnet', operation = opts.operation || '', contract = opts.contract || '';
    for(var i=0;i<permits.length;i++){
      var p=permits[i];
      if(p.status!=='active') continue;
      if(p.expiresAt<=now) continue;
      if(p.asset!==asset) continue;
      if(p.network!=='*'&&p.network!==network) continue;
      if(p.allowedOps.length>0&&p.allowedOps.indexOf(operation)===-1) continue;
      if(p.contract&&contract&&p.contract!==contract&&p.contract!=='*') continue;
      var condCheck=validateConditions(p);
      if(!condCheck.valid) return {covered:false,permit:p,remaining:0,needsEscalation:false,shortfall:0,conditionsFailed:condCheck.failed};
      if(p.maxUses&&p.useCount>=p.maxUses) return {covered:false,permit:p,remaining:0,needsEscalation:false,shortfall:0,maxUsesReached:true};
      var remaining=p.maxAmount-p.usedAmount;
      if(remaining<=0) continue;
      if(remaining>=required) return {covered:true,permit:p,remaining:remaining,needsEscalation:false,shortfall:0};
      else return {covered:false,permit:p,remaining:remaining,needsEscalation:true,shortfall:required-remaining};
    }
    return {covered:false,permit:null,remaining:0,needsEscalation:false,shortfall:required};
  }

  function checkCoverageBasic(opts){
    var now=Date.now(),required=opts.amount||0,asset=opts.asset||'USDC',network=opts.network||'Arc Testnet',operation=opts.operation||'',contract=opts.contract||'';
    for(var i=0;i<permits.length;i++){
      var p=permits[i];
      if(p.status!=='active') continue; if(p.expiresAt<=now) continue;
      if(p.asset!==asset) continue; if(p.network!=='*'&&p.network!==network) continue;
      if(p.allowedOps.length>0&&p.allowedOps.indexOf(operation)===-1) continue;
      if(p.contract&&contract&&p.contract!==contract&&p.contract!=='*') continue;
      var remaining=p.maxAmount-p.usedAmount; if(remaining<=0) continue;
      if(remaining>=required) return {covered:true,permit:p,remaining:remaining,needsEscalation:false,shortfall:0};
      else return {covered:false,permit:p,remaining:remaining,needsEscalation:true,shortfall:required-remaining};
    }
    return {covered:false,permit:null,remaining:0,needsEscalation:false,shortfall:required};
  }

  /* ── Record Usage ── */
  function recordUsage(permitId, amount, operation, result){
    var p=permits.find(function(x){return x.id===permitId;});
    if(p&&p.status==='active'){
      p.usedAmount=Math.min(p.maxAmount,(p.usedAmount||0)+amount); p.lastUsed=Date.now();
      p.useCount=(p.useCount||0)+1;
      if(p.usedAmount>=p.maxAmount) p.status='depleted';
      if(p.maxUses&&p.useCount>=p.maxUses) p.status='depleted';
    }
    save(); recordAudit(permitId,operation||'EXECUTED',{amount:amount},result);
  }

  function validateOperation(operation, amount, asset, network, contract){
    var check=checkCoverage({operation:operation,amount:amount,asset:asset,network:network,contract:contract});
    if(check.covered) return {valid:true,permit:check.permit,reason:''};
    if(check.needsEscalation) return {valid:false,permit:check.permit,reason:'escalation',shortfall:check.shortfall,currentLimit:check.remaining+check.permit.usedAmount};
    return {valid:false,permit:null,reason:'no_permit'};
  }

  /* ── Queries ── */
  function getActive(){ invalidateExpired(); var now=Date.now(); return permits.filter(function(p){return p.status==='active'&&p.expiresAt>now;}); }
  function getByStatus(status){ return permits.filter(function(p){return p.status===status;}); }
  function getAll(){ return permits.slice(); }
  function getAuditLog(limit){ return auditLog.slice(0,limit||50); }

  /* ── Modify ── */
  function increaseLimit(id, newMax){
    var p=permits.find(function(x){return x.id===id;}); if(!p||p.status!=='active') return false;
    p.maxAmount=newMax; save(); recordAudit(id,'INCREASE_LIMIT',{newMax:newMax},null); return true;
  }
  function extendExpiry(id, newExpiryMs){
    var p=permits.find(function(x){return x.id===id;}); if(!p||p.status!=='active') return false;
    p.expiresAt=Date.now()+newExpiryMs; save(); recordAudit(id,'EXTEND_EXPIRY',{newExpiryMs:newExpiryMs},null); return true;
  }

  /* ── Format helpers ── */
  function fmtTimeLeft(expiresAt){
    var diff=expiresAt-Date.now(); if(diff<=0) return 'Expired';
    var m=Math.floor(diff/60000),s=Math.floor((diff%60000)/1000);
    if(m>=1440) return Math.floor(m/1440)+'d '+Math.floor((m%1440)/60)+'h';
    if(m>=60) return Math.floor(m/60)+'h '+(m%60)+'m';
    if(m>0) return m+'m '+s+'s'; return s+'s';
  }
  function fmtDate(ts){ return new Date(ts).toLocaleString(); }

  /* ── Scheduled Permits (Phase 5) ── */
  function createScheduled(opts){
    var id='sched_'+Date.now()+'_'+Math.random().toString(36).substr(2,4);
    var sched={
      id:id, name:opts.name||'Scheduled permit',
      basePermit:{type:opts.type||'spend',asset:opts.asset||'USDC',maxAmount:opts.maxAmount||0,destination:opts.destination||'*',network:opts.network||'Arc Testnet',allowedOps:opts.allowedOps||[],contract:opts.contract||'',purpose:opts.purpose||''},
      recurrence:opts.recurrence||'weekly', customInterval:opts.customInterval||null,
      dayOfWeek:opts.dayOfWeek||null, dayOfMonth:opts.dayOfMonth||null,
      lastExecuted:null, nextExecution:calcNextExecution(opts), active:true,
      createdAt:Date.now(), maxExecutions:opts.maxExecutions||null, executionCount:0
    };
    scheduledPermits.unshift(sched); saveScheduled(); return sched;
  }

  function calcNextExecution(opts){
    var now=new Date();
    switch(opts.recurrence){
      case 'daily': now.setUTCDate(now.getUTCDate()+1); now.setUTCHours(0,0,0,0); return now.getTime();
      case 'weekly': var td=opts.dayOfWeek!==null?opts.dayOfWeek:1; var du=(td+7-now.getUTCDay())%7; if(du===0) du=7; now.setUTCDate(now.getUTCDate()+du); now.setUTCHours(0,0,0,0); return now.getTime();
      case 'biweekly': now.setUTCDate(now.getUTCDate()+14); now.setUTCHours(0,0,0,0); return now.getTime();
      case 'monthly': var tdm=opts.dayOfMonth||1; if(now.getUTCDate()>=tdm||tdm>28){now.setUTCMonth(now.getUTCMonth()+1,1);now.setUTCDate(Math.min(tdm,new Date(now.getUTCFullYear(),now.getUTCMonth()+1,0).getUTCDate()));}else{now.setUTCDate(tdm);} now.setUTCHours(0,0,0,0); return now.getTime();
      case 'custom': if(opts.customInterval) return Date.now()+opts.customInterval; return Date.now()+86400000;
      default: return Date.now()+604800000;
    }
  }

  function getScheduled(){ return scheduledPermits.filter(function(s){return s.active;}); }
  function getScheduledDue(){ return getScheduled().filter(function(s){return s.nextExecution<=Date.now();}); }

  function executeScheduled(schedId){
    var s=scheduledPermits.find(function(x){return x.id===schedId;});
    if(!s||!s.active||s.nextExecution>Date.now()) return null;
    var permit=grant({type:s.basePermit.type,asset:s.basePermit.asset,maxAmount:s.basePermit.maxAmount,destination:s.basePermit.destination,network:s.basePermit.network,allowedOps:s.basePermit.allowedOps,contract:s.basePermit.contract,purpose:s.basePermit.purpose+' (scheduled: '+s.name+')',durationMs:recurrenceToMs(s.recurrence)});
    s.lastExecuted=Date.now(); s.executionCount=(s.executionCount||0)+1;
    s.nextExecution=calcNextExecution({recurrence:s.recurrence,dayOfWeek:s.dayOfWeek,dayOfMonth:s.dayOfMonth,customInterval:s.customInterval});
    if(s.maxExecutions&&s.executionCount>=s.maxExecutions) s.active=false;
    saveScheduled(); return permit;
  }

  function cancelScheduled(schedId){
    var s=scheduledPermits.find(function(x){return x.id===schedId;}); if(!s) return false; s.active=false; saveScheduled(); return true;
  }

  function recurrenceToMs(rec){ var m={daily:86400000,weekly:604800000,biweekly:1209600000,monthly:2592000000}; return m[rec]||604800000; }

  function fmtRecurrence(sched){
    var m={daily:'Daily',weekly:'Weekly',biweekly:'Bi-weekly',monthly:'Monthly',custom:'Custom'};
    var l=m[sched.recurrence]||sched.recurrence;
    var d=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    if(sched.recurrence==='weekly'&&sched.dayOfWeek!==null) l+=' on '+d[sched.dayOfWeek];
    if(sched.recurrence==='monthly'&&sched.dayOfMonth) l+=' on day '+sched.dayOfMonth;
    return l;
  }

  function startScheduler(){
    if(schedulerInterval) return;
    schedulerInterval=setInterval(function(){ getScheduledDue(); },30000);
  }

  // Public API
  window.PermitEngine = {
    grant:grant, revoke:revoke, revokeAll:revokeAll, revokeByType:revokeByType,
    revokeByOperation:revokeByOperation, disableOperation:disableOperation,
    checkCoverage:checkCoverage, checkCoverageBasic:checkCoverageBasic,
    recordUsage:recordUsage, validateOperation:validateOperation,
    getActive:getActive, getAll:getAll, getByStatus:getByStatus, getAuditLog:getAuditLog,
    increaseLimit:increaseLimit, extendExpiry:extendExpiry,
    getSessionWallet:getSessionWallet, getSessionWalletAddress:getSessionWalletAddress,
    fmtTimeLeft:fmtTimeLeft, fmtDate:fmtDate,
    getPermitCount:function(){return getActive().length;},
    hasActivePermit:function(){return getActive().length>0;},
    validateConditions:validateConditions,
    // Scheduled permits
    createScheduled:createScheduled, getScheduled:getScheduled, getScheduledDue:getScheduledDue,
    executeScheduled:executeScheduled, cancelScheduled:cancelScheduled,
    fmtRecurrence:fmtRecurrence, recurrenceToMs:recurrenceToMs
  };

  load(); startScheduler();
})();
