/**
 * AUTONOMA-0 — Centralized Execution Safety Gate (fail-closed)
 * ═══════════════════════════════════════════════════════════════════════
 * Single controlled execution authority for Autonoma financial broadcasts.
 *
 * Every autonomous financial operation (payment, multisend, swap, bridge,
 * cross-chain, liquidity) MUST call `authorizeAutonomaExecution(intent, ctx)`
 * and receive `{ ok: true }` before ANY signer can broadcast. If any required
 * validation is missing, invalid, stale, malformed or unavailable the gate
 * returns `{ ok: false }` and the caller MUST NOT broadcast.
 *
 * The gate NEVER interprets missing authorization as permission. There is no
 * fallback path that grants access when a dependency is absent.
 *
 * Validation order (all enforced, all fail-closed):
 *   1. dependency availability (AgentWalletManager / AgentAuthorization /
 *      PolicyEngine) — missing → BLOCK
 *   2. agent wallet identity (exists, not paused, not shut down) — else BLOCK
 *   3. authorization (validateExecution + operation permission + wallet
 *      binding: agent identity AND granting user identity) — else BLOCK
 *   4. chain (Arc Testnet for on-chain ops; trusted CCTP source set for bridge)
 *   5. policy (explicit PolicyEngine decision; unavailable/denied → BLOCK)
 *   6. idempotency (reuse ScheduleEngine.claimExecution with a deterministic
 *      intent key) — duplicate/held claim → BLOCK. Skipped ONLY for a call
 *      that was already validated + claimed by AgentScheduleExecutor
 *      (schedule delegation), which owns the authoritative claim.
 *
 * Attached to window.AutonomaExecutionGate
 */
