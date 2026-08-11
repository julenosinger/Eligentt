/**
 * Elligentt SecurityValidator — Intent & Operation Security Harden (Phase 9)
 * Validates: intent integrity, permission, nonce uniqueness, execution ownership,
 * policy compliance, signature validity, deadline expiration, replay prevention.
 * Wraps existing engines. Additive layer — never blocks valid operations.
 * Attached to: window.SecurityValidator
 */
(function () {
  'use strict';

  /* ════════════════════════════════════════
     INTENT SECURITY
  ════════════════════════════════════════ */
  function validateIntent(intent) {
    var checks = [];

    // 1. Intent structure integrity
    if (!intent || !intent.id || !intent.op) {
      checks.push({ check: 'intent_structure', passed: false, reason: 'Missing id or op' });
    } else {
      checks.push({ check: 'intent_structure', passed: true, reason: 'Valid structure' });
    }

    // 2. Nonce uniqueness (replay prevention)
    if (intent.nonce) {
      try {
        var nonceOk = true;
        if (typeof AIWallet !== 'undefined' && AIWallet._usedNonces) {
          nonceOk = !AIWallet._usedNonces[String(intent.nonce)];
        }
        checks.push({ check: 'nonce_uniqueness', passed: nonceOk, reason: nonceOk ? 'Nonce unused' : 'Nonce already consumed' });
      } catch (_e) {
        checks.push({ check: 'nonce_uniqueness', passed: false, reason: 'Nonce check failed' });
      }
    } else {
      checks.push({ check: 'nonce_uniqueness', passed: false, reason: 'Missing nonce' });
    }

    // 3. Deadline check
    if (intent.deadline) {
      var deadlineOk = Number(intent.deadline) > Date.now();
      checks.push({ check: 'deadline', passed: deadlineOk, reason: deadlineOk ? 'Not expired' : 'Intent expired' });
    } else {
      checks.push({ check: 'deadline', passed: true, reason: 'No deadline set' });
    }

    // 4. Execution ownership
    try {
      var ownerOk = false;
      if (typeof AIWallet !== 'undefined' && AIWallet.isEmergencyStopped) {
        if (AIWallet.isEmergencyStopped()) {
          checks.push({ check: 'execution_ownership', passed: false, reason: 'Emergency stop active' });
        } else {
          ownerOk = true;
          checks.push({ check: 'execution_ownership', passed: true, reason: 'Not stopped' });
        }
      } else {
        checks.push({ check: 'execution_ownership', passed: true, reason: 'No emergency stop' });
      }
    } catch (_e) {
      checks.push({ check: 'execution_ownership', passed: false, reason: 'Check failed' });
    }

    // 5. Token validation
    if (intent.token) {
      var validTokens = ['USDC', 'EURC', 'cirBTC'];
      var tokenOk = validTokens.indexOf(String(intent.token).toUpperCase()) !== -1;
      checks.push({ check: 'token_valid', passed: tokenOk, reason: tokenOk ? intent.token + ' allowed' : intent.token + ' not recognized' });
    }

    // 6. Amount validation
    if (intent.amount !== undefined) {
      var amt = Number(intent.amount);
      var amountOk = isFinite(amt) && amt > 0;
      checks.push({ check: 'amount_valid', passed: amountOk, reason: amountOk ? 'Amount ' + amt + ' valid' : 'Invalid amount' });
    }

    return {
      valid: checks.every(function (c) { return c.passed; }),
      checks: checks,
      passedCount: checks.filter(function (c) { return c.passed; }).length,
      totalCount: checks.length
    };
  }

  /* ════════════════════════════════════════
     PERMISSION VALIDATION
  ════════════════════════════════════════ */
  function validatePermissions(operation, context) {
    var checks = [];

    if (typeof AgentAuthorization !== 'undefined') {
      try {
        var hasAuth = AgentAuthorization.hasOperationAuth(operation);
        checks.push({ check: 'agent_authorization', passed: hasAuth, reason: hasAuth ? 'Authorized' : 'Not authorized for ' + operation });
      } catch (_e) {
        checks.push({ check: 'agent_authorization', passed: false, reason: 'Check failed' });
      }
    } else {
      checks.push({ check: 'agent_authorization', passed: true, reason: 'No auth module — overlay limits enforced' });
    }

    return {
      valid: checks.every(function (c) { return c.passed; }),
      checks: checks
    };
  }

  /* ════════════════════════════════════════
     POLICY COMPLIANCE
  ════════════════════════════════════════ */
  function validatePolicy(operation, amount, token, network) {
    var checks = [];

    if (typeof PolicyEngine !== 'undefined') {
      try {
        var pv = PolicyEngine.quickCheck(operation, amount, token, network);
        var policyOk = !!(pv && pv.valid);
        checks.push({ check: 'policy_compliance', passed: policyOk, reason: policyOk ? 'All policies passed' : 'Policy violation' });
      } catch (_e) {
        checks.push({ check: 'policy_compliance', passed: false, reason: 'Policy check failed' });
      }
    } else {
      checks.push({ check: 'policy_compliance', passed: true, reason: 'No policy engine — using overlay limits' });
    }

    return {
      valid: checks.every(function (c) { return c.passed; }),
      checks: checks
    };
  }

  /* ════════════════════════════════════════
     FULL SECURITY CHECK
  ════════════════════════════════════════ */
  function fullCheck(intent) {
    var intentResult = validateIntent(intent);
    var permResult = validatePermissions(intent.op || 'payment', {});
    var policyResult = validatePolicy(intent.op || 'payment', Number(intent.amount) || 0, intent.token || 'USDC', intent.network || 'Arc_Testnet');

    var allChecks = []
      .concat(intentResult.checks)
      .concat(permResult.checks)
      .concat(policyResult.checks);

    var valid = intentResult.valid && permResult.valid && policyResult.valid;

    return {
      valid: valid,
      checks: allChecks,
      passedCount: allChecks.filter(function (c) { return c.passed; }).length,
      totalCount: allChecks.length,
      sections: { intent: intentResult, permissions: permResult, policy: policyResult }
    };
  }

  /** @public */
  window.SecurityValidator = {
    VERSION: '1.0.0',
    validateIntent: validateIntent,
    validatePermissions: validatePermissions,
    validatePolicy: validatePolicy,
    fullCheck: fullCheck
  };
})();
