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
  ════════════════════════════════════════ */
  var monitoredTxs = [];

  function monitorTx(txHash, chainId, callback){
    var id = 'mtx_' + Date.now();
    monitoredTxs.push({ id: id, txHash: txHash, chainId: chainId, callback: callback, startTime: Date.now(), confirmed: false });
    if(monitoredTxs.length > 10) monitoredTxs.shift();
    return id;
  }

  async function pollTx(txHash){
    try {
      if(typeof ethers === 'undefined') return null;
      var rpc = 'https://rpc.testnet.arc.network';
      var provider = new ethers.JsonRpcProvider(rpc);
      var receipt = await provider.getTransactionReceipt(txHash);
      return receipt;
    } catch(e){ return null; }
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

    // 3. Low balance
    try {
      if(typeof walletAddress !== 'undefined' && walletAddress){
        var balEl = document.getElementById('sb-bal');
        var balance = balEl ? parseFloat(balEl.textContent) : null;
        if(balance !== null && !isNaN(balance) && balance < 10 && balance > 0 && !wasShown('low_bal', 1800000)){
          alerts.push({ type: 'low_balance', priority: 'medium', text: 'Balance is low: ' + balance.toFixed(2) + ' USDC. Consider topping up.', action: 'show my balance' });
        }
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
    return '<div class="ai-rec-item" style="display:flex;align-items:center;gap:8px">' +
      '<i class="ti ti-' + icon + '" style="color:' + priorityColor + ';font-size:14px;flex-shrink:0"></i>' +
      '<div style="flex:1"><div style="font-size:9px;color:var(--text)">' + alert.text + '</div></div>' +
      '<button class="aut-act" onclick="autonomaSendQuick(\'' + alert.action + '\')" style="font-size:8px;padding:2px 8px"><i class="ti ti-arrow-right"></i></button>' +
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
  ════════════════════════════════════════ */
  function start(){
    if(monitorInterval) return;
    monitorInterval = setInterval(function(){
      try {
        var alerts = checkAlerts();
        if(alerts.length > 0) injectAlerts(alerts);
      } catch(e){}
    }, 45000); // Check every 45 seconds
  }

  load();
  start();

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
    start: start
  };
})();
