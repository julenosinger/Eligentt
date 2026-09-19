/**
<<<<<<< HEAD
 * AutonomaExecutionGate — Chat financial-execution identity + policy/auth gate
 *
 * Chat-layer only. Does NOT modify ScheduleEngine / MS-2/MS-3/MS-4 claims.
 *
 * NEW user Chat action → unique executionId
 * Same Chat action routed twice → SAME executionId → one claim
 * Completed execution does NOT permanently block a NEW Chat command
 * with identical financial parameters.
=======
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
>>>>>>> c09da7105bf57fc05d85067c149a3a71a1b108cc
 *
 * Attached to window.AutonomaExecutionGate
 */
(function () {
  'use strict';

<<<<<<< HEAD
  var STORE_KEY = 'elligentt_autonoma_exec_gate_v1';
  var IN_FLIGHT_MS = 90000;
  var ARC_CHAIN_ID = 5042002;
  var SUPPORTED_CHAIN_IDS = [5042002, 11155111, 84532, 421614, 11155420, 80002];
  var DOMAIN_BY_CHAIN = {
    5042002: 26,
    11155111: 0,
    84532: 6,
    421614: 3,
    11155420: 2,
    80002: 7
  };

  function _store() {
    try {
      var r = localStorage.getItem(STORE_KEY);
      return r ? JSON.parse(r) : { byId: {}, inflightFp: {} };
    } catch (e) {
      return { byId: {}, inflightFp: {} };
    }
  }
  function _save(s) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) {}
  }

  function fingerprint(opts) {
    var dest = opts.destination || opts.recipient || '';
    if (typeof dest === 'string' && /^0x[a-fA-F0-9]{40}$/.test(dest)) dest = dest.toLowerCase();
    else dest = String(dest || '');
    return [
      opts.operation || '',
      String(opts.amount || ''),
      String(opts.asset || ''),
      dest,
      String(opts.sourceChainId || ''),
      String(opts.destChainId || opts.destDomain || '')
    ].join('|').toLowerCase();
  }

  function newExecutionId() {
    return 'chat_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }

  function resolveExecutionId(opts) {
    var s = _store();
    var now = Date.now();
    if (opts.executionId) {
      var rec = s.byId[opts.executionId];
      if (rec && (rec.status === 'submitted' || rec.status === 'executed' || rec.status === 'confirmed')) {
        return { ok: false, executionId: opts.executionId, reason: 'duplicate_intent', duplicate: true };
      }
      if (rec && rec.status === 'executing' && (now - rec.ts) < IN_FLIGHT_MS) {
        return { ok: false, executionId: opts.executionId, reason: 'duplicate_intent', duplicate: true };
      }
      return { ok: true, executionId: opts.executionId, created: !rec };
    }
    var fp = fingerprint(opts);
    var inflight = s.inflightFp[fp];
    if (inflight && inflight.executionId && (now - inflight.ts) < IN_FLIGHT_MS) {
      var irec = s.byId[inflight.executionId];
      if (irec && irec.status === 'executing') {
        return { ok: false, executionId: inflight.executionId, reason: 'duplicate_intent', duplicate: true };
      }
    }
    return { ok: true, executionId: newExecutionId(), created: true };
  }

  function claim(executionId, fp) {
    var s = _store();
    var now = Date.now();
    s.byId[executionId] = { ts: now, status: 'executing', fp: fp };
    s.inflightFp[fp] = { ts: now, executionId: executionId };
    var ids = Object.keys(s.byId);
    if (ids.length > 300) {
      ids.sort(function (a, b) { return (s.byId[a].ts || 0) - (s.byId[b].ts || 0); });
      for (var i = 0; i < ids.length - 300; i++) delete s.byId[ids[i]];
    }
    _save(s);
  }

  function markSubmitted(executionId, txHash) {
    var s = _store();
    var rec = s.byId[executionId] || { ts: Date.now() };
    rec.status = txHash ? 'submitted' : 'failed';
    rec.txHash = txHash || rec.txHash || null;
    rec.ts = Date.now();
    s.byId[executionId] = rec;
    if (rec.fp && s.inflightFp[rec.fp] && s.inflightFp[rec.fp].executionId === executionId) {
      delete s.inflightFp[rec.fp];
    }
    _save(s);
  }

  function markConfirmed(executionId, txHash) {
    var s = _store();
    var rec = s.byId[executionId] || { ts: Date.now() };
    rec.status = 'confirmed';
    rec.txHash = txHash || rec.txHash || null;
    rec.ts = Date.now();
    s.byId[executionId] = rec;
    if (rec.fp && s.inflightFp[rec.fp] && s.inflightFp[rec.fp].executionId === executionId) {
      delete s.inflightFp[rec.fp];
    }
    _save(s);
  }

  function markFailed(executionId) {
    var s = _store();
    var rec = s.byId[executionId];
    if (!rec) return;
    rec.status = 'failed';
    rec.ts = Date.now();
    if (rec.fp && s.inflightFp[rec.fp] && s.inflightFp[rec.fp].executionId === executionId) {
      delete s.inflightFp[rec.fp];
    }
    _save(s);
  }

  function isSupportedChain(chainId) {
    return SUPPORTED_CHAIN_IDS.indexOf(Number(chainId)) !== -1;
  }

  function isSupportedRoute(sourceChainId, destChainId) {
    var s = Number(sourceChainId);
    var d = Number(destChainId);
    if (!isSupportedChain(s) || !isSupportedChain(d)) return false;
    if (s === d) return false;
    return true;
  }

  function destChainIdFromDomain(domain) {
    var dom = Number(domain);
    var keys = Object.keys(DOMAIN_BY_CHAIN);
    for (var i = 0; i < keys.length; i++) {
      if (DOMAIN_BY_CHAIN[keys[i]] === dom) return Number(keys[i]);
    }
    return null;
  }

  function _mod(name) {
    try {
      if (typeof window !== 'undefined' && window[name] != null) return window[name];
      if (typeof globalThis !== 'undefined' && globalThis[name] != null) return globalThis[name];
    } catch (e) {}
    return null;
  }

  function evaluate(opts) {
    opts = opts || {};
    var operation = opts.operation || '';
    var wm = _mod('AgentWalletManager');
    var az = _mod('AgentAuthorization');
    var pe = _mod('PolicyEngine');

    if (!wm) return { ok: false, reason: 'Agent Wallet unavailable' };
    if (typeof wm.isShutdown === 'function' && wm.isShutdown()) return { ok: false, reason: 'Agent wallet is shut down' };
    if (typeof wm.isPaused === 'function' && wm.isPaused()) return { ok: false, reason: 'Agent wallet is paused' };
    var agentAddr = typeof wm.getAgentAddress === 'function' ? wm.getAgentAddress() : null;
    if (!agentAddr) return { ok: false, reason: 'Missing Agent Wallet' };

    if (!az) return { ok: false, reason: 'Authorization system unavailable' };
    if (typeof az.hasOperationAuth !== 'function' || !az.hasOperationAuth(operation)) {
      return { ok: false, reason: 'Agent is not authorized for ' + operation };
    }

    var userWallet = opts.userWallet || (typeof walletAddress === 'string' ? walletAddress : null);
    var active = typeof az.getActive === 'function' ? az.getActive() : [];
    if (!active || !active.length) {
      return { ok: false, reason: 'No active agent authorization for the current wallet' };
    }
    var matched = null;
    for (var i = 0; i < active.length; i++) {
      var a = active[i];
      if (a.grantedBy && userWallet && String(a.grantedBy).toLowerCase() !== String(userWallet).toLowerCase()) continue;
      if (a.agentWallet && String(a.agentWallet).toLowerCase() !== String(agentAddr).toLowerCase()) continue;
      matched = a;
      break;
    }
    if (!matched) {
      return { ok: false, reason: 'authorization was granted by a different wallet' };
    }

    var dest = opts.destination || '';
    if (dest && !/^0x[a-fA-F0-9]{40}$/.test(String(dest))) dest = '';
    var network = opts.network || 'Arc Testnet';
    var authCheck = az.validateExecution({
      operation: operation,
      amount: Number(opts.amount) || 0,
      asset: opts.asset || 'USDC',
      network: network,
      contract: opts.contract || '',
      destination: dest
    });
    if (!authCheck || !authCheck.valid) {
      return { ok: false, reason: (authCheck && authCheck.reason) || 'Authorization scope denied' };
    }

    if (!pe || typeof pe.validateExecution !== 'function') {
      return { ok: false, reason: 'Policy engine unavailable' };
    }
    var report;
    try {
      report = pe.validateExecution({
        operation: operation,
        amount: Number(opts.amount) || 0,
        asset: opts.asset || 'USDC',
        network: network,
        contract: opts.contract || '',
        destination: dest,
        simulationHash: opts.simulationHash || null,
        authId: matched.id,
        maxRiskLevel: matched.maxRiskLevel || 'MEDIUM'
      });
    } catch (e) {
      return { ok: false, reason: 'Policy engine error: ' + (e.message || e) };
    }
    if (!report || !report.valid) {
      var reasons = (report && report.failedRules) ? report.failedRules.map(function (r) { return r.rule + ': ' + r.reason; }).join(' | ') : '';
      return { ok: false, reason: 'Policy: ' + (reasons || (report && report.reason) || 'denied') };
    }

    if (operation === 'bridge' || operation === 'crosschain') {
      var src = opts.sourceChainId != null ? Number(opts.sourceChainId) : ARC_CHAIN_ID;
      var dst = opts.destChainId != null ? Number(opts.destChainId) : destChainIdFromDomain(opts.destDomain);
      if (dst == null && opts.destDomain != null) dst = destChainIdFromDomain(opts.destDomain);
      if (!isSupportedRoute(src, dst)) {
        return { ok: false, reason: 'Unsupported bridge route' };
      }
    }

    var idRes = resolveExecutionId(opts);
    if (!idRes.ok) return idRes;
    var fp = fingerprint(opts);
    claim(idRes.executionId, fp);
    return { ok: true, executionId: idRes.executionId, fp: fp, auth: matched };
  }

  var API = {
    evaluate: evaluate,
    resolveExecutionId: resolveExecutionId,
    fingerprint: fingerprint,
    markSubmitted: markSubmitted,
    markConfirmed: markConfirmed,
    markFailed: markFailed,
    isSupportedRoute: isSupportedRoute,
    isSupportedChain: isSupportedChain,
    destChainIdFromDomain: destChainIdFromDomain,
    newExecutionId: newExecutionId,
    SUPPORTED_CHAIN_IDS: SUPPORTED_CHAIN_IDS.slice(),
    DOMAIN_BY_CHAIN: DOMAIN_BY_CHAIN,
    version: '3.0.0'
  };

  if (typeof window !== 'undefined') window.AutonomaExecutionGate = API;
  else if (typeof globalThis !== 'undefined') globalThis.AutonomaExecutionGate = API;
=======
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
    // A NEW user Chat action carries a unique executionId, generated ONCE at the
    // Chat boundary and propagated unchanged through every internal hop (NLU /
    // router / adapters). That id — not the financial parameters — is what makes
    // two independent commands distinct. The same executionId routed twice MUST
    // collapse to the same claim key (idempotency). When no executionId is
    // supplied (legacy callers / schedule delegation), fall back to the
    // deterministic financial-parameter identity so existing behavior is preserved.
    if (intent.executionId && typeof intent.executionId === 'string' && intent.executionId.length) {
      return 'aut0_' + _djb2('exec:' + intent.executionId);
    }
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
    if (operation === 'bridge' || operation === 'crosschain' || operation === 'turbo_bridge') {
      // Agent bridge / cross-chain execution supports every CCTP source chain the
      // existing Bridge/CCTP implementation supports — Arc AND the trusted external
      // chains — in BOTH directions. The source chain is not hardcoded to Arc.
      // Unsupported source chains are rejected here (fail-closed) and never
      // fall through to a broadcast.
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
      destinations: destinations, destination: destination, chainId: chainId,
      executionId: intent.executionId || null
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
>>>>>>> c09da7105bf57fc05d85067c149a3a71a1b108cc
})();
