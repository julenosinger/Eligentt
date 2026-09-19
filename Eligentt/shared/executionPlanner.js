/**
 * Elligentt Execution Planner — Phases 1+3+10
 * Workflow planning, execution preview, autonomous workflow engine.
 * Attached to window.ExecutionPlanner
 */
(function(){
  'use strict';

  var PE = window.PermitEngine;
  var RE = window.RiskEngine;
  var CR = window.ContractRegistry;
  var EQ = window.ExecutionQueue;
  var PC = window.PermissionCards;

  /* ── Workflow step types ── */
  var STEP_TYPES = ['validate_wallet','check_balances','verify_permits','request_permit','execute_swap','execute_bridge','execute_treasury','execute_payment','wait_confirm','verify_balances','generate_receipt','notify'];

  var STEP_LABELS = {
    validate_wallet: 'Validate wallet', check_balances: 'Check balances',
    verify_permits: 'Verify active permits', request_permit: 'Request additional permit',
    execute_swap: 'Execute swap', execute_bridge: 'Execute bridge',
    execute_treasury: 'Execute treasury operation', execute_payment: 'Send payment',
    wait_confirm: 'Wait for confirmations', verify_balances: 'Verify final balances',
    generate_receipt: 'Generate receipt', notify: 'Send notification'
  };

  var STEP_ICONS = {
    validate_wallet: 'wallet', check_balances: 'chart-bar',
    verify_permits: 'shield-check', request_permit: 'shield-lock',
    execute_swap: 'arrows-exchange', execute_bridge: 'topology-star-3',
    execute_treasury: 'building-bank', execute_payment: 'send',
    wait_confirm: 'clock', verify_balances: 'chart-dots',
    generate_receipt: 'file-description', notify: 'bell'
  };

  var STEP_ESTIMATES = {
    validate_wallet: 1, check_balances: 2, verify_permits: 1,
    request_permit: 3, execute_swap: 8, execute_bridge: 15,
    execute_treasury: 6, execute_payment: 5, wait_confirm: 10,
    verify_balances: 2, generate_receipt: 1, notify: 1
  };

  /* ── Build workflow from user intent ── */
  function buildWorkflow(opts){
    var intent = opts.intent || 'payment';
    var amount = opts.amount || 0;
    var asset = opts.asset || 'USDC';
    var fromChain = opts.fromChain || 'Arc Testnet';
    var toChain = opts.toChain || null;
    var needsSwap = opts.needsSwap || false;
    var needsBridge = opts.needsBridge || (!!toChain && toChain !== fromChain);
    var needsTreasury = opts.needsTreasury || false;

    var steps = [];
    steps.push('validate_wallet');
    steps.push('check_balances');

    // Check if permits exist
    var permitCheck = PE.checkCoverage({operation:intent,amount:amount,asset:asset,network:fromChain});
    if(permitCheck.covered){
      steps.push('verify_permits');
    } else {
      steps.push('verify_permits');
      steps.push('request_permit');
    }

    if(needsSwap) steps.push('execute_swap');
    if(needsBridge) steps.push('execute_bridge');
    if(needsTreasury) steps.push('execute_treasury');
    if(intent === 'payment' || intent === 'send') steps.push('execute_payment');

    steps.push('wait_confirm');
    steps.push('verify_balances');
    steps.push('generate_receipt');

    // Calculate estimates
    var totalTime = 0;
    var estGas = 0;
    for(var i=0; i<steps.length; i++){
      totalTime += STEP_ESTIMATES[steps[i]] || 2;
      estGas += (STEP_ESTIMATES[steps[i]] || 2) * 0.01;
    }

    // Risk analysis
    var risk = null;
    try { risk = RE.analyze({operation:intent,amount:amount,asset:asset,network:fromChain,purpose:opts.purpose||''}); } catch(e){}

    return {
      id: 'plan_' + Date.now(),
      goal: opts.goal || (intent + ' ' + amount + ' ' + asset),
      steps: steps,
      estimatedTime: totalTime,
      estimatedGas: estGas.toFixed(3) + ' USD',
      estimatedCost: (estGas + amount * 0.001).toFixed(2) + ' USD',
      riskLevel: risk ? risk.level : 'MEDIUM',
      riskDetails: risk ? risk.findings : [],
      riskRecommendation: risk ? risk.recommendation : '',
      riskRequiresConfirm: risk ? risk.requiresExplicitConfirm : false,
      successProbability: risk && risk.level === 'LOW' ? '98%' : risk && risk.level === 'MEDIUM' ? '92%' : risk && risk.level === 'HIGH' ? '75%' : '60%',
      approved: false,
      executed: false,
      currentStep: 0,
      completedSteps: [],
      failedSteps: [],
      createdAt: Date.now()
    };
  }

  /* ── Execute a workflow step ── */
  async function executeStep(plan, stepIndex, params){
    if(stepIndex >= plan.steps.length) return {done: true};

    var stepType = plan.steps[stepIndex];
    var stepResult = {type: stepType, status: 'completed', data: null, error: null};

    plan.currentStep = stepIndex;
    plan.completedSteps.push(stepType);

    // Simulate execution (in production, these would do real on-chain calls)
    switch(stepType){
      case 'validate_wallet':
        if(typeof walletAddress !== 'undefined' && walletAddress){
          stepResult.data = {wallet: walletAddress, valid: true};
        } else {
          stepResult.status = 'failed';
          stepResult.error = 'Wallet not connected';
          plan.failedSteps.push(stepType);
        }
        break;
      case 'check_balances':
        stepResult.data = {balances: 'checked'};
        break;
      case 'verify_permits':
        var active = PE.getActive();
        stepResult.data = {activePermits: active.length, covered: active.length > 0};
        break;
      case 'request_permit':
        var permitCheck2 = PE.checkCoverage({operation: params.operation||'payment',amount:params.amount||0,asset:params.asset||'USDC'});
        if(permitCheck2.covered){
          stepResult.data = {permit: permitCheck2.permit, autoApproved: true};
        } else {
          stepResult.status = 'pending';
          stepResult.pendingAction = 'permit_required';
        }
        break;
      case 'execute_swap':
      case 'execute_bridge':
      case 'execute_treasury':
      case 'execute_payment':
        stepResult.data = {executed: 'simulated', tx: null};
        // Record usage on permit if exists
        var pc = PE.checkCoverage({operation: stepType.replace('execute_',''),amount:params.amount||0,asset:params.asset||'USDC'});
        if(pc.covered && pc.permit){
          PE.recordUsage(pc.permit.id, params.amount||0, stepType.replace('execute_',''), 'success');
        }
        break;
      case 'wait_confirm':
        stepResult.data = {waited: true};
        break;
      case 'verify_balances':
        stepResult.data = {balances: 'verified'};
        break;
      case 'generate_receipt':
        stepResult.data = {receipt: {id: 'rct_' + Date.now(), plan: plan.id, timestamp: Date.now()}};
        break;
      case 'notify':
        stepResult.data = {notified: true};
        break;
    }

    return stepResult;
  }

  /* ── Estimate for display ── */
  function estimateSteps(steps){
    var total = 0;
    for(var i=0;i<steps.length;i++) total += STEP_ESTIMATES[steps[i]] || 2;
    return total;
  }

  function fmtDuration(seconds){
    if(seconds < 60) return seconds + ' seconds';
    if(seconds < 3600) return Math.floor(seconds/60) + 'm ' + (seconds%60) + 's';
    return '~' + Math.round(seconds/60) + ' minutes';
  }

  window.ExecutionPlanner = {
    buildWorkflow: buildWorkflow,
    executeStep: executeStep,
    estimateSteps: estimateSteps,
    fmtDuration: fmtDuration,
    STEP_TYPES: STEP_TYPES,
    STEP_LABELS: STEP_LABELS,
    STEP_ICONS: STEP_ICONS,
    STEP_ESTIMATES: STEP_ESTIMATES
  };
})();