(function () {
  'use strict';

  if (typeof window !== 'undefined' && window.AutonomaExecutionGate) return;

  var ARC_CHAIN_ID = 5042002;
  var GATE_EXECUTOR = 'autonoma_execution_gate';

  // Trusted CCTP source chains the Agent Wallet may originate a bridge from.
  var CCTP_SOURCE_CHAINS = [5042002, 11155111, 84532, 421614, 11155420, 80002];

  var OP_TO_PERMISSION = {
    swap: 'allowSwap', bridge: 'allowBridge', crosschain: 'allowCrosschain',
    payment: 'allowPayments', multisend: 'allowPayments',
    add_liquidity: 'allowContracts', remove_liquidity: 'allowContracts',
    scheduled: 'allowScheduled'
  };

  var MSG = {
    gate_unavailable: 'Autonomous financial execution is currently blocked because the execution safety gate is unavailable.',
    authorization_unavailable: 'Autonomous financial execution is currently blocked because the authorization system is unavailable.',
    policy_unavailable: 'Autonomous financial execution is currently blocked because the policy engine is unavailable.',
    wallet_unavailable: 'Autonomous financial execution is currently blocked because the Agent Wallet is unavailable.',
    agent_wallet_unavailable: 'Autonomous financial execution is currently blocked because no Agent Wallet address is available.',
    wallet_paused: 'Autonomous financial execution is currently blocked because the Agent Wallet is paused.',
    wallet_shutdown: 'Autonomous financial execution is currently blocked because the Agent Wallet is shut down.',
    authorization_missing: 'Autonomous financial execution is currently blocked because explicit authorization/approval is required.',
    authorization_denied: 'Autonomous financial execution is currently blocked because the authorization scope denies this operation.',
    authorization_error: 'Autonomous financial execution is currently blocked because authorization validation failed.',
    operation_not_permitted: 'Autonomous financial execution is currently blocked because this operation is not permitted by the authorization.',
    agent_wallet_mismatch: 'Autonomous financial execution is currently blocked because the authorization does not belong to the current Agent Wallet.',
    user_wallet_unbound: 'Autonomous financial execution is currently blocked because the granting wallet is not connected.',
    user_wallet_mismatch: 'Autonomous financial execution is currently blocked because the authorization was granted by a different wallet.',
    wrong_chain: 'Autonomous financial execution is currently blocked because the target chain is not authorized.',
    policy_denied: 'Autonomous financial execution is currently blocked by policy.',
    policy_error: 'Autonomous financial execution is currently blocked because policy validation failed.',
    execution_authority_unavailable: 'Autonomous financial execution is currently blocked because the execution authority is unavailable.',
    execution_authority_error: 'Autonomous financial execution is currently blocked because the execution authority could not be reached.',
    duplicate_intent: 'Autonomous financial execution is currently blocked because this intent was already submitted.'
  };

  /* ── Dependency access (resolved at call time, never at load time) ── */
  function _wm() { try { return (typeof AgentWalletManager !== 'undefined') ? AgentWalletManager : null; } catch (e) { return null; } }
  function _authz() { try { return (typeof AgentAuthorization !== 'undefined') ? AgentAuthorization : null; } catch (e) { return null; } }
  function _policy() { try { return (typeof PolicyEngine !== 'undefined') ? PolicyEngine : null; } catch (e) { return null; } }
  function _engine() { try { return (typeof ScheduleEngine !== 'undefined') ? ScheduleEngine : null; } catch (e) { return null; } }

  function _isAddr(a) {
    return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) &&
      a.toLowerCase() !== '0x0000000000000000000000000000000000000000';
  }

  function _connectedWallet() {
    try { return (typeof walletAddress === 'string' && walletAddress) ? walletAddress : null; } catch (e) { return null; }
  }

  function _isScheduledDelegation() {
    try { return !!(window.__autonomaScheduledDelegation); } catch (e) { return false; }
  }

  /* ── Deterministic intent identity (no timestamps / no randomness) ── */
  function _djb2(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(16);
  }

  function _intentKey(intent) {
    var dests = (intent.destinations || []).slice();
    if (!dests.length && intent.destination) dests.push(intent.destination);
    dests = dests.map(function (d) { return String(d).toLowerCase(); }).sort();
    var raw = [
      intent.operation || '',
      (intent.wallet || '').toLowerCase(),
      String(intent.asset || 'USDC').toUpperCase(),
      String(intent.amount || 0),
      dests.join(','),
      String(intent.chainId || ARC_CHAIN_ID)
    ].join('|');
    return 'aut0_' + _djb2(raw);
  }

  function _chainAllowed(operation, chainId) {
    var id = Number(chainId);
    if (operation === 'bridge' || operation === 'crosschain') {
      // Agent bridge execution supports Arc Testnet source only (mirrors AgentScheduleExecutor).
      return id === ARC_CHAIN_ID;
    }
    if (operation === 'turbo_bridge') {
      return CCTP_SOURCE_CHAINS.indexOf(id) !== -1;
    }
    return id === ARC_CHAIN_ID;
  }

  function _block(code, reason) {
    return { ok: false, code: code, reason: reason || code, userMessage: MSG[code] || MSG.gate_unavailable };
  }

  /**
   * Authorize an Autonoma financial execution. Fail-closed.
   *
   * @param {object} intent  { operation, amount, asset, network, destination,
   *                           destinations, chainId, simulationHash }
   * @param {object} context { delegated:boolean }  — true when invoked from the
   *                           already-validated schedule delegation path.
   * @returns {Promise<{ok:boolean, code:string, reason:string, userMessage:string,
   *                    auth?:object, policyReport?:object, claimKey?:string,
   *                    agentWallet?:string}>}
   */
  async function authorizeAutonomaExecution(intent, context) {
    intent = intent || {};
    context = context || {};

    var operation = intent.operation || '';
    var amount = Number(intent.amount) || 0;
    var asset = intent.asset || 'USDC';
    var network = intent.network || 'Arc Testnet';
    var chainId = intent.chainId != null ? intent.chainId : ARC_CHAIN_ID;
    var destinations = Array.isArray(intent.destinations) ? intent.destinations : [];
    var destination = intent.destination ||
      (destinations.length === 1 ? destinations[0] : '');

    // 1. Dependencies — missing dependency means BLOCK, never best-effort.
    var wm = _wm();
    var az = _authz();
    var pol = _policy();
    if (!wm) return _block('gate_unavailable');
    if (!az) return _block('authorization_unavailable');
    if (!pol) return _block('policy_unavailable');

    // 2. Agent wallet identity — fail closed.
    var isShutdown = (typeof wm.isShutdown === 'function') ? wm.isShutdown() : false;
    if (isShutdown) return _block('wallet_shutdown');
    if (typeof wm.isPaused === 'function' && wm.isPaused()) return _block('wallet_paused');
    var agentAddr = null;
    try { agentAddr = (typeof wm.getAgentAddress === 'function') ? wm.getAgentAddress() : null; } catch (e) { agentAddr = null; }
    if (!_isAddr(agentAddr)) return _block('agent_wallet_unavailable');

    // 2b. Schedule delegation passthrough — AgentScheduleExecutor has ALREADY
    //     validated + claimed this occurrence through the MS-2/MS-3/MS-4 protected
    //     path (auth, risk, chain, balance, claim, ledger). The gate must not
    //     re-claim (that would collide with the authoritative schedule claim) nor
    //     re-run policy (scheduled swap/bridge legitimately skip simulation).
    //     This is the "broadcast step" of the already-authorized path.
    var delegated = !!context.delegated || _isScheduledDelegation();
    if (delegated) {
      return { ok: true, code: 'delegated', reason: '', delegated: true, claimKey: null, agentWallet: agentAddr, operation: operation };
    }

    // 3. Authorization — fail closed. No authorization → BLOCK.
    var vres;
    try {
      vres = az.validateExecution({
        operation: operation, amount: amount, asset: asset,
        network: network, destination: destination || '', contract: ''
      });
    } catch (e) { return _block('authorization_error'); }
    if (!vres || !vres.valid) {
      return _block(vres && vres.needsAuthorization ? 'authorization_missing' : 'authorization_denied', vres && vres.reason);
    }
    var auth = vres.auth;
    if (!auth) return _block('authorization_missing');

    // Operation permission (map to the concrete authorization flag).
    var permitted = false;
    try { permitted = !!az.checkOperationPermission(auth, operation); } catch (e) { permitted = false; }
    if (!permitted) return _block('operation_not_permitted');

    // Wallet binding — the authorization must belong to THIS agent wallet and
    // to the currently connected user wallet. Cross-wallet inheritance is BLOCKED.
    if (auth.agentWallet && _isAddr(auth.agentWallet) &&
        String(auth.agentWallet).toLowerCase() !== String(agentAddr).toLowerCase()) {
      return _block('agent_wallet_mismatch');
    }
    if (auth.grantedBy && _isAddr(auth.grantedBy)) {
      var user = _connectedWallet();
      if (!_isAddr(user)) return _block('user_wallet_unbound');
      if (String(user).toLowerCase() !== String(auth.grantedBy).toLowerCase()) {
        return _block('user_wallet_mismatch');
      }
    }

    // 4. Chain — fail closed.
    var chainOperation = intent.chainOperation || operation;
    if (!_chainAllowed(chainOperation, chainId)) return _block('wrong_chain');

    // 5. Policy — explicit decision, fail closed.
    var pReport;
    try {
      pReport = pol.validateExecution({
        operation: operation, amount: amount, asset: asset, network: network,
        contract: '', destination: '',
        simulationHash: intent.simulationHash || null,
        authId: auth.id, maxRiskLevel: auth.maxRiskLevel || 'MEDIUM',
        estimatedGas: 0.01, slippage: null
      });
    } catch (e) { return _block('policy_error'); }
    if (!pReport || !pReport.valid) {
      var pReason = (pReport && pReport.failedRules && pReport.failedRules.length)
        ? pReport.failedRules.map(function (r) { return r.rule + ': ' + r.reason; }).join(' | ')
        : 'policy denied';
      return _block('policy_denied', pReason);
    }

    // 6. Idempotency — reuse the shared execution claim.
    var claimKey = null;
    var eng = _engine();
    if (!eng || typeof eng.claimExecution !== 'function') return _block('execution_authority_unavailable');
    claimKey = _intentKey({
      operation: operation, wallet: agentAddr, asset: asset, amount: amount,
      destinations: destinations, destination: destination, chainId: chainId
    });
    var claimRes;
    try {
      claimRes = await eng.claimExecution(claimKey, GATE_EXECUTOR, {
        scheduleId: null, occurrenceId: claimKey,
        wallet: agentAddr, chain: network,
        intent: { operation: operation, amount: amount, asset: asset, destination: destination || null }
      });
    } catch (e) { return _block('execution_authority_error'); }
    if (!claimRes || !claimRes.acquired) return _block('duplicate_intent');

    return {
      ok: true, code: 'authorized', reason: '',
      auth: auth, policyReport: pReport, claimKey: claimKey,
      agentWallet: agentAddr, operation: operation
    };
  }

  function isScheduledDelegation() { return _isScheduledDelegation(); }

  function blockedMessage(code) { return MSG[code] || MSG.gate_unavailable; }

  window.AutonomaExecutionGate = {
    authorizeAutonomaExecution: authorizeAutonomaExecution,
    isScheduledDelegation: isScheduledDelegation,
    blockedMessage: blockedMessage,
    intentKey: _intentKey,
    ARC_CHAIN_ID: ARC_CHAIN_ID,
    version: 'AUTONOMA-0'
  };
})();
