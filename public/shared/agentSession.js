/**
 * Autonoma Agent Session — Session Management for Agent Conversations
 * Tracks current goal, plan, workflow, simulation, risk, permits, execution queue.
 * Persists safely between sessions.
 * Attached to window.AgentSession
 */
(function(){
  'use strict';

  var SESSION_KEY = 'elligentt_agent_session_v2';
  var session = null;

  function defaultSession(){
    return {
      sessionId: 'session_'+Date.now()+'_'+Math.random().toString(36).substr(2,6),
      openedAt: Date.now(),
      lastActivity: Date.now(),
      status: 'active',
      currentGoal: null,
      currentPlan: null,
      currentWorkflow: null,
      simulation: null,
      riskAnalysis: null,
      permitStatus: null,
      executionQueue: [],
      currentScreen: null,
      currentTask: null,
      conversationContext: [],
      agentWalletAddress: null,
      agentIdentityTokenId: null,
      authorizationId: null,
      pausedAt: null
    };
  }

  function load(){
    try {
      var r=localStorage.getItem(SESSION_KEY);
      if(r) session=JSON.parse(r);
    } catch(e){ session=null; }
    if(!session||isExpired()){
      session=defaultSession();
    }
    // Sync agent wallet
    if(typeof AgentWalletManager!=='undefined'){
      session.agentWalletAddress=AgentWalletManager.getAgentAddress();
      session.agentIdentityTokenId=AgentWalletManager.getAgentId();
    }
  }

  function save(){
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch(e){}
  }

  function isExpired(){
    if(!session) return true;
    if(session.status==='closed') return true;
    var maxIdle=24*60*60*1000; // 24 hours
    return (Date.now()-session.lastActivity)>maxIdle;
  }

  function touch(){
    session.lastActivity=Date.now();
    if(typeof AgentWalletManager!=='undefined'){
      session.agentWalletAddress=AgentWalletManager.getAgentAddress();
    }
    save();
  }

  function setGoal(goal){
    session.currentGoal=goal;
    session.pausedAt=null;
    touch();
  }

  function getGoal(){ return session?session.currentGoal:null; }

  function setPlan(plan){
    session.currentPlan=plan;
    touch();
  }

  function getPlan(){ return session?session.currentPlan:null; }

  function setWorkflow(workflow){
    session.currentWorkflow=workflow;
    touch();
  }

  function getWorkflow(){ return session?session.currentWorkflow:null; }

  function setSimulation(sim){
    session.simulation=sim;
    touch();
  }

  function getSimulation(){ return session?session.simulation:null; }

  function setRiskAnalysis(risk){
    session.riskAnalysis=risk;
    touch();
  }

  function getRiskAnalysis(){ return session?session.riskAnalysis:null; }

  function setPermitStatus(status){
    session.permitStatus=status;
    touch();
  }

  function getPermitStatus(){ return session?session.permitStatus:null; }

  function addToQueue(task){
    session.executionQueue.unshift({
      id:task.id, type:task.type, status:'pending',
      addedAt:Date.now()
    });
    if(session.executionQueue.length>50) session.executionQueue.length=50;
    touch();
  }

  function updateQueueItem(id, status, data){
    var item=session.executionQueue.find(function(t){return t.id===id;});
    if(item){ item.status=status; if(data) Object.assign(item,data); }
    touch();
  }

  function getQueue(){ return session?session.executionQueue:[]; }

  function setCurrentScreen(screen){
    session.currentScreen=screen;
    touch();
  }

  function getCurrentScreen(){ return session?session.currentScreen:null; }

  function setCurrentTask(task){
    session.currentTask=task;
    touch();
  }

  function getCurrentTask(){ return session?session.currentTask:null; }

  function addConversationContext(entry){
    session.conversationContext.unshift({
      text:entry, timestamp:Date.now()
    });
    if(session.conversationContext.length>100) session.conversationContext.length=100;
    touch();
  }

  function getConversationContext(limit){
    return (session?session.conversationContext:[]).slice(0,limit||20);
  }

  function setAuthorizationId(authId){
    session.authorizationId=authId;
    touch();
  }

  function getAuthorizationId(){ return session?session.authorizationId:null; }

  function pause(){
    session.status='paused';
    session.pausedAt=Date.now();
    if(typeof AgentWalletManager!=='undefined') AgentWalletManager.pause();
    save();
  }

  function resume(){
    session.status='active';
    session.pausedAt=null;
    if(typeof AgentWalletManager!=='undefined') AgentWalletManager.resume();
    save();
  }

  function isPaused(){
    return session&&session.status==='paused';
  }

  function close(){
    session.status='closed';
    session.closedAt=Date.now();
    save();
  }

  function getSessionId(){ return session?session.sessionId:null; }

  function getSessionSummary(){
    if(!session) load();
    return {
      sessionId:session.sessionId,
      status:session.status,
      openedAt:session.openedAt,
      lastActivity:session.lastActivity,
      currentGoal:session.currentGoal,
      currentScreen:session.currentScreen,
      currentTask:session.currentTask,
      queueCount:session.executionQueue.length,
      contextEntries:session.conversationContext.length,
      isPaused:session.status==='paused',
      agentWalletAddress:session.agentWalletAddress
    };
  }

  function updateConversationMemory(opts){
    if(!session) load();
    if(opts.goal!==undefined) session.currentGoal=opts.goal;
    if(opts.plan!==undefined) session.currentPlan=opts.plan;
    if(opts.workflow!==undefined) session.currentWorkflow=opts.workflow;
    if(opts.simulation!==undefined) session.simulation=opts.simulation;
    if(opts.riskAnalysis!==undefined) session.riskAnalysis=opts.riskAnalysis;
    if(opts.permitStatus!==undefined) session.permitStatus=opts.permitStatus;
    if(opts.currentScreen!==undefined) session.currentScreen=opts.currentScreen;
    if(opts.currentTask!==undefined) session.currentTask=opts.currentTask;
    touch();
  }

  function clearSession(){
    session=defaultSession();
    save();
  }

  load();

  window.AgentSession = {
    setGoal:setGoal, getGoal:getGoal,
    setPlan:setPlan, getPlan:getPlan,
    setWorkflow:setWorkflow, getWorkflow:getWorkflow,
    setSimulation:setSimulation, getSimulation:getSimulation,
    setRiskAnalysis:setRiskAnalysis, getRiskAnalysis:getRiskAnalysis,
    setPermitStatus:setPermitStatus, getPermitStatus:getPermitStatus,
    addToQueue:addToQueue, updateQueueItem:updateQueueItem, getQueue:getQueue,
    setCurrentScreen:setCurrentScreen, getCurrentScreen:getCurrentScreen,
    setCurrentTask:setCurrentTask, getCurrentTask:getCurrentTask,
    addConversationContext:addConversationContext, getConversationContext:getConversationContext,
    setAuthorizationId:setAuthorizationId, getAuthorizationId:getAuthorizationId,
    pause:pause, resume:resume, isPaused:isPaused, close:close,
    getSessionId:getSessionId, getSessionSummary:getSessionSummary,
    updateConversationMemory:updateConversationMemory,
    clearSession:clearSession,
    touch:touch
  };
})();
