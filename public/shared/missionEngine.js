/**
 * Autonoma Mission Engine — Autonomous Mission Management
 * Creates, tracks, and executes permanent objectives.
 * Missions remain active until revoked by the user.
 * Attached to window.MissionEngine
 */
(function(){
  'use strict';

  var MISSION_KEY = 'elligentt_missions_v1';
  var CHECK_KEY = 'elligentt_mission_checks_v1';
  var missions = [];
  var checkInterval = null;

  var MISSION_TYPES = {
    keep_treasury:    { label: 'Maintain Treasury Balance', icon: 'vault',       desc: 'Keep minimum balance in Treasury' },
    bridge_idle:      { label: 'Bridge Idle Funds',        icon: 'topology-star-3', desc: 'Bridge idle liquidity to target chain' },
    pay_suppliers:    { label: 'Pay Suppliers',            icon: 'cash',         desc: 'Execute recurring supplier payments' },
    reimburse_failed: { label: 'Reimburse Failed Transfers', icon: 'refresh',     desc: 'Auto-reimburse failed cross-chain transfers' },
    swap_rewards:     { label: 'Swap Rewards to USDC',     icon: 'arrows-exchange', desc: 'Convert staking/LP rewards to USDC' },
    liquidity_ratio:  { label: 'Maintain Liquidity Ratio',  icon: 'droplet',      desc: 'Keep liquidity ratio at target %' },
    deposit_excess:   { label: 'Deposit Excess to Treasury', icon: 'building-bank', desc: 'Move idle funds into Treasury' },
    custom:           { label: 'Custom Mission',            icon: 'target',       desc: 'User-defined mission' }
  };

  function load(){
    try { var r=localStorage.getItem(MISSION_KEY); if(r) missions=JSON.parse(r); } catch(e){ missions=[]; }
  }

  function save(){
    try { localStorage.setItem(MISSION_KEY, JSON.stringify(missions)); } catch(e){}
  }

  function createMission(opts){
    var id='mission_'+Date.now()+'_'+Math.random().toString(36).substr(2,6);
    var type=opts.type||'custom';
    var typeInfo=MISSION_TYPES[type]||MISSION_TYPES.custom;

    var mission={
      id:id,
      name:opts.name||typeInfo.label,
      type:type,
      description:opts.description||typeInfo.desc,
      status:'active',
      priority:opts.priority||'medium',
      // Budget
      budget:opts.budget||0,
      budgetToken:opts.budgetToken||'USDC',
      budgetPeriod:opts.budgetPeriod||'weekly', // once|daily|weekly|monthly
      usedBudget:0,
      budgetReset:Date.now(),
      // Parameters
      params:opts.params||{},
      // Scheduling
      schedule:opts.schedule||null, // {recurrence,dayOfWeek,dayOfMonth,time}
      nextExecution:opts.schedule?calcNextExecution(opts.schedule):null,
      lastExecuted:null,
      executionCount:0,
      maxExecutions:opts.maxExecutions||null,
      // Chain
      chain:opts.chain||'Arc Testnet',
      // Meta
      createdAt:Date.now(),
      agentWallet:typeof AgentWalletManager!=='undefined'?AgentWalletManager.getAgentAddress():null
    };

    missions.unshift(mission); save();
    return mission;
  }

  function calcNextExecution(schedule){
    var now=new Date();
    switch(schedule.recurrence){
      case 'daily':   now.setUTCDate(now.getUTCDate()+1); now.setUTCHours(schedule.hour||0,schedule.minute||0,0,0); return now.getTime();
      case 'weekly':  var d=(schedule.dayOfWeek||1)+7-now.getUTCDay(); if(d<=0) d+=7; now.setUTCDate(now.getUTCDate()+d); now.setUTCHours(schedule.hour||9,schedule.minute||0,0,0); return now.getTime();
      case 'monthly': now.setUTCMonth(now.getUTCMonth()+1,1); now.setUTCDate(Math.min(schedule.dayOfMonth||1,28)); now.setUTCHours(schedule.hour||9,0,0,0); return now.getTime();
      case 'once':    return null;
      default:        return Date.now()+86400000;
    }
  }

  function updateMission(id, updates){
    var m=missions.find(function(x){return x.id===id;});
    if(!m) return null;
    var keys=Object.keys(updates);
    for(var i=0;i<keys.length;i++){ m[keys[i]]=updates[keys[i]]; }
    save(); return m;
  }

  function cancelMission(id){
    var m=missions.find(function(x){return x.id===id;});
    if(!m) return false;
    m.status='cancelled'; m.cancelledAt=Date.now();
    save(); return true;
  }

  function pauseMission(id){
    var m=missions.find(function(x){return x.id===id;});
    if(!m) return false;
    m.status='paused'; m.pausedAt=Date.now();
    save(); return true;
  }

  function resumeMission(id){
    var m=missions.find(function(x){return x.id===id;});
    if(!m) return false;
    m.status='active'; m.pausedAt=null;
    save(); return true;
  }

  function pauseAll(){
    missions.forEach(function(m){ if(m.status==='active'){ m.status='paused'; m.pausedAt=Date.now(); } });
    save();
  }

  function resumeAll(){
    missions.forEach(function(m){ if(m.status==='paused'){ m.status='active'; m.resumedAt=Date.now(); } });
    save();
  }

  function getActive(){ return missions.filter(function(m){return m.status==='active';}); }
  function getPaused(){ return missions.filter(function(m){return m.status==='paused';}); }
  function getAll(){ return missions.slice(); }
  function getByType(type){ return missions.filter(function(m){return m.type===type;}); }

  function getDue(){
    var now=Date.now();
    return missions.filter(function(m){
      return m.status==='active'&&m.nextExecution&&m.nextExecution<=now&&(!m.maxExecutions||m.executionCount<m.maxExecutions);
    });
  }

  function recordExecution(id, result){
    var m=missions.find(function(x){return x.id===id;});
    if(!m) return;
    m.lastExecuted=Date.now();
    m.executionCount=(m.executionCount||0)+1;
    if(m.schedule) m.nextExecution=calcNextExecution(m.schedule);
    if(m.maxExecutions&&m.executionCount>=m.maxExecutions) m.status='completed';

    // Reset budget period
    var now=Date.now();
    var resetMs={daily:86400000,weekly:604800000,monthly:2592000000}[m.budgetPeriod]||604800000;
    if(now-m.budgetReset>resetMs){ m.usedBudget=0; m.budgetReset=now; }

    save();
    return m;
  }

  function recordSpending(id, amount){
    var m=missions.find(function(x){return x.id===id;});
    if(!m) return false;
    m.usedBudget=(m.usedBudget||0)+amount;

    // Check if budget needs replenishment
    if(m.budget>0&&m.usedBudget>=m.budget*0.9){
      // Budget nearly depleted — trigger alert
      if(typeof AutonomaAgent!=='undefined'&&typeof AutonomaAgent.checkAlerts==='function'){
        // Will be picked up by alert system
      }
    }

    save();
    return m.budget===0||m.usedBudget<m.budget;
  }

  function getStats(){
    var all=missions;
    var active=getActive();
    var completed=missions.filter(function(m){return m.status==='completed';});
    var failed=missions.filter(function(m){return m.status==='failed';});

    return {
      total:all.length, active:active.length, completed:completed.length, failed:failed.length,
      totalBudget:active.reduce(function(s,m){return s+(m.budget||0);},0),
      totalUsed:active.reduce(function(s,m){return s+(m.usedBudget||0);},0),
      totalExecutions:active.reduce(function(s,m){return s+(m.executionCount||0);},0),
      todayExecutions:active.filter(function(m){return m.lastExecuted&&m.lastExecuted>Date.now()-86400000;}).length
    };
  }

  function fmtStatus(status){
    var map={active:'Active',paused:'Paused',completed:'Completed',cancelled:'Cancelled',failed:'Failed'};
    return map[status]||status;
  }

  function fmtRecurrence(sched){
    if(!sched) return 'Once';
    var map={daily:'Daily',weekly:'Weekly',monthly:'Monthly',once:'Once'};
    var days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    var r=map[sched.recurrence]||sched.recurrence;
    if(sched.recurrence==='weekly'&&sched.dayOfWeek!==undefined) r+=' on '+days[sched.dayOfWeek];
    if(sched.recurrence==='monthly'&&sched.dayOfMonth) r+=' day '+sched.dayOfMonth;
    return r;
  }

  function fmtBudgetPeriod(period){
    var map={once:'One-time',daily:'Daily',weekly:'Weekly',monthly:'Monthly'};
    return map[period]||period;
  }

  function fmtDate(ts){ return ts?new Date(ts).toLocaleString():'Never'; }

  function getMissionHTML(mission, R){
    if(!R) R={row:function(l,v,c){return '<div class="aut-rc-row"><span class="aut-rl">'+l+'</span><span class="aut-rv">'+v+'</span></div>';},head:function(i,t,b){return '<div class="aut-rc-head"><i class="ti ti-'+i+'"></i><span class="aut-rc-title">'+t+'</span>'+(b?'<span class="aut-rc-badge '+b.cls+'">'+b.text+'</span>':'')+'</div>';},sep:function(){return '<div class="aut-rc-sep"></div>';}};
    var typeInfo=MISSION_TYPES[mission.type]||MISSION_TYPES.custom;
    var statusCls=mission.status==='active'?'live':mission.status==='paused'?'pending':'muted';
    return '<div class="aut-rc" style="border-color:rgba(167,139,250,.15);margin-top:6px">'+
      R.head(typeInfo.icon,mission.name,{text:mission.status.toUpperCase(),cls:statusCls})+
      '<div class="aut-rc-body">'+
      R.row('Type',typeInfo.label,'purple')+
      (mission.budget>0?R.row('Budget',mission.budget+' '+mission.budgetToken+'/'+fmtBudgetPeriod(mission.budgetPeriod),'green'):'')+
      (mission.usedBudget>0?R.row('Used','$'+mission.usedBudget.toFixed(2),'yellow'):'')+
      (mission.schedule?R.row('Schedule',fmtRecurrence(mission.schedule),'teal'):'')+
      R.row('Chain',mission.chain,'muted')+
      R.row('Executions',String(mission.executionCount||0),'muted')+
      R.row('Last Run',fmtDate(mission.lastExecuted),'muted')+
      (mission.nextExecution?R.row('Next Run',fmtDate(mission.nextExecution),'teal'):'')+
      '</div></div>';
  }

  function startScheduler(){
    if(checkInterval) return;
    checkInterval=setInterval(function(){
      var due=getDue();
      if(due.length>0&&typeof AutonomaAgent!=='undefined'&&typeof AutonomaAgent.injectAlerts==='function'){
        var alerts=due.map(function(m){
          return {type:'mission_due',priority:m.priority||'medium',text:'Mission due: "'+m.name+'"',action:'execute mission '+m.id};
        });
        AutonomaAgent.injectAlerts(alerts);
      }
    }, 60000);
  }

  load();
  startScheduler();

  window.MissionEngine = {
    createMission:createMission,
    updateMission:updateMission,
    cancelMission:cancelMission,
    pauseMission:pauseMission,
    resumeMission:resumeMission,
    pauseAll:pauseAll,
    resumeAll:resumeAll,
    getActive:getActive,
    getPaused:getPaused,
    getAll:getAll,
    getByType:getByType,
    getDue:getDue,
    recordExecution:recordExecution,
    recordSpending:recordSpending,
    getStats:getStats,
    getMissionHTML:getMissionHTML,
    fmtStatus:fmtStatus,
    fmtRecurrence:fmtRecurrence,
    fmtBudgetPeriod:fmtBudgetPeriod,
    MISSION_TYPES:MISSION_TYPES
  };
})();
