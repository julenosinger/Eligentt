/**
 * Autonoma Policy Engine — Execution Policy Validation
 * Validates every autonomous execution against policies, risk, authorization scope.
 * No execution bypasses these validations.
 * Attached to window.PolicyEngine
 */
(function(){
  'use strict';

  var POLICY_KEY = 'elligentt_policies_v1';
  var policies = {};

  function load(){
    try {
      var r=localStorage.getItem(POLICY_KEY);
      if(r) policies=JSON.parse(r);
    } catch(e){ policies={}; }
    if(!policies.defaults){
      policies.defaults={
        maxGasUsd: 5,
        maxSlippageBps: 100,
        minContractTrust: 'medium',
        requireSimulation: true,
        requireRiskCheck: true,
        requireAuthorization: true,
        maxDailyOps: 50,
        retryMax: 3,
        retryDelayMs: 30000,
        pauseOnFailure: true,
        notifyOnFailure: true,
        notifyOnSuccess: false,
        auditAll: true
      };
    }
  }

  function save(){
    try { localStorage.setItem(POLICY_KEY, JSON.stringify(policies)); } catch(e){}
  }

  function getDefaults(){
    return Object.assign({}, policies.defaults);
  }

  function setDefault(key, value){
    policies.defaults[key]=value;
    save();
  }

  /* ── Full execution policy validation ── */
  function validateExecution(opts){
    var results=[];
    var allValid=true;
    var defaults=policies.defaults;

    // 1. Authorization validation
    if(defaults.requireAuthorization){
      if(typeof AgentAuthorization!=='undefined'){
        var authCheck=AgentAuthorization.validateExecution({
          operation:opts.operation,
          amount:opts.amount,
          asset:opts.asset||'USDC',
          network:opts.network||'Arc Testnet',
          contract:opts.contract||'',
          destination:opts.destination||''
        });
        if(!authCheck.valid){
          results.push({rule:'Authorization',passed:false,reason:authCheck.reason,details:authCheck});
          allValid=false;
        } else {
          results.push({rule:'Authorization',passed:true,reason:'Authorized by '+((authCheck.auth&&authCheck.auth.id)||'active authorization'),details:authCheck});
        }
      }
    }

    // 2. Risk score validation
    if(defaults.requireRiskCheck&&typeof RiskEngine!=='undefined'){
      var risk=RiskEngine.analyze({
        operation:opts.operation,
        amount:opts.amount||0,
        asset:opts.asset||'USDC',
        contract:opts.contract||'',
        network:opts.network||'Arc Testnet',
        destination:opts.destination||''
      });
      var maxRisk=opts.maxRiskLevel||'MEDIUM';
      var riskLevels={LOW:0,MEDIUM:1,HIGH:2,CRITICAL:3};
      if(riskLevels[risk.level]>riskLevels[maxRisk]){
        results.push({rule:'Risk Score',passed:false,reason:'Risk level '+risk.level+' exceeds max '+maxRisk,details:risk});
        allValid=false;
      } else {
        results.push({rule:'Risk Score',passed:true,reason:'Risk level '+risk.level+' within limits',details:risk});
      }
    }

    // 3. Contract reputation
    if(opts.contract&&typeof ContractRegistry!=='undefined'){
      var contractInfo=ContractRegistry.lookup(opts.contract);
      var minTrust=defaults.minContractTrust||'medium';
      var trustLevels={high:3,medium:2,low:1,unknown:0};
      if(contractInfo){
        var trustLevel=contractInfo.trust||'unknown';
        if(trustLevels[trustLevel]<trustLevels[minTrust]){
          results.push({rule:'Contract Reputation',passed:false,reason:'Contract trust '+trustLevel+' below minimum '+minTrust,details:contractInfo});
          allValid=false;
        } else {
          results.push({rule:'Contract Reputation',passed:true,reason:'Contract trusted ('+trustLevel+')',details:contractInfo});
        }
      } else if(opts.contract!=='*'){
        results.push({rule:'Contract Reputation',passed:false,reason:'Unknown contract',details:{address:opts.contract}});
        allValid=false;
      } else {
        results.push({rule:'Contract Reputation',passed:true,reason:'Wildcard contract allowed'});
      }
    }

    // 4. Simulation success
    if(defaults.requireSimulation&&opts.simulationHash){
      results.push({rule:'Simulation',passed:true,reason:'Simulation hash: '+opts.simulationHash.substring(0,12)+'...'});
    } else if(defaults.requireSimulation&&!opts.simulationHash&&opts.operation!=='payment'&&opts.operation!=='swap'){
      results.push({rule:'Simulation',passed:false,reason:'No simulation performed'});
      allValid=false;
    }

    // 5. Daily allowance
    if(typeof AgentAuthorization!=='undefined'&&opts.authId){
      var auths=AgentAuthorization.getActive();
      var auth=auths.find(function(a){return a.id===opts.authId;});
      if(auth){
        if(auth.maxSpending>0&&(auth.usedSpending+(opts.amount||0))>auth.maxSpending){
          results.push({rule:'Daily Allowance',passed:false,reason:'Would exceed max spending ('+auth.maxSpending+')'});
          allValid=false;
        } else {
          results.push({rule:'Daily Allowance',passed:true,reason:'Within spending limits'});
        }
        if(auth.dailyLimit&&(auth.dailyUsed+(opts.amount||0))>auth.dailyLimit){
          results.push({rule:'Daily Budget',passed:false,reason:'Would exceed daily limit ('+auth.dailyLimit+')'});
          allValid=false;
        } else {
          results.push({rule:'Daily Budget',passed:true,reason:'Within daily budget'});
        }
      }
    }

    // 6. Expiration check
    if(opts.authId&&typeof AgentAuthorization!=='undefined'){
      var allAuths=AgentAuthorization.getAll();
      var found=allAuths.find(function(a){return a.id===opts.authId;});
      if(found&&found.status==='expired'){
        results.push({rule:'Expiration',passed:false,reason:'Authorization expired at '+new Date(found.expiresAt).toLocaleString()});
        allValid=false;
      } else if(found){
        results.push({rule:'Expiration',passed:true,reason:'Authorization valid until '+new Date(found.expiresAt).toLocaleString()});
      }
    }

    // 7. Maximum uses check
    if(opts.authId&&typeof AgentAuthorization!=='undefined'){
      var useAuths=AgentAuthorization.getAll();
      var useAuth=useAuths.find(function(a){return a.id===opts.authId;});
      if(useAuth&&useAuth.maxUses&&useAuth.useCount>=useAuth.maxUses){
        results.push({rule:'Max Uses',passed:false,reason:'Maximum uses reached ('+useAuth.maxUses+')'});
        allValid=false;
      } else if(useAuth&&useAuth.maxUses){
        results.push({rule:'Max Uses',passed:true,reason:(useAuth.maxUses-useAuth.useCount)+' uses remaining'});
      }
    }

    // 8. Gas policy
    if(defaults.maxGasUsd&&opts.estimatedGas&&opts.estimatedGas>defaults.maxGasUsd){
      results.push({rule:'Gas Policy',passed:false,reason:'Estimated gas $'+opts.estimatedGas+' exceeds max $'+defaults.maxGasUsd});
      allValid=false;
    } else {
      results.push({rule:'Gas Policy',passed:true,reason:'Gas within policy limits'});
    }

    // 9. Slippage check
    if(opts.slippage&&opts.slippage>defaults.maxSlippageBps){
      results.push({rule:'Slippage',passed:false,reason:'Slippage '+opts.slippage+'bps exceeds max '+defaults.maxSlippageBps+'bps'});
      allValid=false;
    } else {
      results.push({rule:'Slippage',passed:true,reason:'Slippage within limits'});
    }

    // 10. Destination validation
    if(opts.destination&&typeof ContractRegistry!=='undefined'){
      var isKnown=ContractRegistry.isKnown(opts.destination);
      if(!isKnown&&opts.destination!=='*'){
        results.push({rule:'Destination',passed:false,reason:'Unknown destination address'});
        allValid=false;
      } else {
        results.push({rule:'Destination',passed:true,reason:'Destination validated'});
      }
    }

    // 11. Chain availability
    if(opts.network){
      var supportedChains=typeof AgentWalletManager!=='undefined'?AgentWalletManager.getSupportedChains():[];
      if(supportedChains.length>0&&supportedChains.indexOf(opts.network)===-1){
        results.push({rule:'Chain Availability',passed:false,reason:'Chain '+opts.network+' not in supported chains'});
        allValid=false;
      } else {
        results.push({rule:'Chain Availability',passed:true,reason:'Chain '+opts.network+' available'});
      }
    }

    // 12. Agent pause check
    if(typeof AgentWalletManager!=='undefined'&&AgentWalletManager.isPaused()){
      results.push({rule:'Agent Status',passed:false,reason:'Agent is paused'});
      allValid=false;
    } else {
      results.push({rule:'Agent Status',passed:true,reason:'Agent is active'});
    }

    // 13. Maximum daily operations
    var todayCount=0;
    if(typeof ExecutionHistory!=='undefined'){
      var stats=ExecutionHistory.getStats();
      todayCount=stats.today||0;
    }
    if(todayCount>=defaults.maxDailyOps){
      results.push({rule:'Daily Op Limit',passed:false,reason:'Daily operation limit reached ('+defaults.maxDailyOps+')'});
      allValid=false;
    } else {
      results.push({rule:'Daily Op Limit',passed:true,reason:'Daily ops: '+(todayCount+1)+'/'+defaults.maxDailyOps});
    }

    return {
      valid:allValid,
      results:results,
      failedRules:results.filter(function(r){return !r.passed;}),
      passedRules:results.filter(function(r){return r.passed;}),
      timestamp:Date.now(),
      policyVersion:policies.defaults?1:0
    };
  }

  /* ── Quick check before execution ── */
  function quickCheck(operation, amount, asset, network){
    return validateExecution({
      operation:operation, amount:amount||0, asset:asset||'USDC',
      network:network||'Arc Testnet', contract:'', destination:'',
      simulationHash:null, authId:null, slippage:null
    });
  }

  /* ── Policy management ── */
  function getPolicies(){
    return Object.assign({}, policies);
  }

  function updatePolicy(policy, value){
    var keys=policy.split('.');
    if(keys.length===1){
      policies[keys[0]]=value;
    } else if(keys.length===2){
      if(!policies[keys[0]]) policies[keys[0]]={};
      policies[keys[0]][keys[1]]=value;
    }
    save();
  }

  function getPolicy(policy){
    var keys=policy.split('.');
    if(keys.length===1) return policies[keys[0]];
    if(keys.length===2&&policies[keys[0]]) return policies[keys[0]][keys[1]];
    return null;
  }

  function resetPolicies(){
    policies={};
    load();
    save();
  }

  load();

  window.PolicyEngine = {
    validateExecution:validateExecution,
    quickCheck:quickCheck,
    getDefaults:getDefaults,
    setDefault:setDefault,
    getPolicies:getPolicies,
    updatePolicy:updatePolicy,
    getPolicy:getPolicy,
    resetPolicies:resetPolicies
  };
})();
