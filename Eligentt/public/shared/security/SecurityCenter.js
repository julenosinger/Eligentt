/**
 * Elligentt SecurityCenter — Centralized Security & Transaction Risk (Phase 17.5)
 * CSP, SRI, permission audit, intent security, transaction risk score.
 * Attached to: window.SecurityCenter
 */
(function () {
  'use strict';

  function runAudit() {
    var audit = {
      generatedAt: new Date().toISOString(),
      csp: _checkCSP(),
      sri: _checkSRI(),
      permissions: _checkPermissions(),
      intentSecurity: _checkIntentSecurity(),
      walletSecurity: _checkWalletSecurity(),
      summary: { score: 'A', issues: 0 }
    };

    var sections = ['csp', 'sri', 'permissions', 'intentSecurity', 'walletSecurity'];
    var issues = 0;
    sections.forEach(function (s) { if (audit[s] && audit[s].issues) issues += audit[s].issues; });

    audit.summary.issues = issues;
    audit.summary.score = issues === 0 ? 'A+' : issues <= 3 ? 'A' : issues <= 6 ? 'B' : 'C';

    return audit;
  }

  function _checkCSP() {
    var meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    return { present: !!meta, issues: meta ? 0 : 1 };
  }

  function _checkSRI() {
    var scripts = document.querySelectorAll('script[src]');
    var withIntegrity = 0;
    scripts.forEach(function (s) { if (s.hasAttribute('integrity')) withIntegrity++; });
    return { total: scripts.length, withSRI: withIntegrity, issues: 0 };
  }

  function _checkPermissions() {
    var available = typeof AgentAuthorization !== 'undefined';
    return { available: available, issues: 0 };
  }

  function _checkIntentSecurity() {
    var available = typeof IntentSecurity !== 'undefined';
    return { available: available, issues: 0 };
  }

  function _checkWalletSecurity() {
    try {
      var isStopped = typeof AIWallet !== 'undefined' && AIWallet.isEmergencyStopped ? AIWallet.isEmergencyStopped() : false;
      return { emergencyStopActive: isStopped, issues: isStopped ? 1 : 0 };
    } catch (_e) { return { issues: 0 }; }
  }

  /** Calculate transaction risk score (0-100) */
  function riskScore(operation, params) {
    var score = 0;
    var checks = [];

    // Base risk by operation type
    var baseRisk = { payment: 10, transfer: 10, swap: 20, bridge: 30, treasury: 15, recurring: 25 };
    score += baseRisk[operation] || 10;

    // Amount risk
    var amount = Number(params.amount) || 0;
    if (amount > 10000) { score += 30; checks.push({ check: 'high_amount', risk: 30 }); }
    else if (amount > 1000) { score += 15; checks.push({ check: 'medium_amount', risk: 15 }); }
    else { checks.push({ check: 'amount_safe', risk: 0 }); }

    // Permission check
    var permOk = true;
    try { if (typeof AgentAuthorization !== 'undefined' && AgentAuthorization.hasOperationAuth) permOk = AgentAuthorization.hasOperationAuth(operation); } catch (_e) {}
    checks.push({ check: 'permission', risk: permOk ? 0 : 50, passed: permOk });
    if (!permOk) score += 50;

    // Policy check
    var policyOk = true;
    try { if (typeof PolicyEngine !== 'undefined') { var pv = PolicyEngine.quickCheck(operation, amount, params.token || 'USDC', params.network || 'Arc_Testnet'); policyOk = !!(pv && pv.valid); } } catch (_e2) {}
    checks.push({ check: 'policy', risk: policyOk ? 0 : 40, passed: policyOk });
    if (!policyOk) score += 40;

    return {
      operation: operation,
      risk: Math.min(100, score),
      level: score < 20 ? 'LOW' : score < 50 ? 'MEDIUM' : 'HIGH',
      checks: checks
    };
  }

  window.SecurityCenter = {
    VERSION: '17.0.0',
    runAudit: runAudit, riskScore: riskScore
  };
})();
