/**
 * Autonoma Agent Treasury — Autonomous Treasury Management
 * Holds delegated assets, manages budgets, allocations, spending limits.
 * The operational treasury of Autonoma - funded only by explicit user allocations.
 * Attached to window.AgentTreasury
 */
(function(){
  'use strict';

  var TRES_KEY = 'elligentt_agent_treasury_v1';
  var BUDGET_KEY = 'elligentt_agent_budgets_v1';
  var treasury = null;
  var budgets = [];

  function defaultTreasury(){
    return {
      agentWallet: typeof AgentWalletManager!=='undefined'?AgentWalletManager.getAgentAddress():null,
      totalAllocated: 0,
      totalSpent: 0,
      totalYield: 0,
      availableBalance: 0,
      lockedBalance: 0,
      allocatedBalance: 0,
      reservedBalance: 0,
      pendingBalance: 0,
      missionBalance: 0,
      crossChainBalance: 0,
      dailySpent: 0,
      dailyReset: Date.now(),
      weeklySpent: 0,
      weeklyReset: Date.now(),
      monthlySpent: 0,
      monthlyReset: Date.now(),
      lastUpdated: Date.now(),
      status: 'active',
      pausedAt: null,
      totalOperations: 0,
      successfulOps: 0,
      failedOps: 0,
      // Limits
      maxDailySpend: 0,
      maxWeeklySpend: 0,
      maxMonthlySpend: 0,
      maxPerOp: 0,
      // Metadata
      supportedAssets: ['USDC','EURC','cirBTC'],
      supportedChains: ['Arc Testnet','Base','Ethereum','Arbitrum','Polygon'],
      preferences: {}
    };
  }

  function load(){
    try { var r=localStorage.getItem(TRES_KEY); if(r) treasury=JSON.parse(r); } catch(e){ treasury=null; }
    if(!treasury) treasury=defaultTreasury();
    try { var rb=localStorage.getItem(BUDGET_KEY); if(rb) budgets=JSON.parse(rb); } catch(e){ budgets=[]; }
  }

  function save(){
    treasury.lastUpdated=Date.now();
    try { localStorage.setItem(TRES_KEY, JSON.stringify(treasury)); } catch(e){}
  }

  function saveBudgets(){
    try { localStorage.setItem(BUDGET_KEY, JSON.stringify(budgets)); } catch(e){}
  }

  function resetPeriods(){
    var now=Date.now();
    if(now-treasury.dailyReset>86400000){ treasury.dailySpent=0; treasury.dailyReset=now; }
    if(now-treasury.weeklyReset>604800000){ treasury.weeklySpent=0; treasury.weeklyReset=now; }
    if(now-treasury.monthlyReset>2592000000){ treasury.monthlySpent=0; treasury.monthlyReset=now; }
    save();
  }

  /* ── Treasury Allocation ── */
  function allocate(amount, token, purpose, durationMs){
    resetPeriods();
    var id='alloc_'+Date.now()+'_'+Math.random().toString(36).substr(2,4);
    var alloc={
      id:id, amount:amount, token:token||'USDC',
      purpose:purpose||'General Treasury',
      status:'active', allocatedAt:Date.now(),
      expiresAt:durationMs?Date.now()+durationMs:null,
      spent:0
    };
    if(!treasury.allocations) treasury.allocations=[];
    treasury.allocations.unshift(alloc);
    treasury.totalAllocated=(treasury.totalAllocated||0)+amount;
    treasury.allocatedBalance=(treasury.allocatedBalance||0)+amount;
    save();
    return alloc;
  }

  function withdraw(id, amount){
    var alloc=treasury.allocations?treasury.allocations.find(function(a){return a.id===id;}):null;
    if(!alloc) return false;
    var withdrawAmt=amount||(alloc.amount-alloc.spent);
    if(withdrawAmt>alloc.amount-alloc.spent) withdrawAmt=alloc.amount-alloc.spent;
    alloc.spent+=withdrawAmt;
    if(alloc.spent>=alloc.amount) alloc.status='depleted';
    treasury.totalAllocated=Math.max(0,(treasury.totalAllocated||0)-withdrawAmt);
    treasury.availableBalance=Math.max(0,(treasury.availableBalance||0)-withdrawAmt);
    save();
    return {id:id,withdrawn:withdrawAmt,token:alloc.token};
  }

  function withdrawAll(){
    if(!treasury.allocations) return 0;
    var total=0;
    treasury.allocations.forEach(function(a){
      if(a.status==='active'){
        var w=a.amount-a.spent;
        a.spent=a.amount; a.status='depleted'; total+=w;
      }
    });
    treasury.totalAllocated=0; treasury.availableBalance=0;
    save(); return total;
  }

  function getActiveAllocations(){
    return (treasury.allocations||[]).filter(function(a){return a.status==='active';});
  }

  function getAllocatedTotal(){
    return (treasury.allocations||[]).filter(function(a){return a.status==='active';}).reduce(function(s,a){return s+(a.amount-a.spent);},0);
  }

  /* ── Budgets ── */
  function createBudget(opts){
    var id='budget_'+Date.now()+'_'+Math.random().toString(36).substr(2,4);
    var budget={
      id:id, name:opts.name||'Budget', type:opts.type||'general',
      amount:opts.amount||0, token:opts.token||'USDC',
      period:opts.period||'monthly', spent:0,
      status:'active', createdAt:Date.now(),
      purpose:opts.purpose||'', missionId:opts.missionId||null
    };
    budgets.unshift(budget); saveBudgets();
    return budget;
  }

  function spendFromBudget(budgetId, amount){
    var b=budgets.find(function(x){return x.id===budgetId;});
    if(!b||b.status!=='active') return false;
    if(b.amount>0&&b.spent+amount>b.amount) return false;
    b.spent+=amount;
    if(b.amount>0&&b.spent>=b.amount) b.status='depleted';
    saveBudgets();
    return true;
  }

  function getBudgets(){ return budgets.filter(function(b){return b.status==='active';}); }
  function getBudgetStats(){
    var active=getBudgets();
    return {
      count:active.length,
      totalAllocated:active.reduce(function(s,b){return s+(b.amount||0);},0),
      totalSpent:active.reduce(function(s,b){return s+(b.spent||0);},0),
      utilization:active.length>0?Math.round(active.reduce(function(s,b){return s+(b.spent||0)/(b.amount||1);},0)/active.length*100):0
    };
  }

  /* ── Spending Validation ── */
  function canSpend(amount, operation, chain, token){
    resetPeriods();
    var checks=[];
    var allowed=true;

    if(treasury.status!=='active'){ checks.push({rule:'Treasury Status',passed:false,reason:'Treasury is paused'}); allowed=false; }

    if(treasury.maxDailySpend>0&&treasury.dailySpent+amount>treasury.maxDailySpend){
      checks.push({rule:'Daily Limit',passed:false,reason:'Exceeds daily limit of '+treasury.maxDailySpend});
      allowed=false;
    }
    if(treasury.maxWeeklySpend>0&&treasury.weeklySpent+amount>treasury.maxWeeklySpend){
      checks.push({rule:'Weekly Limit',passed:false,reason:'Exceeds weekly limit'});
      allowed=false;
    }
    if(treasury.maxMonthlySpend>0&&treasury.monthlySpent+amount>treasury.maxMonthlySpend){
      checks.push({rule:'Monthly Limit',passed:false,reason:'Exceeds monthly limit'});
      allowed=false;
    }
    if(treasury.maxPerOp>0&&amount>treasury.maxPerOp){
      checks.push({rule:'Per-operation Limit',passed:false,reason:'Exceeds per-operation limit of '+treasury.maxPerOp});
      allowed=false;
    }

    if(allowed) checks.push({rule:'All Treasury Policies',passed:true,reason:'Within limits'});

    return {allowed:allowed,checks:checks};
  }

  function recordSpending(amount, operation, chain, txHash){
    resetPeriods();
    treasury.totalSpent=(treasury.totalSpent||0)+amount;
    treasury.dailySpent=(treasury.dailySpent||0)+amount;
    treasury.weeklySpent=(treasury.weeklySpent||0)+amount;
    treasury.monthlySpent=(treasury.monthlySpent||0)+amount;
    treasury.totalOperations=(treasury.totalOperations||0)+1;

    if(!treasury.history) treasury.history=[];
    treasury.history.unshift({
      amount:amount, operation:operation, chain:chain||'Arc Testnet',
      txHash:txHash||'', timestamp:Date.now()
    });
    if(treasury.history.length>200) treasury.history.length=200;

    save();
  }

  function recordSuccess(){ treasury.successfulOps=(treasury.successfulOps||0)+1; save(); }
  function recordFailure(){ treasury.failedOps=(treasury.failedOps||0)+1; save(); }

  /* ── Treasury Commands ── */
  function pause(){
    treasury.status='paused'; treasury.pausedAt=Date.now();
    save();
    if(typeof AgentWalletManager!=='undefined') AgentWalletManager.pause();
    if(typeof AgentSession!=='undefined') AgentSession.pause();
  }

  function resume(){
    treasury.status='active'; treasury.pausedAt=null;
    save();
    if(typeof AgentWalletManager!=='undefined') AgentWalletManager.resume();
    if(typeof AgentSession!=='undefined') AgentSession.resume();
  }

  function setLimit(type, value){
    var map={daily:'maxDailySpend',weekly:'maxWeeklySpend',monthly:'maxMonthlySpend',perOp:'maxPerOp'};
    var key=map[type]; if(!key) return false;
    treasury[key]=value; save(); return true;
  }

  /* ── Stats ── */
  function getStats(){
    resetPeriods();
    return {
      totalAllocated:treasury.totalAllocated||0,
      totalSpent:treasury.totalSpent||0,
      availableBalance:treasury.availableBalance||0,
      lockedBalance:treasury.lockedBalance||0,
      dailySpent:treasury.dailySpent||0,
      weeklySpent:treasury.weeklySpent||0,
      monthlySpent:treasury.monthlySpent||0,
      totalOperations:treasury.totalOperations||0,
      successfulOps:treasury.successfulOps||0,
      failedOps:treasury.failedOps||0,
      successRate:treasury.totalOperations>0?Math.round(treasury.successfulOps/treasury.totalOperations*100):100,
      activeAllocations:getActiveAllocations().length,
      activeBudgets:getBudgets().length,
      budgetUtilization:getBudgetStats().utilization,
      limits:{
        daily:treasury.maxDailySpend||0,
        weekly:treasury.maxWeeklySpend||0,
        monthly:treasury.maxMonthlySpend||0,
        perOp:treasury.maxPerOp||0
      },
      status:treasury.status,
      history:(treasury.history||[]).slice(0,20)
    };
  }

  function getFullState(){
    return JSON.parse(JSON.stringify(treasury));
  }

  /* ── HTML Cards ── */
  function getTreasuryHTML(stats, R){
    if(!R) R={row:function(l,v,c){return '<div class="aut-rc-row"><span class="aut-rl">'+l+'</span><span class="aut-rv">'+v+'</span></div>';},head:function(i,t,b){return '<div class="aut-rc-head"><i class="ti ti-'+i+'"></i><span class="aut-rc-title">'+t+'</span>'+(b?'<span class="aut-rc-badge '+b.cls+'">'+b.text+'</span>':'')+'</div>';},sep:function(){return '<div class="aut-rc-sep"></div>';}};
    var s=stats||getStats();

    return '<div class="aut-rc" style="border-color:rgba(22,197,94,.25);margin-top:8px">'+
      R.head('building-bank','Agent Treasury',{text:s.status==='active'?'Active':'Paused',cls:s.status==='active'?'live':'pending'})+
      '<div class="aut-rc-body">'+
      R.row('Allocated','$'+(s.totalAllocated||0).toFixed(2),'green')+
      R.row('Spent','$'+(s.totalSpent||0).toFixed(2),s.totalSpent>0?'yellow':'muted')+
      R.row('Available','$'+(s.availableBalance||0).toFixed(2),'purple')+
      R.sep()+
      R.row('Operations',String(s.totalOperations||0),'muted')+
      R.row('Success Rate',String(s.successRate||100)+'%','green')+
      R.sep()+
      R.row('Today','$'+(s.dailySpent||0).toFixed(2),'muted')+
      R.row('Week','$'+(s.weeklySpent||0).toFixed(2),'muted')+
      R.row('Month','$'+(s.monthlySpent||0).toFixed(2),'muted')+
      R.sep()+
      R.row('Allocations',String(s.activeAllocations||0)+' active','teal')+
      R.row('Budgets',String(s.activeBudgets||0)+' active','teal')+
      (s.limits&&s.limits.daily>0?R.row('Daily Limit','$'+s.limits.daily,'yellow'):'')+
      '</div></div>';
  }

  load();

  window.AgentTreasury = {
    allocate:allocate,
    withdraw:withdraw,
    withdrawAll:withdrawAll,
    getActiveAllocations:getActiveAllocations,
    getAllocatedTotal:getAllocatedTotal,
    createBudget:createBudget,
    spendFromBudget:spendFromBudget,
    getBudgets:getBudgets,
    getBudgetStats:getBudgetStats,
    canSpend:canSpend,
    recordSpending:recordSpending,
    recordSuccess:recordSuccess,
    recordFailure:recordFailure,
    pause:pause,
    resume:resume,
    setLimit:setLimit,
    getStats:getStats,
    getFullState:getFullState,
    getTreasuryHTML:getTreasuryHTML
  };
})();
