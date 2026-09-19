/**
 * Autonoma Trust Layer — Trust metadata for every workflow execution
 * Prepares trust metadata: Agent Wallet, ERC-8004 Identity, Authorization ID,
 * Simulation Hash, Risk Report, Confidence Score, Planner Version, Execution Policy.
 * Attached to window.TrustLayer
 */
(function(){
  'use strict';

  /* ── Build trust metadata for a workflow execution ── */
  function buildTrustLayer(opts){
    var agentWallet=typeof AgentWalletManager!=='undefined'?AgentWalletManager.getAgentAddress():null;
    var agentId=typeof AgentWalletManager!=='undefined'?AgentWalletManager.getAgentId():null;
    var identity=typeof AgentIdentity!=='undefined'?AgentIdentity.getDisplayIdentity():null;
    var reputation=typeof AgentReputation!=='undefined'?AgentReputation.getReputation():null;
    var authId=typeof AgentSession!=='undefined'?AgentSession.getAuthorizationId():null;

    return {
      // Identity
      preparedBy: 'Autonoma Agent',
      agentWallet: agentWallet,
      erc8004Identity: agentId,
      agentName: identity?identity.name:'Autonoma',
      agentVersion: identity?identity.version:'1.0.0',
      agentCapabilities: identity?identity.capabilities:[],

      // Authorization
      authorizationId: authId||opts.authorizationId||'',

      // Simulation
      simulationHash: opts.simulationHash||'',

      // Risk
      riskReport: opts.riskReport||null,
      riskLevel: opts.riskLevel||'LOW',

      // Confidence
      confidenceScore: opts.confidenceScore||0,

      // Planning
      plannerVersion: opts.plannerVersion||'1.0.0',

      // Policy
      executionPolicy: opts.executionPolicy||'default',

      // Execution context
      executionTimestamp: Date.now(),
      executionChain: opts.chain||'Arc Testnet',
      executionNetwork: opts.network||'Arc Testnet',

      // Reputation
      agentReputationScore: reputation?reputation.reputationScore:50,
      agentReputationGrade: typeof AgentReputation!=='undefined'?AgentReputation.getReputationGrade():null,

      // Verification
      identityVerified: identity?identity.verificationStatus==='verified':false,
      identityRegistered: identity?!!identity.tokenId:false
    };
  }

  /* ── Get workflow trust summary ── */
  function getTrustSummary(){
    var identity=typeof AgentIdentity!=='undefined'?AgentIdentity.getDisplayIdentity():null;
    var reputation=typeof AgentReputation!=='undefined'?AgentReputation.getReputationGrade():null;
    var session=typeof AgentSession!=='undefined'?AgentSession.getSessionSummary():null;

    return {
      agentName: identity?identity.name:'Autonoma',
      agentWallet: identity?identity.wallet:null,
      identityNFT: identity?identity.identityNFT:null,
      isRegistered: identity?!!identity.tokenId:false,
      registrationTx: identity?identity.registrationTx:null,
      verificationStatus: identity?identity.verificationStatus:'unverified',
      reputationScore: typeof AgentReputation!=='undefined'?AgentReputation.getReputationScore():50,
      reputationGrade: reputation,
      sessionStatus: session?session.status:'unknown',
      isPaused: session?session.isPaused:false,
      activeAuthorizations: typeof AgentAuthorization!=='undefined'?AgentAuthorization.getActive().length:0,
      totalExecutions: typeof AgentAudit!=='undefined'?AgentAudit.getStats().total:0
    };
  }

  /* ── Generate signature package for verification ── */
  function buildSignaturePackage(opts){
    var trust=buildTrustLayer(opts);

    // Build a deterministic message for potential on-chain verification
    var messageParts=[
      'AutonomaAgent',
      trust.agentWallet||'',
      trust.erc8004Identity||'',
      trust.authorizationId||'',
      trust.simulationHash||'',
      trust.riskLevel||'LOW',
      opts.operation||'',
      (opts.amount||0).toString(),
      opts.asset||'USDC',
      opts.chain||'Arc Testnet',
      trust.executionTimestamp.toString()
    ];

    return {
      trust:trust,
      message:messageParts.join('|'),
      timestamp:Date.now()
    };
  }

  /* ── Format trust layer for UI display ── */
  function getTrustLayerHtml(trustLayer, R){
    if(!R) R={row:function(l,v,c){return '<div class="aut-rc-row"><span class="aut-rl">'+l+'</span><span class="aut-rv" style="color:var(--'+(c||'text')+')">'+v+'</span></div>';},head:function(i,t,b){return '<div class="aut-rc-head"><i class="ti ti-'+i+'"></i><span class="aut-rc-title">'+t+'</span>'+(b?'<span class="aut-rc-badge '+b.cls+'">'+b.text+'</span>':'')+'</div>';},sep:function(){return '<div class="aut-rc-sep"></div>';}};

    var reputationBadge=trustLayer.reputationScore>=75?{text:'Trusted',cls:'live'}:trustLayer.reputationScore>=50?{text:'Standard',cls:'pending'}:{text:'Low',cls:'danger'};

    return '<div class="aut-rc" style="border-color:rgba(167,139,250,.2);margin-top:8px">'+
      R.head('shield-check','Trust Layer',reputationBadge)+
      '<div class="aut-rc-body">'+
      R.row('Prepared By',trustLayer.agentName,'purple')+
      R.row('Agent Wallet',trustLayer.agentWallet?trustLayer.agentWallet.slice(0,6)+'...'+trustLayer.agentWallet.slice(-4):'—','muted')+
      (trustLayer.erc8004Identity?R.row('ERC-8004 ID','Token #'+trustLayer.erc8004Identity,'green'):'')+
      R.row('Reputation',trustLayer.reputationScore+'/100','purple')+
      (trustLayer.authorizationId?R.row('Authorization',trustLayer.authorizationId.slice(0,16)+'...','green'):'')+
      R.sep()+
      (trustLayer.simulationHash?R.row('Simulation',trustLayer.simulationHash.slice(0,12)+'...','muted'):'')+
      R.row('Risk Level',trustLayer.riskLevel||'N/A',trustLayer.riskLevel==='LOW'?'green':trustLayer.riskLevel==='MEDIUM'?'yellow':'red')+
      R.row('Confidence',(trustLayer.confidenceScore||0)+'%','muted')+
      R.row('Planner',trustLayer.plannerVersion||'1.0','muted')+
      R.row('Policy',trustLayer.executionPolicy||'default','muted')+
      '</div></div>';
  }

  window.TrustLayer = {
    buildTrustLayer:buildTrustLayer,
    getTrustSummary:getTrustSummary,
    buildSignaturePackage:buildSignaturePackage,
    getTrustLayerHtml:getTrustLayerHtml
  };
})();
