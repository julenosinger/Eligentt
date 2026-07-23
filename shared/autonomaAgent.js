/**
 * Autonoma Agent — Workflow Orchestrator, Tx Monitor, Proactive Alerts, Portfolio Manager
 * Phases 4-6: Multi-step workflows, post-execution verification, notifications, portfolio
 * Attached to window.AutonomaAgent
 */
(function(){
  'use strict';

  var WORKFLOW_KEY = 'elligentt_workflows_v1';
  var ALERTS_KEY = 'elligentt_alerts_v1';
  var activeWorkflows = [];
  var shownAlerts = {};
  var monitorInterval = null;
  var lastBalanceCheck = 0;

  function load(){ try{ var r=localStorage.getItem(WORKFLOW_KEY); if(r) activeWorkflows=JSON.parse(r); } catch(e){ activeWorkflows=[]; } try{ var a=localStorage.getItem(ALERTS_KEY); if(a) shownAlerts=JSON.parse(a); } catch(e){ shownAlerts={}; } }
  function save(){ try{ localStorage.setItem(WORKFLOW_KEY, JSON.stringify(activeWorkflows)); } catch(e){} }
  function saveAlerts(){ try{ localStorage.setItem(ALERTS_KEY, JSON.stringify(shownAlerts)); } catch(e){} }
  function wasShown(id, cooldownMs){ var last=shownAlerts[id]; return last && (Date.now()-last)<(cooldownMs||3600000); }
  function markShown(id){ shownAlerts[id]=Date.now(); saveAlerts(); }

  /* ════════════════════════════════════════
     WORKFLOW ENGINE — Multi-step orchestration
  ════════════════════════════════════════ */
  function createWorkflow(opts){
    var id = 'wf_' + Date.now() + '_' + Math.random().toString(36).substr(2,4);
    var wf = {
      id: id, name: opts.name || 'Workflow', goal: opts.goal || '',
      steps: buildSteps(opts), currentStep: 0, status: 'pending',
      results: [], createdAt: Date.now(), completedAt: null,
      totalSteps: 0, failedStep: null, error: null
    };
    wf.totalSteps = wf.steps.length;
    activeWorkflows.unshift(wf);
    if(activeWorkflows.length > 20) activeWorkflows.length = 20;
    save();
    return wf;
  }

  function buildSteps(opts){
    var steps = [];
    steps.push({ id: 'check_wallet', label: 'Validate wallet', icon: 'wallet', status: 'pending' });
    steps.push({ id: 'check_balance', label: 'Check balances', icon: 'chart-bar', status: 'pending' });

    if(opts.needsSwap){
      steps.push({ id: 'execute_swap', label: 'Swap ' + (opts.swapAmount||'') + ' ' + (opts.fromToken||'') + ' → ' + (opts.toToken||''), icon: 'arrows-exchange', status: 'pending' });
    }
    if(opts.needsBridge){
      steps.push({ id: 'execute_bridge', label: 'Bridge to ' + (opts.toChain||'destination'), icon: 'topology-star-3', status: 'pending' });
    }
    steps.push({ id: 'execute_payment', label: 'Send ' + (opts.amount||'') + ' ' + (opts.asset||'USDC'), icon: 'send', status: 'pending' });
    steps.push({ id: 'verify_receipt', label: 'Verify transaction', icon: 'receipt', status: 'pending' });
    steps.push({ id: 'update_history', label: 'Update history', icon: 'history', status: 'pending' });
    return steps;
  }

  function updateStep(wfId, stepIdx, status, data){
    var wf = activeWorkflows.find(function(w){ return w.id === wfId; });
    if(!wf) return;
    if(wf.steps[stepIdx]){ wf.steps[stepIdx].status = status; wf.steps[stepIdx].data = data; }
    if(status === 'completed' && stepIdx >= wf.steps.length - 1){
      wf.status = 'completed'; wf.completedAt = Date.now();
    }
    if(status === 'failed'){ wf.status = 'failed'; wf.failedStep = stepIdx; wf.error = data; }
    wf.currentStep = stepIdx;
    save();
  }

  function getActiveWorkflows(){ return activeWorkflows.filter(function(w){ return w.status === 'pending' || w.status === 'running'; }); }

  function getWorkflowHtml(wf, R){
    if(!R) R = { row: function(l,v,c){ return '<div class="aut-rc-row"><span class="aut-rl">'+l+'</span><span class="aut-rv" style="color:var(--'+(c||'text')+')">'+v+'</span></div>'; }, head: function(i,t,b){ return '<div class="aut-rc-head"><i class="ti ti-'+i+'"></i><span class="aut-rc-title">'+t+'</span>'+(b?'<span class="aut-rc-badge '+b.cls+'">'+b.text+'</span>':'')+'</div>'; }, sep: function(){ return '<div class="aut-rc-sep"></div>'; }, section: function(t){ return '<div class="aut-rc-section">'+t+'</div>'; } };
    var stepsHtml = wf.steps.map(function(s, i){
      var color = s.status === 'completed' ? '#22c55e' : s.status === 'failed' ? '#ef4444' : s.status === 'running' ? '#06F7E9' : 'var(--muted)';
      var icon = s.status === 'completed' ? 'check' : s.status === 'failed' ? 'x' : s.status === 'running' ? 'loader' : 'circle';
      return '<div class="aut-progress-step '+(s.status==='completed'?'done':s.status==='running'?'active':'')+'"><span class="step-icon"><i class="ti ti-'+icon+'" style="color:'+color+'"></i></span><span>'+s.label+'</span></div>';
    }).join('');

    var progress = wf.totalSteps > 0 ? Math.round((wf.steps.filter(function(s){ return s.status === 'completed'; }).length / wf.totalSteps) * 100) : 0;

    return '<div class="aut-rc" style="border-color:rgba(167,139,250,.2);margin-top:8px">' +
      R.head('workflow', wf.name, wf.status === 'completed' ? {text:'Done',cls:'live'} : wf.status === 'failed' ? {text:'Failed',cls:'pending'} : {text:'In progress',cls:'live'}) +
      '<div class="aut-rc-body">' +
      R.row('Goal', wf.goal, 'purple') + R.sep() +
      '<div class="aut-progress"><div class="aut-progress-steps">'+stepsHtml+'</div></div>' +
      (progress > 0 ? '<div style="margin-top:4px"><div class="aut-progress-bar"><div class="fill" style="width:'+progress+'%"></div></div><div style="font-size:8px;color:var(--muted2);text-align:right">'+progress+'%</div></div>' : '') +
      '</div></div>';
  }

  /* ════════════════════════════════════════
     TX MONITOR — Post-execution verification
     [A4 FIX] Uses RPCManager with fallback instead of hardcoded RPC
     [M5 FIX] Retry logic with exponential backoff
  ════════════════════════════════════════ */
  var monitoredTxs = [];

  function _getAgentProvider(){
    try {
      if(typeof ethers === 'undefined') return null;
      if(typeof RPCManager !== 'undefined' && typeof RPCManager.getHealthyRPC === 'function'){
        var rpc = RPCManager.getHealthyRPC(5042002);
        if(rpc) return new ethers.JsonRpcProvider(rpc);
      }
    } catch(e){}
    try {
      if(typeof getCachedProvider === 'function') return getCachedProvider('https://rpc.testnet.arc.network');
    } catch(e){}
    return new ethers.JsonRpcProvider('https://rpc.testnet.arc.network');
  }

  function monitorTx(txHash, chainId, callback){
    var id = 'mtx_' + Date.now();
    monitoredTxs.push({ id: id, txHash: txHash, chainId: chainId, callback: callback, startTime: Date.now(), confirmed: false });
    if(monitoredTxs.length > 10) monitoredTxs.shift();
    return id;
  }

  async function pollTx(txHash){
    // [A4+M5 FIX] Use RPCManager with retry + fallback
    var retries = 3;
    for(var attempt = 0; attempt < retries; attempt++){
      try {
        if(typeof ethers === 'undefined') return null;
        var provider = _getAgentProvider();
        if(!provider) return null;
        var receipt = await provider.getTransactionReceipt(txHash);
        if(receipt) return receipt;
      } catch(e){
        if(attempt < retries - 1){
          await new Promise(function(r){ setTimeout(r, 1000 * (attempt + 1)); });
        }
      }
    }
    return null;
  }

  function stopMonitor(id){
    monitoredTxs = monitoredTxs.filter(function(t){ return t.id !== id; });
  }

  /* ════════════════════════════════════════
     PROACTIVE ALERTS — Periodic checks
  ════════════════════════════════════════ */
  function checkAlerts(){
    var alerts = [];

    // 1. Permit expiring soon
    try {
      if(typeof PermitEngine !== 'undefined'){
        var active = PermitEngine.getActive();
        for(var i = 0; i < active.length; i++){
          var p = active[i];
          var remaining = p.expiresAt - Date.now();
          if(remaining < 600000 && remaining > 0 && !wasShown('expire_' + p.id, 300000)){
            alerts.push({ type: 'permit_expiring', priority: 'high', text: 'Permit "' + p.purpose + '" expires in ' + PermitEngine.fmtTimeLeft(p.expiresAt), action: 'show permissions' });
          }
        }
      }
    } catch(e){}

    // 2. Scheduled permits due
    try {
      if(typeof PermitEngine !== 'undefined'){
        var due = PermitEngine.getScheduledDue();
        for(var d = 0; d < due.length; d++){
          if(!wasShown('due_' + due[d].id, 3600000)){
            alerts.push({ type: 'schedule_due', priority: 'medium', text: 'Scheduled: "' + due[d].name + '" is due now', action: 'execute schedules' });
          }
        }
      }
    } catch(e){}

    // 3. [M11 FIX] Low balance — use on-chain check when available, fallback to DOM
    try {
      var balFloat = null;
      // Prefer AgentWalletManager on-chain balance if available
      try {
        if(typeof AgentWalletManager !== 'undefined' && typeof walletAddress !== 'undefined' && walletAddress){
          var agentAddr = AgentWalletManager.getAgentAddress();
          if(agentAddr && typeof ethers !== 'undefined'){
            var provider = _getAgentProvider();
            if(provider){
              var USDC = '0x3600000000000000000000000000000000000000';
              var c = new ethers.Contract(USDC, ['function balanceOf(address) view returns (uint256)'], provider);
              try { var rawBal = await c.balanceOf(agentAddr); balFloat = parseFloat(ethers.formatUnits(rawBal, 6)); } catch(e){}
            }
          }
        }
      } catch(e){}
      // Fallback to DOM element
      if(balFloat === null){
        var balEl = document.getElementById('sb-bal');
        var balance = balEl ? parseFloat(balEl.textContent) : null;
        if(balance !== null && !isNaN(balance)) balFloat = balance;
      }
      if(balFloat !== null && !isNaN(balFloat) && balFloat < 10 && balFloat > 0 && !wasShown('low_bal', 1800000)){
        alerts.push({ type: 'low_balance', priority: 'medium', text: 'Balance is low: ' + balFloat.toFixed(2) + ' USDC. Consider topping up.', action: 'show my balance' });
      }
    } catch(e){}

    // 4. Idle funds detection (portfolio)
    try {
      var balEl2 = document.getElementById('sb-bal');
      var bal = balEl2 ? parseFloat(balEl2.textContent) : null;
      if(bal !== null && !isNaN(bal) && bal > 50 && !wasShown('idle_funds', 7200000)){
        alerts.push({ type: 'idle_funds', priority: 'low', text: 'You have ' + bal.toFixed(2) + ' USDC idle. Consider depositing into Treasury for yield.', action: 'open treasury' });
      }
    } catch(e){}

    return alerts;
  }

  function getAlertHtml(alert){
    var priorityColor = alert.priority === 'high' ? '#ef4444' : alert.priority === 'medium' ? '#f59e0b' : '#4f8ef7';
    var icon = alert.type === 'permit_expiring' ? 'clock' : alert.type === 'schedule_due' ? 'calendar-event' : alert.type === 'low_balance' ? 'wallet' : 'coins';
    // [M7 FIX] Use textContent-safe approach — avoid inline onclick with unsanitized values
    var safeAction = String(alert.action || '').replace(/[\\']/g, '');
    return '<div class="ai-rec-item" style="display:flex;align-items:center;gap:8px">' +
      '<i class="ti ti-' + icon + '" style="color:' + priorityColor + ';font-size:14px;flex-shrink:0"></i>' +
      '<div style="flex:1"><div style="font-size:9px;color:var(--text)">' +
      alert.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;') +
      '</div></div>' +
      '<button class="aut-act" data-alert-action="' + safeAction + '" style="font-size:8px;padding:2px 8px"><i class="ti ti-arrow-right"></i></button>' +
      '</div>';
  }

  function injectAlerts(alerts){
    if(!alerts || alerts.length === 0) return;
    var c = document.getElementById('aut-messages'); if(!c) return;
    var existing = c.querySelector('.aut-alerts-banner');
    if(existing) existing.remove();
    var html = '<div class="aut-alerts-banner" style="margin-bottom:12px">' +
      alerts.map(function(a){ return getAlertHtml(a); }).join('') +
      '</div>';
    var first = c.querySelector('.aut-msg');
    if(first){ first.insertAdjacentHTML('beforebegin', html); }
    alerts.forEach(function(a){ markShown(a.type === 'permit_expiring' ? 'expire' : a.type === 'schedule_due' ? 'due_' + Date.now() : a.type); });
  }

  /* ════════════════════════════════════════
     INIT — Start periodic checks
     [M6 FIX] Cleanup support for page navigation
  ════════════════════════════════════════ */
  function start(){
    if(monitorInterval) return;
    monitorInterval = setInterval(function(){
      try {
        // Only run if autonoma page is visible to avoid unnecessary RPC calls
        var page = document.getElementById('page-autonoma');
        if(page && !page.classList.contains('active')) return;
        var alerts = checkAlerts();
        if(alerts.length > 0) injectAlerts(alerts);
      } catch(e){}
    }, 45000); // Check every 45 seconds
  }

  /** [M6 FIX] Stop all intervals and cleanup resources */
  function stop(){
    if(monitorInterval){ clearInterval(monitorInterval); monitorInterval = null; }
  }

  load();
  start();

  /* ════════════════════════════════════════
     AGENT WALLET & IDENTITY INTEGRATION
  ════════════════════════════════════════ */
  function getAgentIdentityCard(R){
    if(!R) R={row:function(l,v,c){return '<div class="aut-rc-row"><span class="aut-rl">'+l+'</span><span class="aut-rv" style="color:var(--'+(c||'text')+')">'+v+'</span></div>';},head:function(i,t,b){return '<div class="aut-rc-head"><i class="ti ti-'+i+'"></i><span class="aut-rc-title">'+t+'</span>'+(b?'<span class="aut-rc-badge '+b.cls+'">'+b.text+'</span>':'')+'</div>';},sep:function(){return '<div class="aut-rc-sep"></div>';}};
    var identity=typeof AgentIdentity!=='undefined'?AgentIdentity.getDisplayIdentity():null;
    var state=typeof AgentWalletManager!=='undefined'?AgentWalletManager.getSecureWalletSummary():null;
    var reputation=typeof AgentReputation!=='undefined'?AgentReputation.getReputationGrade():null;
    var session=typeof AgentSession!=='undefined'?AgentSession.getSessionSummary():null;
    var authSummary=typeof AgentAuthorization!=='undefined'?AgentAuthorization.getAuthSummary():null;

    if(!identity && !state) return '';

    var agentName=identity?identity.name:'Autonoma';
    var walletAddr=state?state.walletAddress:(identity?identity.wallet:null);
    var shortAddr=walletAddr?walletAddr.slice(0,6)+'...'+walletAddr.slice(-4):'—';

    return '<div class="aut-rc" style="border-color:rgba(167,139,250,.25);margin-top:8px">'+
      R.head('robot',agentName,reputation?{text:reputation.grade+' '+reputation.label,cls:'live'}:{text:'Active',cls:'live'})+
      '<div class="aut-rc-body">'+
      R.row('Wallet',shortAddr,'purple')+
      (identity&&identity.tokenId?R.row('ERC-8004 ID','Token #'+identity.tokenId,'green'):R.row('ERC-8004',identity&&identity.verificationStatus==='registered'?'Registered':'Not registered','yellow'))+
      R.row('Reputation',(state?state.reputationScore:'—')+'/100','purple')+
      R.sep()+
      R.row('Version',identity?identity.version:'1.0.0','muted')+
      R.row('Developer',identity?identity.developer:'Elligentt','muted')+
      (state&&state.identityRegistered?R.row('Registration',new Date(state.registrationDate).toLocaleDateString(),'muted'):'')+
      R.sep()+
      R.row('Status',state&&state.status==='active'?'<span style="color:#22c55e">Active</span>':'<span style="color:#f59e0b">'+((state&&state.status)||'Unknown')+'</span>','muted')+
      R.row('Executions',String(state?state.executionCount||0:0),'muted')+
      (authSummary?R.row('Authorizations',String(authSummary.count)+' active','green'):'')+
      (session&&session.isPaused?R.row('Paused','<span style="color:#f59e0b">Yes</span>','yellow'):'')+
      R.sep()+
      R.row('Capabilities',(identity&&identity.capabilities?identity.capabilities.slice(0,5).join(', '):'—'),'muted')+
      '</div></div>';
  }

  function getAgentAuthorizationCard(R){
    if(!R) R={row:function(l,v,c){return '<div class="aut-rc-row"><span class="aut-rl">'+l+'</span><span class="aut-rv" style="color:var(--'+(c||'text')+')">'+v+'</span></div>';},head:function(i,t,b){return '<div class="aut-rc-head"><i class="ti ti-'+i+'"></i><span class="aut-rc-title">'+t+'</span>'+(b?'<span class="aut-rc-badge '+b.cls+'">'+b.text+'</span>':'')+'</div>';},sep:function(){return '<div class="aut-rc-sep"></div>';}};
    if(typeof AgentAuthorization==='undefined') return '';
    var active=AgentAuthorization.getActive();
    if(active.length===0){
      return '<div class="aut-rc" style="border-color:rgba(245,158,11,.2);margin-top:8px">'+
        R.head('shield-off','Agent Permissions',{text:'None',cls:'danger'})+
        '<div class="aut-rc-body">'+
        '<div style="font-size:9px;color:var(--muted)">No agent authorization active.</div>'+
        '<div style="font-size:9px;color:var(--muted2);margin-top:4px">Enable autonomous execution to grant the Agent Wallet permission to operate on your behalf.</div>'+
        '</div></div>';
    }
    var rows='';
    for(var i=0;i<active.length;i++){
      var a=active[i];
      rows+=R.head('shield-check',a.purpose||'Authorization',{text:a.status.toUpperCase(),cls:a.status==='active'?'live':'pending'})+
        R.row('Max Spending','$'+String(a.maxSpending||'999999'),'green')+
        (a.dailyLimit?R.row('Daily Limit','$'+String(a.dailyLimit),'green'):'')+
        R.row('Tokens',(a.allowedTokens||['*']).join(', '),'muted')+
        R.row('Networks',(a.allowedNetworks||['*']).join(', '),'muted')+
        R.row('Allowed Ops',typeof AgentAuthorization!=='undefined'?AgentAuthorization.fmtAllowedOps(a):'',a.allowSwap?'green':'muted')+
        R.row('Expires',typeof AgentAuthorization!=='undefined'?AgentAuthorization.fmtTimeLeft(a.expiresAt):'','muted')+
        R.sep();
    }
    return '<div class="aut-rc" style="border-color:rgba(34,197,94,.2);margin-top:8px">'+
      R.head('shield-check','Agent Permissions',{text:active.length+' active',cls:'live'})+
      '<div class="aut-rc-body">'+rows+'</div></div>';
  }

  function getAgentReply(query){
    if(typeof AgentIdentity==='undefined') return null;
    var q=query.toLowerCase();

    if(/\bwho are you\b/i.test(q)||/\bquem [eé] voc[eê]/i.test(q)){
      return {type:'agent',card:'identity'};
    }
    if(/\bshow your wallet\b/i.test(q)||/\bmostr[ae] sua carteira\b/i.test(q)||/\bagent wallet\b/i.test(q)){
      return {type:'agent',card:'wallet'};
    }
    if(/\bwhat permissions\b/i.test(q)||/\bquais permiss[oõ]es\b/i.test(q)||/\bshow.*permissions\b/i.test(q)||/\bmostr.*permiss[oõ]es\b/i.test(q)){
      return {type:'agent',card:'authorization'};
    }
    if(/\bpause.*autonomous\b/i.test(q)||/\bpausar.*aut[oô]nomo\b/i.test(q)||/\bpause agent\b/i.test(q)||/\bpausar agente\b/i.test(q)){
      return {type:'agent',action:'pause'};
    }
    if(/\bresume.*autonomous\b/i.test(q)||/\bretomar.*aut[oô]nomo\b/i.test(q)||/\bresume agent\b/i.test(q)||/\bretomar agente\b/i.test(q)){
      return {type:'agent',action:'resume'};
    }
    if(/\brevoke.*authorization\b/i.test(q)||/\brevogar.*autoriza[cç][aã]o\b/i.test(q)||/\brevoke agent\b/i.test(q)){
      return {type:'agent',action:'revoke'};
    }
    if(/\bincrease daily limit\b/i.test(q)||/\baumentar limite di[aá]rio\b/i.test(q)){
      return {type:'agent',action:'increase_daily_limit'};
    }
    if(/\bdisable bridge\b/i.test(q)||/\bdesabilitar bridge\b/i.test(q)){
      return {type:'agent',action:'disable_bridge'};
    }
    if(/\ballow treasury only\b/i.test(q)||/\bpermitir apenas treasury\b/i.test(q)){
      return {type:'agent',action:'treasury_only'};
    }
    if(/\ballow only arc\b/i.test(q)||/\bpermitir apenas arc\b/i.test(q)){
      return {type:'agent',action:'arc_only'};
    }
    if(/\bextend authorization\b/i.test(q)||/\bextender autoriza[cç][aã]o\b/i.test(q)){
      return {type:'agent',action:'extend'};
    }
    if(/\blimit swaps to\b/i.test(q)||/\blimitar swaps\b/i.test(q)){
      return {type:'agent',action:'limit_swaps'};
    }
    if(/\bcan you execute swaps automatically\b/i.test(q)||/\bvoc[eê] pode executar swaps automaticamente\b/i.test(q)){
      return {type:'agent',card:'authorization'};
    }
    if(/\bshow.*reputation\b/i.test(q)||/\bmostr.*reputa[cç][aã]o\b/i.test(q)){
      return {type:'agent',card:'reputation'};
    }
    return null;
  }

  function getReputationCard(R){
    if(!R) R={row:function(l,v,c){return '<div class="aut-rc-row"><span class="aut-rl">'+l+'</span><span class="aut-rv" style="color:var(--'+(c||'text')+')">'+v+'</span></div>';},head:function(i,t,b){return '<div class="aut-rc-head"><i class="ti ti-'+i+'"></i><span class="aut-rc-title">'+t+'</span>'+(b?'<span class="aut-rc-badge '+b.cls+'">'+b.text+'</span>':'')+'</div>';},sep:function(){return '<div class="aut-rc-sep"></div>';}};
    var rep=typeof AgentReputation!=='undefined'?AgentReputation.getReputation():null;
    if(!rep) return '';
    var grade=typeof AgentReputation!=='undefined'?AgentReputation.getReputationGrade():{grade:'C',label:'Average',color:'#f59e0b'};
    return '<div class="aut-rc" style="border-color:rgba(167,139,250,.2);margin-top:8px">'+
      R.head('stars',grade.label,{text:'Grade '+grade.grade,cls:'live'})+
      '<div class="aut-rc-body">'+
      R.row('Score',String(rep.reputationScore)+'/100','purple')+
      R.row('Completion Rate',String(rep.completionRate)+'%','green')+
      R.row('Success',String(rep.successfulExecutions),'green')+
      R.row('Failed',String(rep.failedExecutions),'red')+
      R.row('Cancelled',String(rep.cancelledOperations),'yellow')+
      R.row('Avg Execution',String(rep.averageExecutionTime)+'ms','muted')+
      R.row('Avg Planning',String(rep.averagePlanningTime)+'ms','muted')+
      R.sep()+
      R.row('Swap Rate',String(rep.swapSuccessRate)+'%','muted')+
      R.row('Bridge Rate',String(rep.bridgeSuccessRate)+'%','muted')+
      R.row('Treasury Rate',String(rep.treasurySuccessRate)+'%','muted')+
      R.row('Payment Rate',String(rep.paymentSuccessRate)+'%','muted')+
      '</div></div>';
  }

  window.AutonomaAgent = {
    createWorkflow: createWorkflow,
    updateStep: updateStep,
    getActiveWorkflows: getActiveWorkflows,
    getWorkflowHtml: getWorkflowHtml,
    monitorTx: monitorTx,
    pollTx: pollTx,
    stopMonitor: stopMonitor,
    checkAlerts: checkAlerts,
    injectAlerts: injectAlerts,
    getAlertHtml: getAlertHtml,
    start: start,
    stop: stop,
    // Agent identity & authorization
    getAgentIdentityCard: getAgentIdentityCard,
    getAgentAuthorizationCard: getAgentAuthorizationCard,
    getAgentReply: getAgentReply,
    getReputationCard: getReputationCard
  };
})();

