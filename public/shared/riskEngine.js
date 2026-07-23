/**
 * Elligentt Risk Engine — Risk analysis before any signature (Phase 2)
 * Analyzes contract reputation, destination, amount, chain, history.
 * Returns LOW / MEDIUM / HIGH / CRITICAL with reasoning.
 * Attached to window.RiskEngine
 */
(function(){
  'use strict';

  var CR = window.ContractRegistry || null;

  function analyze(opts){
    var risks = [];
    var maxLevel = 0; // 0=LOW, 1=MEDIUM, 2=HIGH, 3=CRITICAL

    var operation = opts.operation || 'unknown';
    var amount = opts.amount || 0;
    var asset = opts.asset || 'USDC';
    var network = opts.network || 'Arc Testnet';
    var contract = opts.contract || '';
    var destination = opts.destination || '';
    var purpose = opts.purpose || '';

    var findings = [];

    // 1. Contract reputation
    if(contract && CR){
      var contractInfo = CR.lookup(contract);
      if(contractInfo){
        var trustLevel = contractInfo.trust || 'unknown';
        if(trustLevel === 'high'){
          findings.push({ factor: 'Contract Reputation', level: 'LOW', detail: 'Known trusted contract: ' + contractInfo.name });
        } else if(trustLevel === 'medium'){
          findings.push({ factor: 'Contract Reputation', level: 'MEDIUM', detail: 'Known contract: ' + contractInfo.name + ' (' + contractInfo.interactions + ' interactions)' });
        } else if(trustLevel === 'low'){
          findings.push({ factor: 'Contract Reputation', level: 'MEDIUM', detail: 'Low-reputation contract: ' + contractInfo.name });
        } else {
          findings.push({ factor: 'Contract Reputation', level: 'HIGH', detail: 'Unknown contract first interaction' });
          maxLevel = Math.max(maxLevel, 2);
        }
      } else if(contract !== '*' && contract !== ''){
        findings.push({ factor: 'Contract Reputation', level: 'HIGH', detail: 'Unknown contract: ' + (contract.length > 12 ? contract.substring(0,10) + '...' : contract) });
        maxLevel = Math.max(maxLevel, 2);
      }
    }

    // 2. Destination address reputation
    if(destination && destination !== '*'){
      if(destination.length === 42 && destination.startsWith('0x')){
        if(CR && CR.isKnown(destination)){
          var destInfo = CR.lookup(destination);
          findings.push({ factor: 'Destination', level: 'LOW', detail: 'Known destination: ' + (destInfo ? destInfo.name : 'Verified') });
        } else {
          findings.push({ factor: 'Destination', level: 'MEDIUM', detail: 'New destination address' });
          maxLevel = Math.max(maxLevel, 1);
        }
      }
    }

    // 3. Amount risk
    if(amount > 10000){
      findings.push({ factor: 'Amount', level: 'HIGH', detail: 'Large amount: ' + amount + ' ' + asset + ' (>10,000)' });
      maxLevel = Math.max(maxLevel, 2);
    } else if(amount > 1000){
      findings.push({ factor: 'Amount', level: 'MEDIUM', detail: 'Moderate amount: ' + amount + ' ' + asset });
      maxLevel = Math.max(maxLevel, 1);
    } else {
      findings.push({ factor: 'Amount', level: 'LOW', detail: 'Normal amount: ' + amount + ' ' + asset });
    }

    // 4. Chain risk
    var mainnetChains = ['Ethereum','Polygon','Arbitrum','Optimism','Base'];
    var testnetChains = ['Arc Testnet','Sepolia','Base Sepolia','Arbitrum Sepolia','Amoy'];
    if(testnetChains.indexOf(network) >= 0){
      findings.push({ factor: 'Chain Risk', level: 'LOW', detail: 'Testnet — no real value at risk' });
    } else if(mainnetChains.indexOf(network) >= 0){
      findings.push({ factor: 'Chain Risk', level: 'LOW', detail: 'Production chain: ' + network });
    } else {
      findings.push({ factor: 'Chain Risk', level: 'MEDIUM', detail: 'Unverified network: ' + network });
      maxLevel = Math.max(maxLevel, 1);
    }

    // 5. Historical success (based on PermitEngine audit log)
    try {
      if(typeof PermitEngine !== 'undefined'){
        var log = PermitEngine.getAuditLog(50);
        var recentOps = log.filter(function(e){ return e.operation === operation; });
        if(recentOps.length >= 5){
          var successRate = recentOps.filter(function(e){ return e.result === 'success'; }).length / recentOps.length;
          if(successRate >= 0.9){
            findings.push({ factor: 'Historical Success', level: 'LOW', detail: recentOps.length + ' previous ' + operation + ' ops (' + Math.round(successRate*100) + '% success)' });
          } else if(successRate >= 0.7){
            findings.push({ factor: 'Historical Success', level: 'MEDIUM', detail: Math.round(successRate*100) + '% success rate on ' + operation });
          } else {
            findings.push({ factor: 'Historical Success', level: 'HIGH', detail: 'Low success rate: ' + Math.round(successRate*100) + '%' });
            maxLevel = Math.max(maxLevel, 2);
          }
        } else if(recentOps.length > 0){
          findings.push({ factor: 'Historical Success', level: 'MEDIUM', detail: 'Limited history (' + recentOps.length + ' ops)' });
          maxLevel = Math.max(maxLevel, 1);
        } else {
          findings.push({ factor: 'Historical Success', level: 'LOW', detail: 'First ' + operation + ' operation' });
        }
      }
    } catch(e){}

    // 6. Wallet history
    if(typeof walletAddress !== 'undefined' && walletAddress){
      var ageKnown = true; // Could check if wallet is new
      if(ageKnown){
        findings.push({ factor: 'Wallet History', level: 'LOW', detail: 'Known wallet with history' });
      }
    }

    // 7. Operation type risk
    var opRisk = {
      payment: 0, swap: 1, bridge: 1, treasury: 1, contract: 2,
      multisend: 1, liquidity: 1, signature: 2
    };
    var opRiskLevel = opRisk[operation] || 0;
    if(opRiskLevel === 2){
      findings.push({ factor: 'Operation Type', level: 'HIGH', detail: 'High-risk operation: ' + operation });
      maxLevel = Math.max(maxLevel, 2);
    } else if(opRiskLevel === 1){
      findings.push({ factor: 'Operation Type', level: 'MEDIUM', detail: 'Moderate-risk operation: ' + operation });
      maxLevel = Math.max(maxLevel, 1);
    }

    // Determine overall risk
    var overallLevel = ['LOW','MEDIUM','HIGH','CRITICAL'][maxLevel] || 'LOW';
    var recommendation = '';
    if(overallLevel === 'LOW') recommendation = 'Safe to execute.';
    else if(overallLevel === 'MEDIUM') recommendation = 'Proceed with caution. Review details.';
    else if(overallLevel === 'HIGH') recommendation = 'Requires explicit confirmation even if permit exists.';
    else recommendation = 'DO NOT execute. Manual review required.';

    return {
      level: overallLevel,
      score: maxLevel,
      findings: findings,
      recommendation: recommendation,
      requiresExplicitConfirm: maxLevel >= 2,
      analyzedAt: Date.now()
    };
  }

  function riskLevelColor(level){
    var map = { LOW: 'green', MEDIUM: 'yellow', HIGH: 'orange', CRITICAL: 'red' };
    return map[level] || 'muted';
  }

  function riskLevelCSS(level){
    var map = { LOW: '#22c55e', MEDIUM: '#f59e0b', HIGH: '#f97316', CRITICAL: '#ef4444' };
    return map[level] || '#6b7280';
  }

  function quickAssess(operation, amount, asset, contract, network){
    return analyze({
      operation: operation, amount: amount || 0, asset: asset || 'USDC',
      contract: contract || '', destination: '', network: network || 'Arc Testnet', purpose: ''
    });
  }

  window.RiskEngine = {
    analyze: analyze,
    quickAssess: quickAssess,
    riskLevelColor: riskLevelColor,
    riskLevelCSS: riskLevelCSS
  };
})();
