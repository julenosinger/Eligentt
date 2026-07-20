/**
 * Autonoma Agent Schedule Executor — Delegated Scheduled-Intent Execution
 * Executes due ScheduleEngine intents on-chain through the existing Agent Wallet.
 * The Agent Wallet is the ONLY execution layer. The user's keys are never used.
 *
 * Hard gates (all enforced BEFORE signing, every run):
 *   1. Active AgentAuthorization with allowScheduled=true (user opt-in, revocable)
 *   2. AgentAuthorization.validateExecution — spending / daily / token / network /
 *      recipient / time-window / max-uses limits
 *   3. Underlying operation permission (allowPayments / allowSwap / allowBridge...)
 *   4. PolicyEngine.validateExecution (when loaded)
 *   5. RiskEngine level vs authorization maxRiskLevel (when loaded)
 *   6. Chain check (Arc Testnet 5042002), balance check, gas ceiling,
 *      AgentWalletManager.validatePreExecution (TOCTOU + daily ops)
 *   7. eth_call simulation of every transfer before broadcast
 *   8. Persistent per-run ledger (schedId|nextRun) — replay protection
 * If any validation fails: abort, persist the reason, notify the user.
 * Attached to window.AgentScheduleExecutor
 */
(function(){
  'use strict';

  var LEDGER_KEY = 'elligentt_agent_sched_exec_v1';
  var NOTIF_KEY = 'elligentt_agent_sched_notifs_v1';
  var ENABLED_KEY = 'elligentt_agent_sched_enabled_v1';
  var ARC_CHAIN_ID = 5042002;
  var TICK_MS = 30000;
  var MISS_WINDOW_MS = 24 * 60 * 60 * 1000;
  var TX_GAS_LIMIT = 120000;
  var MAX_FEE_GWEI = '20';
  var PRIORITY_FEE_GWEI = '1';
  var GAS_MULTIPLIER = 1.5;
  var GAS_MAX_GWEI = 80;
  var SUPPORTED_TYPES = ['payment', 'multisend', 'swap', 'bridge', 'crosschain'];
  var MANUAL_TYPES = ['link_payment'];
  var RISK_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

  var FALLBACK_TOKENS = {
    USDC:   { address: '0x3600000000000000000000000000000000000000', decimals: 6 },
    EURC:   { address: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a', decimals: 6 },
    cirBTC: { address: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF', decimals: 8 }
  };

  var CCTP_FALLBACK_DOMAINS = {
    Ethereum_Sepolia: 0, Base_Sepolia: 6, Arbitrum_Sepolia: 3,
    Optimism_Sepolia: 2, Polygon_Amoy: 7
  };

  var _timer = null;
  var _ticking = false;
  var _inFlight = {};
  var ledger = {};
  var notifications = [];

  /* ── Persistence ── */
  function _loadLedger(){
    try { var r = localStorage.getItem(LEDGER_KEY); if (r) ledger = JSON.parse(r) || {}; } catch(e){ ledger = {}; }
    try { var n = localStorage.getItem(NOTIF_KEY); if (n) notifications = JSON.parse(n) || []; } catch(e){ notifications = []; }
  }

  function _saveLedger(){
    try {
      var keys = Object.keys(ledger);
      if (keys.length > 300) {
        keys.sort(function(a, b){ return (ledger[a].ts || 0) - (ledger[b].ts || 0); });
        for (var i = 0; i < keys.length - 300; i++) delete ledger[keys[i]];
      }
      localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger));
    } catch(e){}
  }

  function _saveNotifs(){
    try {
      if (notifications.length > 100) notifications.length = 100;
      localStorage.setItem(NOTIF_KEY, JSON.stringify(notifications));
    } catch(e){}
  }

  function isAutoEnabled(){
    try { return localStorage.getItem(ENABLED_KEY) !== 'off'; } catch(e){ return true; }
  }

  function setAutoEnabled(on){
    try { localStorage.setItem(ENABLED_KEY, on ? 'on' : 'off'); } catch(e){}
    return isAutoEnabled();
  }

  /* ── Dependency access (resolved at call time, never at load time) ── */
  function _engine(){
    try { return (typeof ScheduleEngine !== 'undefined' && ScheduleEngine) ? ScheduleEngine : null; } catch(e){ return null; }
  }
  function _authz(){
    try { return (typeof AgentAuthorization !== 'undefined') ? AgentAuthorization : null; } catch(e){ return null; }
  }
  function _wm(){
    try { return (typeof AgentWalletManager !== 'undefined') ? AgentWalletManager : null; } catch(e){ return null; }
  }
  function _ethers(){
    try { return (typeof ethers !== 'undefined') ? ethers : null; } catch(e){ return null; }
  }

  function _tokenInfo(symbol){
    var sym = symbol || 'USDC';
    try {
      if (typeof ElligenteContracts !== 'undefined') {
        if (sym === 'USDC') return { address: ElligenteContracts.USDC_ADDRESS, decimals: ElligenteContracts.USDC_DECIMALS || 6 };
        if (sym === 'EURC') return { address: ElligenteContracts.EURC_ADDRESS, decimals: ElligenteContracts.EURC_DECIMALS || 6 };
        if (sym === 'cirBTC') return { address: ElligenteContracts.CIRBTC_ADDRESS, decimals: ElligenteContracts.CIRBTC_DECIMALS || 8 };
      }
    } catch(e){}
    return FALLBACK_TOKENS[sym] || null;
  }

  function _policyDefaults(){
    try {
      if (typeof PolicyEngine !== 'undefined' && PolicyEngine.getDefaults) return PolicyEngine.getDefaults();
    } catch(e){}
    return { retryMax: 3, retryDelayMs: 30000, pauseOnFailure: true, notifyOnFailure: true, notifyOnSuccess: false, requireSimulation: true };
  }

  function _isAddr(a){
    return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) &&
      a.toLowerCase() !== '0x0000000000000000000000000000000000000000';
  }

  /* ── Notifications ── */
  function _notify(sched, kind, msg, type){
    var entry = {
      ts: Date.now(), scheduleId: sched ? sched.id : null,
      scheduleName: sched ? sched.name : null, kind: kind, message: msg, type: type || 'info'
    };
    notifications.unshift(entry);
    _saveNotifs();
    try { if (typeof toast === 'function') toast(msg, type || 'info'); } catch(e){}
    try {
      if (typeof document !== 'undefined') {
        document.dispatchEvent(new CustomEvent('AGENT_SCHEDULE_EVENT', { detail: entry }));
      }
    } catch(e){}
    try {
      if (typeof schLogEntry === 'function' && sched) {
        schLogEntry(sched.id, kind === 'executed' ? 'executed' : 'info', msg);
      }
    } catch(e){}
    try { if (typeof renderSchedules === 'function') renderSchedules(); } catch(e){}
  }

  /* ── Schedule helpers ── */
  function _execKey(sched){ return sched.id + '|' + sched.nextRun; }

  function _nextRunAfter(freq, fromIso){
    var d = new Date(fromIso);
    if (isNaN(d.getTime())) d = new Date();
    switch (freq) {
      case 'daily': d.setUTCDate(d.getUTCDate() + 1); break;
      case 'weekly': d.setUTCDate(d.getUTCDate() + 7); break;
      case 'biweekly': d.setUTCDate(d.getUTCDate() + 14); break;
      case 'monthly': d.setUTCMonth(d.getUTCMonth() + 1); break;
      default: return null;
    }
    return d.toISOString();
  }

  function _advanceSchedule(sched, note, status, txHash){
    var eng = _engine();
    if (!eng) return;
    var execCount = (sched.execCount || 0) + (status === 'executed' || status === 'delegated' ? 1 : 0);
    var history = (sched.executionHistory || []).slice();
    history.unshift({
      ts: new Date().toISOString(), status: status, note: note,
      txHash: txHash || null, executor: 'agent_wallet'
    });
    if (history.length > 50) history.length = 50;

    var next = sched.freq === 'once' ? null : _nextRunAfter(sched.freq, sched.nextRun || new Date().toISOString());
    while (next && (Date.now() - new Date(next).getTime()) > MISS_WINDOW_MS) {
      next = _nextRunAfter(sched.freq, next);
    }
    var newStatus = sched.status;
    if (sched.freq === 'once' || (sched.maxEx > 0 && execCount >= sched.maxEx) || !next) {
      newStatus = 'Completed';
      next = null;
    }
    eng.update(sched.id, { execCount: execCount, executionHistory: history, nextRun: next, status: newStatus });
  }

  function isEligible(sched){
    if (!sched || sched.status !== 'Active' || !sched.nextRun) return false;
    if (sched.agentExecution === false) return false;
    if (SUPPORTED_TYPES.indexOf(sched.type) === -1 && MANUAL_TYPES.indexOf(sched.type) === -1) return false;
    return new Date(sched.nextRun).getTime() <= Date.now();
  }

  function getDueSchedules(){
    var eng = _engine();
    if (!eng) return [];
    return eng.getAll().filter(isEligible);
  }

  function hasScheduledAuth(){
    var az = _authz();
    if (!az) return false;
    try {
      if (az.hasOperationAuth('scheduled')) return true;
      if (az.hasOperationAuth('payment')) return true;
      if (az.hasOperationAuth('swap')) return true;
      if (az.hasOperationAuth('bridge')) return true;
    } catch(e){ return false; }
    return false;
  }

  /* ── Validation pipeline (returns {ok, reason, auth, transfers, token} ) ── */
  async function _validateIntent(sched, provider, agentAddr){
    var az = _authz();
    var wm = _wm();
    var E = _ethers();
    if (!E) return { ok: false, reason: 'ethers unavailable' };
    if (!wm) return { ok: false, reason: 'AgentWalletManager unavailable' };
    if (!az) return { ok: false, reason: 'Authorization system unavailable' };
    if (wm.isShutdown && wm.isShutdown()) return { ok: false, reason: 'Agent wallet is shut down' };
    if (wm.isPaused()) return { ok: false, reason: 'Agent wallet is paused' };
    if (!hasScheduledAuth()) return { ok: false, reason: 'No active authorization for scheduled execution — say "allow agent to execute schedules" in Autonoma', needsAuthorization: true };

    var opMap = { payment: 'payment', multisend: 'payment', swap: 'swap', bridge: 'bridge', crosschain: 'crosschain' };
    var underlyingOp = opMap[sched.type];
    if (!underlyingOp) return { ok: false, reason: 'Type ' + sched.type + ' requires manual execution' };

    var token = sched.token || 'USDC';
    var tokenInfo = _tokenInfo(token);
    if (!tokenInfo || !_isAddr(tokenInfo.address)) return { ok: false, reason: 'Unknown token ' + token };

    var transfers = [];
    var total = 0;
    if (sched.type === 'payment' || sched.type === 'multisend') {
      var rcpts = (sched.recipients && sched.recipients.length) ? sched.recipients
        : (sched.address ? [{ addr: sched.address, amount: sched.amount || 0 }] : []);
      if (!rcpts.length) return { ok: false, reason: 'No recipients defined' };
      for (var i = 0; i < rcpts.length; i++) {
        var to = rcpts[i].addr || rcpts[i].address;
        var amt = parseFloat(rcpts[i].amount || sched.amount || 0);
        if (!_isAddr(to)) return { ok: false, reason: 'Invalid recipient #' + (i + 1) + ': ' + to };
        if (!(amt > 0)) return { ok: false, reason: 'Invalid amount for recipient #' + (i + 1) };
        transfers.push({ to: to, amount: amt });
        total += amt;
      }
    } else {
      total = parseFloat(sched.amount || 0);
      if (!(total > 0)) return { ok: false, reason: 'Invalid schedule amount' };
      if (sched.type === 'bridge' || sched.type === 'crosschain') {
        if ((sched.fromNetwork || 'Arc_Testnet') !== 'Arc_Testnet') {
          return { ok: false, reason: 'Agent bridge execution supports Arc Testnet source only' };
        }
      }
    }

    var vres = az.validateExecution({
      operation: 'scheduled', amount: total, asset: token,
      network: 'Arc Testnet', destination: transfers.length === 1 ? transfers[0].to : ''
    });
    if (!vres.valid) return { ok: false, reason: 'Authorization: ' + vres.reason, needsAuthorization: !!vres.needsAuthorization };
    var auth = vres.auth;
    if (!az.checkOperationPermission(auth, underlyingOp) && !az.checkOperationPermission(auth, 'scheduled')) {
      return { ok: false, reason: 'Authorization does not permit ' + underlyingOp + ' operations' };
    }
    if (transfers.length > 1 && auth.allowedRecipients && auth.allowedRecipients.indexOf('*') === -1) {
      for (var r = 0; r < transfers.length; r++) {
        if (auth.allowedRecipients.indexOf(transfers[r].to) === -1) {
          return { ok: false, reason: 'Recipient ' + transfers[r].to.slice(0, 10) + '... not in allowed list' };
        }
      }
    }

    try {
      if (typeof RiskEngine !== 'undefined' && RiskEngine.quickAssess) {
        var risk = RiskEngine.quickAssess('scheduled', total, token, '', 'Arc Testnet');
        var maxRisk = auth.maxRiskLevel || 'MEDIUM';
        if (risk && RISK_RANK[risk.level] > RISK_RANK[maxRisk]) {
          return { ok: false, reason: 'Risk ' + risk.level + ' exceeds authorized max ' + maxRisk };
        }
      }
    } catch(e){}

    var net;
    try { net = await provider.getNetwork(); } catch(e){ return { ok: false, reason: 'RPC unavailable: ' + (e.message || 'network error') }; }
    if (net && Number(net.chainId) !== ARC_CHAIN_ID) {
      return { ok: false, reason: 'Wrong chain: expected Arc Testnet (' + ARC_CHAIN_ID + '), got ' + Number(net.chainId) };
    }

    if (sched.type === 'payment' || sched.type === 'multisend' || sched.type === 'swap') {
      try {
        var erc20 = new E.Contract(tokenInfo.address, ['function balanceOf(address) view returns (uint256)'], provider);
        var bal = await erc20.balanceOf(agentAddr);
        var balFloat = parseFloat(E.formatUnits(bal, tokenInfo.decimals));
        if (balFloat < total) {
          return { ok: false, reason: 'Agent wallet balance ' + balFloat.toFixed(4) + ' ' + token + ' < required ' + total + ' — fund the agent wallet' };
        }
      } catch(e){ return { ok: false, reason: 'Balance check failed: ' + (e.message || 'read error').substring(0, 80) }; }
    }

    var maxFeeWei = E.parseUnits(MAX_FEE_GWEI, 'gwei');
    var txCount = Math.max(1, transfers.length);
    try {
      var native = await provider.getBalance(agentAddr);
      var gasBudget = maxFeeWei * BigInt(TX_GAS_LIMIT) * BigInt(txCount);
      if (native < gasBudget) {
        return { ok: false, reason: 'Agent wallet has insufficient native gas balance' };
      }
    } catch(e){}

    var pre = wm.validatePreExecution('scheduled', E.toBeHex(maxFeeWei), E.toBeHex(TX_GAS_LIMIT), agentAddr);
    if (!pre || !pre.ok) return { ok: false, reason: (pre && pre.reason) || 'Pre-execution validation failed' };

    return { ok: true, auth: auth, transfers: transfers, token: token, tokenInfo: tokenInfo, total: total, underlyingOp: underlyingOp };
  }

  /* ── Simulation: real eth_call for every transfer before broadcast ── */
  async function _simulateTransfers(provider, agentAddr, tokenInfo, transfers){
    var E = _ethers();
    var iface = new E.Interface(['function transfer(address to, uint256 amount) returns (bool)']);
    var artifacts = [];
    for (var i = 0; i < transfers.length; i++) {
      var data = iface.encodeFunctionData('transfer', [transfers[i].to, E.parseUnits(String(transfers[i].amount), tokenInfo.decimals)]);
      try {
        var res = await provider.call({ from: agentAddr, to: tokenInfo.address, data: data });
        artifacts.push(data + '::' + res);
        transfers[i]._calldata = data;
      } catch(simErr) {
        return { ok: false, reason: 'Simulation reverted for transfer #' + (i + 1) + ': ' + (simErr.shortMessage || simErr.message || 'revert').substring(0, 90) };
      }
    }
    var simHash;
    try { simHash = E.keccak256(E.toUtf8Bytes(artifacts.join('|'))); } catch(e){ simHash = '0xsim_' + Date.now(); }
    return { ok: true, simulationHash: simHash };
  }

  function _validatePolicy(sched, auth, total, token, simulationHash){
    try {
      if (typeof PolicyEngine === 'undefined' || !PolicyEngine.validateExecution) return { ok: true, report: null };
      var report = PolicyEngine.validateExecution({
        operation: 'scheduled', amount: total, asset: token, network: 'Arc Testnet',
        contract: '', destination: '', simulationHash: simulationHash,
        authId: auth.id, maxRiskLevel: auth.maxRiskLevel || 'MEDIUM',
        estimatedGas: 0.01, slippage: null
      });
      if (!report.valid) {
        var reasons = report.failedRules.map(function(r){ return r.rule + ': ' + r.reason; }).join(' | ');
        return { ok: false, reason: 'Policy: ' + reasons, report: report };
      }
      return { ok: true, report: report };
    } catch(e){ return { ok: true, report: null }; }
  }

  /* ── Broadcast one ERC-20 transfer signed by the Agent Wallet ── */
  async function _broadcastTransfer(provider, signer, agentAddr, tokenInfo, transfer){
    var E = _ethers();
    var feeData;
    try { feeData = await provider.getFeeData(); } catch(e){}
    var maxFee = feeData && feeData.maxFeePerGas ? BigInt(feeData.maxFeePerGas) : 0n;
    var maxPriorityFee = feeData && feeData.maxPriorityFeePerGas ? BigInt(feeData.maxPriorityFeePerGas) : 0n;
    var fallbackMaxFee = E.parseUnits(MAX_FEE_GWEI, 'gwei');
    var fallbackPriority = E.parseUnits(PRIORITY_FEE_GWEI, 'gwei');
    if (!maxFee || maxFee === 0n) {
      maxFee = fallbackMaxFee;
      maxPriorityFee = fallbackPriority;
    } else {
      maxFee = BigInt(Math.min(Number(E.formatUnits(maxFee * BigInt(Math.round(GAS_MULTIPLIER * 100)) / 100n, 'gwei')), GAS_MAX_GWEI)) > 0n
        ? (maxFee * BigInt(Math.round(GAS_MULTIPLIER * 100)) / 100n) : maxFee;
      if (!maxPriorityFee || maxPriorityFee === 0n) maxPriorityFee = fallbackPriority;
    }
    try {
      var gasEst = await provider.estimateGas({ from: agentAddr, to: tokenInfo.address, data: transfer._calldata });
      if (gasEst) TX_GAS_LIMIT = Math.min(Math.floor(Number(gasEst) * 1.3), 300000);
    } catch(e){}
    var nonce = await provider.send('eth_getTransactionCount', [agentAddr, 'pending']);
    var rawTx = {
      type: 2, chainId: ARC_CHAIN_ID, to: tokenInfo.address,
      data: transfer._calldata, value: '0x0',
      gasLimit: E.toBeHex(TX_GAS_LIMIT), nonce: nonce,
      maxFeePerGas: E.toBeHex(maxFee),
      maxPriorityFeePerGas: E.toBeHex(maxPriorityFee)
    };
    var signedTx = await signer.signTransaction(rawTx);
    var txHash = await provider.send('eth_sendRawTransaction', [signedTx]);
    var receipt = await provider.waitForTransaction(txHash, 1, 60000);
    if (!receipt || receipt.status !== 1) {
      return { ok: false, txHash: txHash, reason: 'Transaction reverted on-chain', receipt: receipt };
    }
    return { ok: true, txHash: txHash, receipt: receipt };
  }

  function _recordOutcome(sched, auth, total, token, result, txHash, duration, gasUsed, reason){
    var az = _authz();
    var wm = _wm();
    try { if (az && auth && result === 'success') az.recordUsage(auth.id, total, 'scheduled:' + sched.type, 'success'); } catch(e){}
    try {
      if (typeof AgentAudit !== 'undefined') AgentAudit.recordExecution({
        operation: 'scheduled:' + sched.type, amount: total, asset: token, chain: 'Arc Testnet',
        transactionHash: txHash || '', result: result, duration: duration || 0, gasUsed: gasUsed || 0,
        authorizationId: auth ? auth.id : null, error: reason || null,
        metadata: { scheduleId: sched.id, scheduleName: sched.name, executor: 'AgentScheduleExecutor' }
      });
    } catch(e){}
    try {
      if (typeof ExecutionHistory !== 'undefined') ExecutionHistory.recordExecution({
        operation: 'scheduled:' + sched.type, amount: total, asset: token, chain: 'Arc Testnet',
        txHash: txHash || '', result: result === 'success' ? 'success' : 'failed', duration: duration || 0,
        displayText: 'Schedule "' + sched.name + '" — ' + total + ' ' + token + ' (' + result + ')'
      });
    } catch(e){}
    try {
      if (typeof AgentReputation !== 'undefined') {
        if (result === 'success') AgentReputation.recordSuccess('scheduled', duration || 0, 0);
        else AgentReputation.recordFailure('scheduled', reason || '');
      }
    } catch(e){}
    try {
      if (wm) {
        wm.recordExecution(result === 'success' ? 'success' : 'failed', duration || 0);
        if (result === 'success') wm.recordOperationSuccess('payment');
      }
    } catch(e){}
  }

  /* ── Execute a single due schedule ── */
  async function _executeSchedule(sched){
    var key = _execKey(sched);
    if (_inFlight[key]) return { status: 'in_flight' };
    var prior = ledger[key];
    if (prior && prior.status === 'awaiting_auth') {
      if (!hasScheduledAuth()) return { status: 'awaiting_auth' };
    } else if (prior && prior.status !== 'retry_pending') {
      return { status: 'replay_blocked' };
    }

    var defaults = _policyDefaults();
    if (prior && prior.status === 'retry_pending') {
      if ((prior.attempts || 0) >= (defaults.retryMax || 3)) {
        ledger[key] = { status: 'failed', reason: prior.reason || 'Retries exhausted', ts: Date.now(), attempts: prior.attempts };
        _saveLedger();
        _advanceSchedule(sched, 'Failed after ' + prior.attempts + ' attempts: ' + (prior.reason || ''), 'failed');
        if (defaults.pauseOnFailure) { try { _engine().update(sched.id, { status: 'Paused' }); } catch(e){} }
        _notify(sched, 'failed', 'Schedule "' + sched.name + '" failed after ' + prior.attempts + ' attempts — ' + (defaults.pauseOnFailure ? 'paused' : 'skipped'), 'error');
        return { status: 'failed_final' };
      }
      if (Date.now() - (prior.lastAttempt || 0) < (defaults.retryDelayMs || 30000)) return { status: 'retry_waiting' };
    }

    var overdueMs = Date.now() - new Date(sched.nextRun).getTime();
    if (overdueMs > MISS_WINDOW_MS) {
      ledger[key] = { status: 'skipped_stale', reason: 'Missed execution window (>24h overdue)', ts: Date.now() };
      _saveLedger();
      _advanceSchedule(sched, 'Skipped: missed execution window by ' + Math.round(overdueMs / 3600000) + 'h', 'skipped');
      _notify(sched, 'skipped', 'Schedule "' + sched.name + '" missed its execution window and was skipped (deadline protection)', 'warning');
      return { status: 'skipped_stale' };
    }

    if (MANUAL_TYPES.indexOf(sched.type) !== -1) {
      if (!prior) {
        ledger[key] = { status: 'manual_required', reason: sched.type + ' requires manual execution', ts: Date.now() };
        _saveLedger();
        _notify(sched, 'manual', 'Schedule "' + sched.name + '" (' + sched.type + ') is due — open the Schedules tab to run it manually', 'warning');
      }
      return { status: 'manual_required' };
    }

    _inFlight[key] = true;
    var startTime = Date.now();
    var attempts = ((prior && prior.attempts) || 0) + 1;

    try {
      var wm = _wm();
      var provider = wm ? wm.getAgentProvider() : null;
      var signer = wm ? await wm.getSessionSigner(provider) : null;
      if (!provider || !signer) {
        ledger[key] = { status: 'retry_pending', reason: 'Agent wallet signer unavailable', ts: Date.now(), attempts: attempts, lastAttempt: Date.now() };
        _saveLedger();
        return { status: 'retry_pending' };
      }
      var agentAddr = signer.address;

      var v = await _validateIntent(sched, provider, agentAddr);
      if (!v.ok) {
        if (v.needsAuthorization) {
          var firstNotice = !prior || prior.status !== 'awaiting_auth';
          ledger[key] = { status: 'awaiting_auth', reason: v.reason, ts: Date.now(), attempts: attempts };
          _saveLedger();
          _recordOutcome(sched, v.auth, v.total || sched.amount || 0, sched.token || 'USDC', 'unauthorized', null, Date.now() - startTime, 0, v.reason);
          if (firstNotice) _notify(sched, 'blocked', 'Agent cannot execute "' + sched.name + '": ' + v.reason, 'warning');
          return { status: 'awaiting_auth', reason: v.reason };
        }
        ledger[key] = { status: 'retry_pending', reason: v.reason, ts: Date.now(), attempts: attempts, lastAttempt: Date.now() };
        _saveLedger();
        _recordOutcome(sched, v.auth, v.total || sched.amount || 0, sched.token || 'USDC', 'failed', null, Date.now() - startTime, 0, v.reason);
        if (attempts >= (defaults.retryMax || 3)) {
          _notify(sched, 'failed', 'Validation failed for "' + sched.name + '": ' + v.reason, 'error');
        }
        return { status: 'validation_failed', reason: v.reason };
      }

      if (sched.type === 'swap' || sched.type === 'bridge' || sched.type === 'crosschain') {
        return await _delegateExecution(sched, key, v, startTime);
      }

      var sim = await _simulateTransfers(provider, agentAddr, v.tokenInfo, v.transfers);
      if (!sim.ok) {
        ledger[key] = { status: 'retry_pending', reason: sim.reason, ts: Date.now(), attempts: attempts, lastAttempt: Date.now() };
        _saveLedger();
        if (attempts >= (defaults.retryMax || 3)) _notify(sched, 'failed', 'Simulation failed for "' + sched.name + '": ' + sim.reason, 'error');
        return { status: 'simulation_failed', reason: sim.reason };
      }

      var pol = _validatePolicy(sched, v.auth, v.total, v.token, sim.simulationHash);
      if (!pol.ok) {
        ledger[key] = { status: 'blocked', reason: pol.reason, ts: Date.now(), attempts: attempts };
        _saveLedger();
        _advanceSchedule(sched, 'Blocked by policy: ' + pol.reason, 'failed');
        if (defaults.pauseOnFailure) { try { _engine().update(sched.id, { status: 'Paused' }); } catch(e){} }
        _recordOutcome(sched, v.auth, v.total, v.token, 'failed', null, Date.now() - startTime, 0, pol.reason);
        _notify(sched, 'blocked', 'Policy blocked "' + sched.name + '": ' + pol.reason, 'error');
        return { status: 'policy_blocked', reason: pol.reason };
      }

      var task = null;
      try {
        if (typeof ExecutionQueue !== 'undefined') {
          task = ExecutionQueue.enqueue({ type: 'scheduled', operation: 'scheduled:' + sched.type, amount: v.total, asset: v.token, destination: v.transfers.length === 1 ? v.transfers[0].to : v.transfers.length + ' recipients' });
          ExecutionQueue.updateStatus(task.id, 'running');
        }
      } catch(e){}

      ledger[key] = { status: 'broadcasting', ts: Date.now(), attempts: attempts };
      _saveLedger();

      var confirmed = 0;
      var spent = 0;
      var lastHash = '';
      var gasUsed = 0;
      for (var i = 0; i < v.transfers.length; i++) {
        var br;
        try {
          br = await _broadcastTransfer(provider, signer, agentAddr, v.tokenInfo, v.transfers[i]);
        } catch(txErr) {
          br = { ok: false, reason: (txErr.shortMessage || txErr.message || 'broadcast error').substring(0, 120), txHash: '' };
        }
        if (!br.ok) {
          var failNote = 'Transfer ' + (i + 1) + '/' + v.transfers.length + ' failed: ' + br.reason + (confirmed > 0 ? ' (' + confirmed + ' confirmed before failure)' : '');
          ledger[key] = { status: 'failed', reason: failNote, ts: Date.now(), attempts: attempts, txHash: br.txHash || lastHash };
          _saveLedger();
          if (spent > 0) { try { _authz().recordUsage(v.auth.id, spent, 'scheduled:' + sched.type, 'partial'); } catch(e){} }
          _advanceSchedule(sched, failNote, 'failed', br.txHash || lastHash);
          if (defaults.pauseOnFailure) { try { _engine().update(sched.id, { status: 'Paused' }); } catch(e){} }
          _recordOutcome(sched, null, spent, v.token, 'failed', br.txHash || lastHash, Date.now() - startTime, gasUsed, failNote);
          try { if (task) ExecutionQueue.updateStatus(task.id, 'failed', { error: failNote, txHash: br.txHash || lastHash }); } catch(e){}
          _notify(sched, 'failed', 'Schedule "' + sched.name + '" failed: ' + failNote, 'error');
          return { status: 'failed', reason: failNote };
        }
        confirmed++;
        spent += v.transfers[i].amount;
        lastHash = br.txHash;
        try { gasUsed += Number(br.receipt.gasUsed || 0); } catch(e){}
      }

      var duration = Date.now() - startTime;
      ledger[key] = { status: 'executed', ts: Date.now(), attempts: attempts, txHash: lastHash, amount: spent, asset: v.token };
      _saveLedger();
      _advanceSchedule(sched, 'Executed by Agent Wallet — ' + spent.toFixed(2) + ' ' + v.token + ' to ' + confirmed + ' recipient(s)', 'executed', lastHash);
      _recordOutcome(sched, v.auth, spent, v.token, 'success', lastHash, duration, gasUsed, null);
      try { if (task) ExecutionQueue.updateStatus(task.id, 'completed', { txHash: lastHash, result: 'success', progress: 100 }); } catch(e){}
      _notify(sched, 'executed', 'Schedule "' + sched.name + '" executed by Agent Wallet — ' + spent.toFixed(2) + ' ' + v.token + ' (tx ' + lastHash.slice(0, 10) + '...)', 'success');
      return { status: 'executed', txHash: lastHash };
    } catch(fatal) {
      var fReason = (fatal && (fatal.shortMessage || fatal.message)) ? String(fatal.shortMessage || fatal.message).substring(0, 140) : 'Unknown executor error';
      ledger[key] = { status: 'retry_pending', reason: fReason, ts: Date.now(), attempts: attempts, lastAttempt: Date.now() };
      _saveLedger();
      return { status: 'error', reason: fReason };
    } finally {
      delete _inFlight[key];
    }
  }

  /* ── Delegate swap/bridge/crosschain to the existing agent executors ── */
  async function _delegateExecution(sched, key, v, startTime){
    var attempts = ((ledger[key] && ledger[key].attempts) || 0) + 1;
    var fn = null;
    var args = [];
    if (sched.type === 'swap' && typeof window !== 'undefined' && typeof window._agentExecuteSwap === 'function') {
      fn = window._agentExecuteSwap;
      args = [v.total, v.token, sched.swapToToken || (v.token === 'USDC' ? 'EURC' : 'USDC'), 'sched_' + sched.id + '_' + Date.now()];
    } else if ((sched.type === 'bridge' || sched.type === 'crosschain') && typeof window !== 'undefined' && typeof window._agentExecuteBridge === 'function') {
      var destNet = sched.toNetwork || 'Base_Sepolia';
      var domain = CCTP_FALLBACK_DOMAINS[destNet];
      try {
        var netIds = { Ethereum_Sepolia: 11155111, Base_Sepolia: 84532, Arbitrum_Sepolia: 421614, Optimism_Sepolia: 11155420, Polygon_Amoy: 80002 };
        if (typeof ElligenteCCTP !== 'undefined' && ElligenteCCTP.CCTP_CONFIG && netIds[destNet] && ElligenteCCTP.CCTP_CONFIG[String(netIds[destNet])]) {
          domain = ElligenteCCTP.CCTP_CONFIG[String(netIds[destNet])].domain;
        }
      } catch(e){}
      if (domain === undefined || domain === null) {
        ledger[key] = { status: 'blocked', reason: 'Unknown bridge destination ' + destNet, ts: Date.now(), attempts: attempts };
        _saveLedger();
        _notify(sched, 'blocked', 'Cannot bridge "' + sched.name + '": unknown destination ' + destNet, 'warning');
        return { status: 'blocked' };
      }
      fn = window._agentExecuteBridge;
      var crossRecipient = null;
      if (sched.type === 'crosschain') {
        crossRecipient = (sched.recipients && sched.recipients.length && sched.recipients[0].addr) || sched.address || null;
      }
      args = [v.total, domain, destNet.replace('_', ' '), 'sched_' + sched.id + '_' + Date.now(), ARC_CHAIN_ID, crossRecipient];
    }

    if (!fn) {
      if (!ledger[key]) {
        ledger[key] = { status: 'manual_required', reason: sched.type + ' executor unavailable in this context', ts: Date.now(), attempts: attempts };
        _saveLedger();
        _notify(sched, 'manual', 'Schedule "' + sched.name + '" (' + sched.type + ') is due — agent executor unavailable, run manually', 'warning');
      }
      return { status: 'manual_required' };
    }

    try { _authz().recordUsage(v.auth.id, v.total, 'scheduled:' + sched.type, 'delegated'); } catch(e){}
    ledger[key] = { status: 'delegating', ts: Date.now(), attempts: attempts, amount: v.total, asset: v.token };
    _saveLedger();

    var delResult = null;
    try {
      delResult = await fn.apply(null, args);
    } catch(delErr) {
      var delFailReason = (delErr.shortMessage || delErr.message || '').substring(0, 140);
      ledger[key] = { status: 'failed', reason: 'Delegated ' + sched.type + ' execution failed: ' + delFailReason, ts: Date.now(), attempts: attempts };
      _saveLedger();
      _recordOutcome(sched, v.auth, v.total, v.token, 'failed', null, Date.now() - startTime, 0, delFailReason);
      _advanceSchedule(sched, 'Delegated ' + sched.type + ' failed: ' + delFailReason, 'failed');
      _notify(sched, 'failed', 'Delegated ' + sched.type + ' failed to execute: ' + delFailReason, 'error');
      return { status: 'failed', reason: delFailReason };
    }

    if (delResult && (delResult === false || delResult.ok === false || delResult.success === false)) {
      var failReason = (delResult && (delResult.reason || delResult.error || delResult.message)) || 'Unknown delegation failure';
      ledger[key] = { status: 'failed', reason: failReason, ts: Date.now(), attempts: attempts };
      _saveLedger();
      _recordOutcome(sched, v.auth, v.total, v.token, 'failed', delResult && delResult.txHash || null, Date.now() - startTime, 0, failReason);
      _advanceSchedule(sched, 'Delegated ' + sched.type + ' returned failure: ' + failReason, 'failed');
      _notify(sched, 'failed', 'Delegated ' + sched.type + ' returned failure: ' + failReason, 'error');
      return { status: 'failed', reason: failReason };
    }

    ledger[key] = { status: 'delegated', ts: Date.now(), attempts: attempts, amount: v.total, asset: v.token };
    _saveLedger();
    _advanceSchedule(sched, 'Delegated to Agent Wallet ' + sched.type + ' executor — ' + v.total + ' ' + v.token, 'delegated');
    _notify(sched, 'executed', 'Schedule "' + sched.name + '" — Agent Wallet executed the ' + sched.type + ' (' + v.total + ' ' + v.token + ')', 'info');
    return { status: 'delegated' };
  }

  /* ── Tick loop ── */
  function _isEmergencyStopped(){
    try {
      if (typeof AIWallet !== 'undefined' && typeof AIWallet.isEmergencyStopped === 'function') {
        if (AIWallet.isEmergencyStopped()) return true;
      }
      if (typeof window !== 'undefined' && typeof window._isEmergencyStopped === 'function') {
        if (window._isEmergencyStopped()) return true;
      }
    } catch(e){}
    return false;
  }

  async function _tick(){
    if (_ticking) return { status: 'busy' };
    if (_isEmergencyStopped()) return { status: 'emergency_stopped' };
    if (!isAutoEnabled()) return { status: 'disabled' };
    var eng = _engine();
    var E = _ethers();
    if (!eng || !E || !_wm() || !_authz()) return { status: 'deps_missing' };
    _ticking = true;
    var summary = { processed: 0, executed: 0, blocked: 0, failed: 0, results: [] };
    try {
      var due = getDueSchedules();
      for (var i = 0; i < due.length; i++) {
        var fresh = eng.getById(due[i].id);
        if (!fresh || !isEligible(fresh)) continue;
        summary.processed++;
        var res = await _executeSchedule(fresh);
        summary.results.push({ id: fresh.id, name: fresh.name, status: res.status, reason: res.reason || null });
        if (res.status === 'executed' || res.status === 'delegated') summary.executed++;
        else if (res.status === 'failed' || res.status === 'failed_final') summary.failed++;
        else if (res.status !== 'replay_blocked' && res.status !== 'in_flight') summary.blocked++;
      }
    } catch(e){
      summary.error = e.message || String(e);
    } finally {
      _ticking = false;
    }
    return summary;
  }

  function start(){
    if (_timer) return false;
    if (_isEmergencyStopped()) return false;
    _timer = setInterval(function(){ _tick(); }, TICK_MS);
    setTimeout(function(){ _tick(); }, 1500);
    return true;
  }

  function stop(){
    if (_timer) { clearInterval(_timer); _timer = null; }
    return true;
  }

  function isRunning(){ return !!_timer; }

  function tickNow(){ return _tick(); }

  function getExecutionLog(limit){
    var keys = Object.keys(ledger);
    keys.sort(function(a, b){ return (ledger[b].ts || 0) - (ledger[a].ts || 0); });
    return keys.slice(0, limit || 50).map(function(k){
      var parts = k.split('|');
      return Object.assign({ scheduleId: parts[0], runAt: parts[1] }, ledger[k]);
    });
  }

  function getNotifications(limit){ return notifications.slice(0, limit || 50); }

  _loadLedger();

  if (typeof document !== 'undefined') {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      setTimeout(start, 5000);
    } else {
      document.addEventListener('DOMContentLoaded', function(){ setTimeout(start, 5000); });
    }
  }

  var API = {
    start: start,
    stop: stop,
    isRunning: isRunning,
    tickNow: tickNow,
    getDueSchedules: getDueSchedules,
    isEligible: isEligible,
    hasScheduledAuth: hasScheduledAuth,
    getExecutionLog: getExecutionLog,
    getNotifications: getNotifications,
    setAutoEnabled: setAutoEnabled,
    isAutoEnabled: isAutoEnabled,
    SUPPORTED_TYPES: SUPPORTED_TYPES.slice(),
    ARC_CHAIN_ID: ARC_CHAIN_ID,
    version: '1.0.0'
  };

  if (typeof window !== 'undefined') window.AgentScheduleExecutor = API;
  else if (typeof globalThis !== 'undefined') globalThis.AgentScheduleExecutor = API;
})();
