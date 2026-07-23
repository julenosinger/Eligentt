/**
 * Autonoma Agent Authorization — Delegated Execution Authorization
 * Manages on-chain authorization from user wallet to Agent Wallet.
 * The Agent Wallet may only execute operations explicitly granted by the user.
 * Authorization is revocable at any time.
 * Attached to window.AgentAuthorization
 */
(function(){
  'use strict';

  var AUTH_KEY = 'elligentt_agent_auth_v1';
  var AUTH_HISTORY_KEY = 'elligentt_agent_auth_history_v1';
  var authorizations = [];
  var authHistory = [];

  function load(){
    try { var r=localStorage.getItem(AUTH_KEY); if(r) authorizations=JSON.parse(r); } catch(e){ authorizations=[]; }
    try { var rh=localStorage.getItem(AUTH_HISTORY_KEY); if(rh) authHistory=JSON.parse(rh); } catch(e){ authHistory=[]; }
    invalidateExpired();
  }

  function save(){
    try { localStorage.setItem(AUTH_KEY, JSON.stringify(authorizations)); } catch(e){}
  }

  function saveHistory(){
    try { localStorage.setItem(AUTH_HISTORY_KEY, JSON.stringify(authHistory).substring(0,50000)); } catch(e){}
  }

  function invalidateExpired(){
    var now=Date.now();
    for(var i=0;i<authorizations.length;i++){
      var a=authorizations[i];
      if(a.status==='active'&&a.expiresAt&&a.expiresAt<=now){ a.status='expired'; }
      if(a.maxUses&&a.useCount>=a.maxUses){ a.status='depleted'; }
    }
    save();
  }

  function recordAuthHistory(authId, action, details){
    authHistory.unshift({
      timestamp:Date.now(), authId:authId, action:action, details:details||''
    });
    if(authHistory.length>200) authHistory.length=200;
    saveHistory();
  }

  /* ── Create Agent Authorization ── */
  function createAuthorization(opts){
    invalidateExpired();
    var id='agentauth_'+Date.now()+'_'+Math.random().toString(36).substr(2,6);
    var now=Date.now();
    var auth={
      id:id, status:'active', version:1,
      // Scope
      maxSpending:opts.maxSpending||0, usedSpending:0,
      allowedTokens:opts.allowedTokens||['USDC'],
      allowedContracts:opts.allowedContracts||['*'],
      allowedNetworks:opts.allowedNetworks||['Arc Testnet'],
      allowedOperations:opts.allowedOperations||[],
      // Limits
      dailyLimit:opts.dailyLimit||null, dailyUsed:0, dailyReset:now,
      sessionDuration:opts.sessionDuration||86400000,
      expiresAt:now+(opts.durationMs||3600000),
      maxUses:opts.maxUses||null, useCount:0,
      // Risk
      maxRiskLevel:opts.maxRiskLevel||'MEDIUM',
      timeWindow:opts.timeWindow||null, // {start:0,end:24} hours UTC
      // Recipients
      allowedRecipients:opts.allowedRecipients||['*'],
      bridgeDestinations:opts.bridgeDestinations||['*'],
      treasuryPermissions:opts.treasuryPermissions||false,
      // Operations
      allowSwap:opts.allowSwap!==undefined?opts.allowSwap:true,
      allowBridge:opts.allowBridge!==undefined?opts.allowBridge:true,
      allowTreasury:opts.allowTreasury!==undefined?opts.allowTreasury:false,
      allowPayments:opts.allowPayments!==undefined?opts.allowPayments:true,
      allowContracts:opts.allowContracts!==undefined?opts.allowContracts:false,
      allowVault:opts.allowVault!==undefined?opts.allowVault:false,
      allowCrosschain:opts.allowCrosschain!==undefined?opts.allowCrosschain:true,
      allowRecurring:opts.allowRecurring!==undefined?opts.allowRecurring:false,
      allowScheduled:opts.allowScheduled!==undefined?opts.allowScheduled:false,
      // Meta
      grantedBy:opts.grantedBy||(typeof walletAddress!=='undefined'?walletAddress:null),
      agentWallet:opts.agentWallet||(typeof AgentWalletManager!=='undefined'?AgentWalletManager.getAgentAddress():null),
      purpose:opts.purpose||'',
      grantedAt:now, lastUsed:null,
      onChainAuthId:opts.onChainAuthId||null,
      signatureProof:opts.signatureProof||null
    };
    authorizations.unshift(auth); save();
    recordAuthHistory(id,'CREATED',{opts:JSON.parse(JSON.stringify(opts))});
    return auth;
  }

  /* ── Revoke ── */
  function revokeAuthorization(id, reason){
    var a=authorizations.find(function(x){return x.id===id;});
    if(!a) return false;
    a.status='revoked'; a.revokedAt=Date.now(); a.revokeReason=reason||'User requested';
    save(); recordAuthHistory(id,'REVOKED',reason);
    return true;
  }

  function revokeAll(reason){
    var r=reason||'Revoke all agent authorizations';
    authorizations.forEach(function(a){ if(a.status==='active'){ a.status='revoked'; a.revokedAt=Date.now(); a.revokeReason=r; } });
    save(); recordAuthHistory('all','REVOKED_ALL',r);
    return true;
  }

  /* ── Validate execution against authorization ── */
  function validateExecution(opts){
    invalidateExpired();
    var operation=opts.operation||'';
    var amount=opts.amount||0;
    var asset=opts.asset||'USDC';
    var network=opts.network||'Arc Testnet';
    var contract=opts.contract||'';
    var destination=opts.destination||'';
    var now=Date.now();
    var activeAuths=authorizations.filter(function(a){return a.status==='active'&&a.expiresAt>now;});

    if(activeAuths.length===0){
      return {valid:false,reason:'No active agent authorization',needsAuthorization:true};
    }

    var results=[];
    for(var i=0;i<activeAuths.length;i++){
      var a=activeAuths[i];
      var checks=[];

      // Time window check
      if(a.timeWindow){
        var h=new Date().getUTCHours();
        if(h<a.timeWindow.start||h>=a.timeWindow.end){
          results.push({auth:a,valid:false,reason:'Outside allowed time window ('+a.timeWindow.start+':00-'+a.timeWindow.end+':00 UTC)'});
          continue;
        }
      }

      // Daily limit check (reset if new day)
      if(a.dailyLimit&&Date.now()-a.dailyReset>86400000){ a.dailyUsed=0; a.dailyReset=Date.now(); }
      if(a.dailyLimit&&a.dailyUsed+amount>a.dailyLimit){
        results.push({auth:a,valid:false,reason:'Daily limit exceeded ('+a.dailyLimit+')',remaining:a.dailyLimit-a.dailyUsed});
        continue;
      }

      // Max spending check
      if(a.maxSpending>0&&a.usedSpending+amount>a.maxSpending){
        results.push({auth:a,valid:false,reason:'Max spending exceeded ('+a.maxSpending+')',remaining:a.maxSpending-a.usedSpending});
        continue;
      }

      // Token check
      if(a.allowedTokens.indexOf('*')===-1&&a.allowedTokens.indexOf(asset)===-1){
        results.push({auth:a,valid:false,reason:'Token '+asset+' not allowed'});
        continue;
      }

      // Network check
      if(a.allowedNetworks.indexOf('*')===-1&&a.allowedNetworks.indexOf(network)===-1){
        results.push({auth:a,valid:false,reason:'Network '+network+' not allowed'});
        continue;
      }

      // Operation check
      if(a.allowedOperations.length>0&&a.allowedOperations.indexOf(operation)===-1){
        results.push({auth:a,valid:false,reason:'Operation '+operation+' not allowed'});
        continue;
      }

      // Operation-specific checks
      if(!checkOperationPermission(a,operation)){
        results.push({auth:a,valid:false,reason:'Operation '+operation+' not permitted'});
        continue;
      }

      // Contract check
      if(contract&&a.allowedContracts.indexOf('*')===-1&&a.allowedContracts.indexOf(contract)===-1){
        results.push({auth:a,valid:false,reason:'Contract not trusted'});
        continue;
      }

      // Destination check
      if(destination&&destination!=='*'&&a.allowedRecipients.indexOf('*')===-1&&a.allowedRecipients.indexOf(destination)===-1){
        results.push({auth:a,valid:false,reason:'Destination not in allowed list'});
        continue;
      }

      // Max uses check
      if(a.maxUses&&a.useCount>=a.maxUses){
        results.push({auth:a,valid:false,reason:'Max uses reached ('+a.maxUses+')'});
        continue;
      }

      // All checks passed
      results.push({auth:a,valid:true,reason:'',allowance:{
        remaining:a.maxSpending>0?a.maxSpending-a.usedSpending:null,
        dailyRemaining:a.dailyLimit?a.dailyLimit-a.dailyUsed:null,
        usesRemaining:a.maxUses?a.maxUses-a.useCount:null,
        expiresAt:a.expiresAt
      }});
    }

    var valid=results.find(function(r){return r.valid;});
    if(valid) return valid;
    if(results.length===0){
      return {valid:false,reason:'No active agent authorization',needsAuthorization:true};
    }
    return results[0];
  }

  function checkOperationPermission(auth, operation){
    var map={
      swap:'allowSwap', bridge:'allowBridge', treasury:'allowTreasury',
      payment:'allowPayments', contract:'allowContracts', vault:'allowVault',
      crosschain:'allowCrosschain', recurring:'allowRecurring', scheduled:'allowScheduled',
      multisend:'allowPayments'
    };
    var key=map[operation];
    if(key) return auth[key]===true;
    return auth.allowContracts===true;
  }

  /* ── Record usage ── */
  function recordUsage(authId, amount, operation, result){
    var a=authorizations.find(function(x){return x.id===authId;});
    if(!a||a.status!=='active') return;
    a.usedSpending=Math.min(a.maxSpending||Infinity,(a.usedSpending||0)+amount);
    a.dailyUsed=(a.dailyUsed||0)+amount;
    a.useCount=(a.useCount||0)+1;
    a.lastUsed=Date.now();
    if(a.maxSpending>0&&a.usedSpending>=a.maxSpending) a.status='depleted';
    if(a.maxUses&&a.useCount>=a.maxUses) a.status='depleted';
    save(); recordAuthHistory(authId,'USED',operation+' '+amount);
  }

  /* ── Modify ── */
  function increaseDailyLimit(id, newLimit){
    var a=authorizations.find(function(x){return x.id===id;});
    if(!a||a.status!=='active') return false;
    a.dailyLimit=newLimit; save();
    recordAuthHistory(id,'MODIFIED','daily limit -> '+newLimit);
    return true;
  }

  function increaseMaxSpending(id, newMax){
    var a=authorizations.find(function(x){return x.id===id;});
    if(!a||a.status!=='active') return false;
    a.maxSpending=newMax; save();
    recordAuthHistory(id,'MODIFIED','max spending -> '+newMax);
    return true;
  }

  function extendExpiry(id, newDurationMs){
    var a=authorizations.find(function(x){return x.id===id;});
    if(!a||a.status!=='active') return false;
    a.expiresAt=Date.now()+newDurationMs; save();
    recordAuthHistory(id,'EXTENDED','duration -> '+newDurationMs+'ms');
    return true;
  }

  function disableOperation(id, operation){
    var a=authorizations.find(function(x){return x.id===id;});
    if(!a||a.status!=='active') return false;
    var map={
      swap:'allowSwap',bridge:'allowBridge',treasury:'allowTreasury',
      payment:'allowPayments',contract:'allowContracts',vault:'allowVault',
      crosschain:'allowCrosschain',recurring:'allowRecurring',scheduled:'allowScheduled',
      multisend:'allowPayments'
    };
    var key=map[operation];
    if(key){ a[key]=false; save(); recordAuthHistory(id,'DISABLED',operation); return true; }
    return false;
  }

  function enableOperationOnly(id, operation){
    var a=authorizations.find(function(x){return x.id===id;});
    if(!a||a.status!=='active') return false;
    var allOps=['swap','bridge','treasury','payment','contract','vault','crosschain','recurring','scheduled','multisend'];
    var map={
      swap:'allowSwap',bridge:'allowBridge',treasury:'allowTreasury',
      payment:'allowPayments',contract:'allowContracts',vault:'allowVault',
      crosschain:'allowCrosschain',recurring:'allowRecurring',scheduled:'allowScheduled',
      multisend:'allowPayments'
    };
    for(var i=0;i<allOps.length;i++){ a[map[allOps[i]]]=false; }
    var key=map[operation];
    if(key){ a[key]=true; save(); recordAuthHistory(id,'RESTRICTED',operation+' only'); return true; }
    return false;
  }

  /* ── Queries ── */
  function getActive(){ invalidateExpired(); var now=Date.now(); return authorizations.filter(function(a){return a.status==='active'&&a.expiresAt>now;}); }
  function getAll(){ return authorizations.slice(); }
  function getAuthSummary(){
    var active=getActive();
    return {
      hasAuthorization:active.length>0,
      count:active.length,
      totalSpendingLimit:active.reduce(function(s,a){return s+(a.maxSpending||0);},0),
      totalDailyLimit:active.reduce(function(s,a){return s+(a.dailyLimit||0);},0),
      allowedOps:active.reduce(function(ops,a){
        ['swap','bridge','treasury','payment','contract','vault','crosschain','recurring','scheduled','multisend'].forEach(function(op){
          if(checkOperationPermission(a,op)) ops.add(op);
        }); return ops;
      },new Set()),
      nextExpiry:active.length>0?Math.min.apply(null,active.map(function(a){return a.expiresAt;})):null,
      agentWallet:active.length>0?active[0].agentWallet:null
    };
  }
  function getAuthHistory(limit){ return authHistory.slice(0,limit||50); }

  /* ── Format helpers ── */
  function fmtTimeLeft(expiresAt){
    var diff=expiresAt-Date.now(); if(diff<=0) return 'Expired';
    var m=Math.floor(diff/60000),s=Math.floor((diff%60000)/1000);
    if(m>=1440) return Math.floor(m/1440)+'d '+Math.floor((m%1440)/60)+'h';
    if(m>=60) return Math.floor(m/60)+'h '+(m%60)+'m';
    if(m>0) return m+'m '+s+'s'; return s+'s';
  }

  function fmtDate(ts){ return new Date(ts).toLocaleString(); }

  function fmtAllowedOps(auth){
    var ops=[];
    if(auth.allowSwap) ops.push('Swap');
    if(auth.allowBridge) ops.push('Bridge');
    if(auth.allowTreasury) ops.push('Treasury');
    if(auth.allowPayments) ops.push('Payments');
    if(auth.allowContracts) ops.push('Contracts');
    if(auth.allowVault) ops.push('Vault');
    if(auth.allowCrosschain) ops.push('Cross-chain');
    if(auth.allowRecurring) ops.push('Recurring');
    if(auth.allowScheduled) ops.push('Scheduled');
    if(auth.allowPayments) ops.push('MultiSend');
    return ops.length>0?ops.join(', '):'None';
  }

  function hasOperationAuth(operation){
    var active=getActive();
    return active.some(function(a){return checkOperationPermission(a,operation);});
  }

  load();

  window.AgentAuthorization = {
    createAuthorization:createAuthorization,
    revokeAuthorization:revokeAuthorization,
    revokeAll:revokeAll,
    validateExecution:validateExecution,
    recordUsage:recordUsage,
    increaseDailyLimit:increaseDailyLimit,
    increaseMaxSpending:increaseMaxSpending,
    extendExpiry:extendExpiry,
    disableOperation:disableOperation,
    enableOperationOnly:enableOperationOnly,
    getActive:getActive,
    getAll:getAll,
    getAuthSummary:getAuthSummary,
    getAuthHistory:getAuthHistory,
    hasOperationAuth:hasOperationAuth,
    fmtTimeLeft:fmtTimeLeft,
    fmtDate:fmtDate,
    fmtAllowedOps:fmtAllowedOps,
    checkOperationPermission:checkOperationPermission
  };
})();
