/**
 * Autonoma Agent Schedule Executor ÔÇö Delegated Scheduled-Intent Execution
 * Executes due ScheduleEngine intents on-chain through the existing Agent Wallet.
 * The Agent Wallet is the ONLY execution layer. The user's keys are never used.
 *
 * Hard gates (all enforced BEFORE signing, every run):
 *   1. Active AgentAuthorization with allowScheduled=true (user opt-in, revocable)
 *   2. AgentAuthorization.validateExecution ÔÇö spending / daily / token / network /
 *      recipient / time-window / max-uses limits
 *   3. Underlying operation permission (allowPayments / allowSwap / allowBridge...)
 *   4. PolicyEngine.validateExecution (when loaded)
 *   5. RiskEngine level vs authorization maxRiskLevel (when loaded)
 *   6. Chain check (Arc Testnet 5042002), balance check, gas ceiling,
 *      AgentWalletManager.validatePreExecution (TOCTOU + daily ops)
 *   7. eth_call simulation of every transfer before broadcast
 *   8. Persistent per-run ledger (schedId|nextRun) ÔÇö replay protection
 * If any validation fails: abort, persist the reason, notify the user.
 * Attached to window.AgentScheduleExecutor
 */
(function(){
  'use strict';

  // Idempotency guard: this module is both bundled AND lazy-loaded by ModuleLoader
  // (DEFERRED tier). A second evaluation would create a SECOND 30s tick loop and a
  // second AgentScheduleExecutor instance, giving two independent executors for the
  // same schedules. Skip re-initialization when an instance already exists.
  if (typeof window !== 'undefined' && window.AgentScheduleExecutor) return;

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

  /* ÔöÇÔöÇ Persistence ÔöÇÔöÇ */
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

  // Re-read the ledger from localStorage so a second tab/instance observes the
  // latest run state (e.g. a 'submitted' txHash written by another tab) instead
  // of acting on a stale in-memory copy and re-broadcasting.
  function _ledgerRefresh(){
    try { var r = localStorage.getItem(LEDGER_KEY); if (r) ledger = JSON.parse(r) || {}; } catch(e){}
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

  /* ÔöÇÔöÇ Dependency access (resolved at call time, never at load time) ÔöÇÔöÇ */
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
        if (sym === 'USDC') return { address: ElligenteContracts.USDC_ADDRESS, decimals: ElligenteContracts.USDC_DECIMALS || 6, symbol: 'USDC' };
        if (sym === 'EURC') return { address: ElligenteContracts.EURC_ADDRESS, decimals: ElligenteContracts.EURC_DECIMALS || 6, symbol: 'EURC' };
        if (sym === 'cirBTC') return { address: ElligenteContracts.CIRBTC_ADDRESS, decimals: ElligenteContracts.CIRBTC_DECIMALS || 8, symbol: 'cirBTC' };
      }
    } catch(e){}
    var fallback = FALLBACK_TOKENS[sym];
    if (fallback) return { address: fallback.address, decimals: fallback.decimals, symbol: sym };
    return null;
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

  function _toRawAmount(amount, symbol){
    var symbolStr = String(symbol || 'USDC').toUpperCase();
    var dec = symbolStr === 'CIRBTC' ? 8 : 6;
    var floatVal = parseFloat(amount);
    if (isNaN(floatVal) || floatVal <= 0) return 0n;
    return BigInt(Math.round(floatVal * Math.pow(10, dec)));
  }

  /* ÔöÇÔöÇ Notifications ÔöÇÔöÇ */
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

  /* ÔöÇÔöÇ Schedule helpers ÔöÇÔöÇ */
  function _execKey(sched){ return sched.id + '|' + sched.nextRun; }

  function _nextRunAfter(freq, fromIso){
    var d = new Date(fromIso);
    if (isNaN(d.getTime())) d = new Date();
    switch (freq) {
      case 'daily': d.setUTCDate(d.getUTCDate() + 1); break;
      case 'weekly': d.setUTCDate(d.getUTCDate() + 7); break;
      case 'biweekly': d.setUTCDate(d.getUTCDate() + 14); break;
      case 'monthly':
        var currentDay = d.getUTCDate();
        d.setUTCMonth(d.getUTCMonth() + 1);
        if (d.getUTCDate() !== currentDay) d.setUTCDate(0); // month-end rollover (31 Jan -> 28/29 Feb)
        break;
      default: return null;
    }
    return d.toISOString();
  }

  function _advanceSchedule(sched, note, status, txHash, meta){
    var eng = _engine();
    if (!eng) return;
    var execCount = (sched.execCount || 0) + (status === 'executed' ? 1 : 0);
    var history = (sched.executionHistory || []).slice();
    history.unshift({
      ts: new Date().toISOString(), status: status, note: note,
      txHash: txHash || null, executor: 'agent_wallet',
      sender: meta ? meta.sender : null,
      recipient: meta ? meta.recipient : null,
      token: meta ? meta.token : sched.token || null,
      amount: meta ? meta.amount : null,
      gasUsed: meta ? meta.gasUsed : null,
      rows: meta ? meta.rows : null,
      mintTxHash: meta ? meta.mintTxHash : null,
      chainId: ARC_CHAIN_ID
    });
    if (history.length > 50) history.length = 50;
    var next = sched.freq === 'once' ? null : _nextRunAfter(sched.freq, sched.nextRun || new Date().toISOString());
    while (next && (Date.now() - new Date(next).getTime()) > MISS_WINDOW_MS) {
      next = _nextRunAfter(sched.freq, next);
    }
    var newStatus = sched.status;
    // Only terminal states (executed / skipped) may complete the schedule.
    // A failed execution must NOT be marked "Completed" nor lose its nextRun —
    // otherwise a one-time failure looks successful and can never be retried.
    var isTerminal = (status === 'executed' || status === 'skipped');
    var noNextOccurrence = (sched.freq === 'once' || (sched.maxEx > 0 && execCount >= sched.maxEx) || !next);
    if (isTerminal && noNextOccurrence) {
      newStatus = 'Completed';
      next = null;
    } else if ((status === 'failed' || status === 'blocked') && noNextOccurrence) {
      // A one-time (or exhausted) schedule that fails terminally must reach a
      // terminal FAILED state — never remain "Active" with nextRun=null (H3).
      newStatus = 'Failed';
      next = null;
    }
    eng.update(sched.id, { execCount: execCount, executionHistory: history, nextRun: next, status: newStatus });
  }

  // Pause a schedule after a failure, but NEVER overwrite a terminal status
  // (Failed / Completed) that _advanceSchedule may have just set for a one-time
  // schedule. Otherwise a once-schedule failure would flip back to "Paused" and
  // could be resumed into "Active" with nextRun=null (H3).
  function _pauseAfterFailure(sched, defaults){
    if (!defaults.pauseOnFailure) return;
    try {
      var cur = _engine().getById(sched.id);
      if (cur && cur.status !== 'Failed' && cur.status !== 'Completed') _engine().update(sched.id, { status: 'Paused' });
    } catch(e){}
  }

  function isEligible(sched){
    if (!sched || sched.status !== 'Active' || !sched.nextRun) return false;
    if (sched.agentExecution === false) return false;
    // AI Smart Wallet MultiSend (createdBy === 'aiwallet') is executed by the
    // existing BatchExecutionEngine (batch contract) — never by this executor.
    if (sched.type === 'multisend' && sched.createdBy === 'aiwallet') return false;
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

  /* ÔöÇÔöÇ Validation pipeline (returns {ok, reason, auth, transfers, token} ) ÔöÇÔöÇ */
  async function _validateIntent(sched, provider, agentAddr){
    var az = _authz();
    var wm = _wm();
    var E = _ethers();
    if (!E) return { ok: false, reason: 'ethers unavailable' };
    if (!wm) return { ok: false, reason: 'AgentWalletManager unavailable' };
    if (!az) return { ok: false, reason: 'Authorization system unavailable' };
    if (wm.isShutdown && wm.isShutdown()) return { ok: false, reason: 'Agent wallet is shut down' };
    if (wm.isPaused()) return { ok: false, reason: 'Agent wallet is paused' };
    if (!hasScheduledAuth()) return { ok: false, reason: 'No active authorization for scheduled execution ÔÇö say "allow agent to execute schedules" in Autonoma', needsAuthorization: true };

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
      operation: underlyingOp, amount: total, asset: token,
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
        var risk = RiskEngine.quickAssess(underlyingOp, total, token, '', 'Arc Testnet');
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
          return { ok: false, reason: 'Agent wallet balance ' + balFloat.toFixed(4) + ' ' + token + ' < required ' + total + ' ÔÇö fund the agent wallet' };
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

    var pre = wm.validatePreExecution(underlyingOp, E.toBeHex(maxFeeWei), E.toBeHex(TX_GAS_LIMIT), agentAddr);
    if (!pre || !pre.ok) return { ok: false, reason: (pre && pre.reason) || 'Pre-execution validation failed' };

    return { ok: true, auth: auth, transfers: transfers, token: token, tokenInfo: tokenInfo, total: total, underlyingOp: underlyingOp };
  }

  /* ÔöÇÔöÇ Simulation: real eth_call for every transfer before broadcast ÔöÇÔöÇ */
  async function _simulateTransfers(provider, agentAddr, tokenInfo, transfers){
    var E = _ethers();
    var iface = new E.Interface(['function transfer(address to, uint256 amount) returns (bool)']);
    var artifacts = [];
    for (var i = 0; i < transfers.length; i++) {
      var rawAmt = _toRawAmount(transfers[i].amount, tokenInfo.symbol || 'USDC');
      var data = iface.encodeFunctionData('transfer', [transfers[i].to, rawAmt]);
      try {
        var res = await provider.call({ from: agentAddr, to: tokenInfo.address, data: data });
        artifacts.push(data + '::' + res);
        transfers[i]._calldata = data;
        transfers[i]._rawAmount = rawAmt;
      } catch(simErr) {
        return { ok: false, reason: 'Simulation reverted for transfer #' + (i + 1) + ': ' + (simErr.shortMessage || simErr.message || 'revert').substring(0, 90) };
      }
    }
    var simHash;
    try { simHash = E.keccak256(E.toUtf8Bytes(artifacts.join('|'))); } catch(e){ simHash = '0xsim_' + Date.now(); }
    return { ok: true, simulationHash: simHash };
  }

  function _validatePolicy(sched, auth, total, token, simulationHash, underlyingOp){
    try {
      if (typeof PolicyEngine === 'undefined' || !PolicyEngine.validateExecution) return { ok: true, report: null };
      var report = PolicyEngine.validateExecution({
        operation: underlyingOp || sched.type, amount: total, asset: token, network: 'Arc Testnet',
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

  /* ÔöÇÔöÇ Broadcast one ERC-20 transfer signed by the Agent Wallet ÔöÇÔöÇ */
  /* ── Prepare ONE ERC-20 transfer (fee/gas/nonce + rawTx + fingerprint).
     NO signing, NO broadcasting. The returned nonce + fingerprint are persisted as an
     execution intent BEFORE broadcast, so a crash after eth_sendRawTransaction but before
     txHash persistence can be reconciled by nonce/fingerprint — never re-broadcast. */
  async function _prepareTransfer(provider, agentAddr, tokenInfo, transfer){
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
      var maxFeeGweiFloat = parseFloat(E.formatUnits(maxFee, 'gwei'));
      var scaledGwei = Math.round(maxFeeGweiFloat * GAS_MULTIPLIER);
      var cappedGwei = Math.min(scaledGwei, GAS_MAX_GWEI);
      maxFee = E.parseUnits(String(cappedGwei), 'gwei');
      if (!maxPriorityFee || maxPriorityFee === 0n) maxPriorityFee = fallbackPriority;
    }
    try {
      var gasEst = await provider.estimateGas({ from: agentAddr, to: tokenInfo.address, data: transfer._calldata });
      if (gasEst) TX_GAS_LIMIT = Math.min(Math.floor(Number(gasEst) * 1.3), 300000);
    } catch(e){}
    var nonceHex = await _nextNonce(provider, agentAddr);
    var nonce = parseInt(nonceHex, 16);
    var rawTx = {
      type: 2, chainId: ARC_CHAIN_ID, to: tokenInfo.address,
      data: transfer._calldata, value: '0x0',
      gasLimit: E.toBeHex(TX_GAS_LIMIT), nonce: nonceHex,
      maxFeePerGas: E.toBeHex(maxFee),
      maxPriorityFeePerGas: E.toBeHex(maxPriorityFee)
    };
    return {
      nonce: nonce, from: agentAddr, to: tokenInfo.address, data: transfer._calldata,
      value: '0x0', chainId: ARC_CHAIN_ID, rawTx: rawTx,
      fingerprint: _txFingerprint(agentAddr, nonce, tokenInfo.address, transfer._calldata)
    };
  }

  /* ── Sign + broadcast a prepared raw transaction. Throws on ambiguous failure.
        This is the SINGLE execution authority broadcast primitive for Autonoma —
        the only place that calls eth_sendRawTransaction. ── */
  async function _signAndSend(signer, provider, rawTx, opts){
    // [AUTONOMA-6B/6C] Secure signer provider. Browser mode is unchanged (the
    // single broadcast primitive below). Circle mode delegates sign+broadcast
    // to the server (FAIL-CLOSED — SecureSignerProvider throws, never falls
    // back to the browser signer). `opts` carries the structured Circle request
    // and execution identity (AUTONOMA-6C).
    if (typeof SecureSignerProvider !== 'undefined' && SecureSignerProvider.isCircleMode()) {
      return await SecureSignerProvider.broadcast(signer, provider, rawTx, opts);
    }
    var signedTx = await signer.signTransaction(rawTx);
    var txHash = await provider.send('eth_sendRawTransaction', [signedTx]);
    return txHash;
  }

  /* ── Single nonce source (read-only) for the execution authority. ── */
  function _nextNonce(provider, from){
    // [AUTONOMA-6B] Circle mode resolves the nonce server-side (for the Circle
    // wallet). Browser mode is unchanged.
    if (typeof SecureSignerProvider !== 'undefined' && SecureSignerProvider.isCircleMode()) {
      return SecureSignerProvider.nextNonce(provider, from);
    }
    return provider.send('eth_getTransactionCount', [from, 'pending']);
  }

  function _txFingerprint(from, nonce, to, data){
    var E = _ethers();
    try {
      return E.keccak256(E.toUtf8Bytes([ARC_CHAIN_ID, String(from).toLowerCase(), nonce, String(to).toLowerCase(), data].join('|')));
    } catch(e){
      return 'fp_' + ARC_CHAIN_ID + '_' + String(from).toLowerCase().slice(0, 10) + '_' + nonce;
    }
  }

  /* ── Attribute a raw RPC transaction object to a persisted intent. ── */
  function _intentMatches(intent, tx){
    if (!intent || !tx) return false;
    return String(tx.to || '').toLowerCase() === String(intent.to || '').toLowerCase()
      && String(tx.input || tx.data || '') === String(intent.data || '')
      && String(tx.value || '0x0') === String(intent.value || '0x0')
      && String(tx.from || '').toLowerCase() === String(intent.from || '').toLowerCase()
      && parseInt(String(tx.nonce), 16) === intent.nonce;
  }

  /* ── Resolve an uncertain broadcast by (wallet, chainId, nonce) + fingerprint.
     Returns { resolved:true, txHash } or { resolved:false, reason }. NEVER rebroadcasts. ── */
  async function _resolveUnknownIntent(intent, provider){
    var nonce = intent && intent.nonce;
    var from = intent && intent.from;
    if (nonce == null || !from) return { resolved: false, reason: 'no_intent' };
    // Strongest evidence: exact transaction at (from, nonce) if the RPC supports it.
    var tx = null;
    try { tx = await provider.send('eth_getTransactionByNonce', [from, '0x' + nonce.toString(16)]); } catch(e){}
    if (tx && tx.hash) {
      if (_intentMatches(intent, tx)) return { resolved: true, txHash: tx.hash };
      return { resolved: false, reason: 'nonce_conflict' };
    }
    // Fallback: nonce-count evidence (pending + latest).
    var pendingCount = null, latestCount = null;
    try { latestCount = parseInt(await provider.send('eth_getTransactionCount', [from, 'latest']), 16); } catch(e){}
    try { pendingCount = parseInt(await provider.send('eth_getTransactionCount', [from, 'pending']), 16); } catch(e){}
    if ((pendingCount != null && pendingCount > nonce) || (latestCount != null && latestCount > nonce)) {
      return { resolved: false, reason: 'nonce_consumed_unknown' };
    }
    return { resolved: false, reason: 'not_broadcast' };
  }

  /* ── Reconcile an occurrence whose broadcast status is uncertain. NEVER re-broadcast. ── */
  async function _reconcileUnknown(sched, key, prior){
    var wm = _wm();
    var provider = wm ? wm.getAgentProvider() : null;
    if (!provider) return { status: 'reconciling', nonce: prior.nonce };
    var res = await _resolveUnknownIntent(prior, provider);
    var reasonMap = {
      nonce_conflict: 'Nonce conflict — transaction not attributable to this schedule',
      nonce_consumed_unknown: 'Broadcast unknown — nonce consumed but transaction not recoverable',
      not_broadcast: 'Broadcast unknown — no transaction found (not re-broadcast)',
      no_intent: 'Broadcast unknown without intent — manual reconciliation required'
    };
    if (res.resolved) {
      ledger[key] = { status: 'submitted', txHash: res.txHash, nonce: prior.nonce, from: prior.from, ts: Date.now(), attempts: prior.attempts || 0 };
      _saveLedger();
      return await _reconcileSubmitted(sched, key, ledger[key]);
    }
    // Safety first: never auto-rebroadcast. Mark failed with the exact reason.
    ledger[key] = { status: 'failed', reason: reasonMap[res.reason] || res.reason, nonce: prior.nonce, from: prior.from, ts: Date.now(), attempts: prior.attempts || 0 };
    _saveLedger();
    _advanceSchedule(sched, 'Broadcast unknown: ' + (reasonMap[res.reason] || res.reason), 'failed', null, { token: sched.token, amount: sched.amount });
    _pauseAfterFailure(sched, _policyDefaults());
    return { status: 'failed', reason: res.reason };
  }

  /* ── Wait for a receipt for an already-broadcast transaction ── */
  async function _waitReceipt(provider, txHash){
    try {
      var receipt = await provider.waitForTransaction(txHash, 1, 60000);
      if (!receipt || receipt.status !== 1) {
        return { ok: false, txHash: txHash, reason: 'Transaction reverted on-chain', receipt: receipt };
      }
      return { ok: true, txHash: txHash, receipt: receipt };
    } catch(waitErr) {
      return { ok: false, txHash: txHash, reason: 'Receipt timeout (tx submitted): ' + (waitErr.shortMessage || waitErr.message || 'timeout').substring(0, 80) };
    }
  }

  /* ── Reconcile an occurrence that already has a txHash — NEVER re-broadcast ── */
  async function _reconcileSubmitted(sched, key, prior){
    var txHash = prior.txHash;
    if (!txHash) {
      ledger[key] = { status: 'failed', reason: 'Submitted without txHash — manual reconciliation required', ts: Date.now(), attempts: prior.attempts || 0 };
      _saveLedger();
      return { status: 'reconciling' };
    }
    var wm = _wm();
    var provider = wm ? wm.getAgentProvider() : null;
    if (!provider) return { status: 'reconciling', txHash: txHash };
    var receipt = null;
    try { if (typeof provider.getTransactionReceipt === 'function') receipt = await provider.getTransactionReceipt(txHash); } catch(e){}
    if (receipt && receipt.status === 1) {
      ledger[key] = { status: 'executed', txHash: txHash, ts: Date.now(), attempts: prior.attempts || 0 };
      _saveLedger();
      _advanceSchedule(sched, 'Reconciled: transaction confirmed on-chain', 'executed', txHash, { sender: null, token: sched.token, amount: sched.amount });
      _notify(sched, 'executed', 'Schedule "' + sched.name + '" reconciled: tx ' + txHash.slice(0, 10) + '... confirmed', 'success');
      return { status: 'executed', txHash: txHash };
    } else if (receipt && receipt.status === 0) {
      ledger[key] = { status: 'failed', reason: 'Reconciled: transaction reverted on-chain', txHash: txHash, ts: Date.now(), attempts: prior.attempts || 0 };
      _saveLedger();
      _advanceSchedule(sched, 'Reconciled: transaction reverted on-chain', 'failed', txHash, { sender: null, token: sched.token, amount: sched.amount });
      return { status: 'failed', txHash: txHash };
    }
    return { status: 'reconciling', txHash: txHash };
  }

  function _recordOutcome(sched, auth, total, token, result, txHash, duration, gasUsed, reason, meta){
    var az = _authz();
    var wm = _wm();
    try { if (az && auth && result === 'success') az.recordUsage(auth.id, total, 'scheduled:' + sched.type, 'success'); } catch(e){}
    try {
      if (typeof AgentAudit !== 'undefined') AgentAudit.recordExecution({
        operation: 'scheduled:' + sched.type, amount: total, asset: token, chain: 'Arc Testnet',
        transactionHash: txHash || '', result: result, duration: duration || 0, gasUsed: gasUsed || 0,
        authorizationId: auth ? auth.id : null, error: reason || null,
        metadata: {
          scheduleId: sched.id, scheduleName: sched.name, executor: 'AgentScheduleExecutor',
          sender: meta ? meta.sender : null, recipient: meta ? meta.recipient : null,
          token: token, amount: total, gasUsed: gasUsed || 0
        }
      });
    } catch(e){}
    try {
      if (typeof ExecutionHistory !== 'undefined') ExecutionHistory.recordExecution({
        operation: 'scheduled:' + sched.type, amount: total, asset: token, chain: 'Arc Testnet',
        txHash: txHash || '', result: result === 'success' ? 'success' : 'failed', duration: duration || 0,
        displayText: 'Schedule "' + sched.name + '" ÔÇö ' + total + ' ' + token + ' (' + result + ')'
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

  /* ÔöÇÔöÇ Execute a single due schedule ÔöÇÔöÇ */
  async function _executeSchedule(sched){
    var key = _execKey(sched);
    if (_inFlight[key]) return { status: 'in_flight' };
    _ledgerRefresh();
    var prior = ledger[key];
    if (prior && prior.status === 'awaiting_auth') {
      if (!hasScheduledAuth()) return { status: 'awaiting_auth' };
    } else if (prior && prior.status === 'submitted') {
      // A txHash already exists for this occurrence — reconcile, NEVER re-broadcast.
      return await _reconcileSubmitted(sched, key, prior);
    } else if (prior && prior.status === 'execution_unknown') {
      // Broadcast status uncertain (crash after send / ambiguous failure) — reconcile by
      // nonce+fingerprint, NEVER re-broadcast.
      return await _reconcileUnknown(sched, key, prior);
    } else if (prior && prior.status !== 'retry_pending' && prior.status !== 'in_progress') {
      return { status: 'replay_blocked' };
    }

    var defaults = _policyDefaults();
    if (prior && prior.status === 'retry_pending') {
      if ((prior.attempts || 0) >= (defaults.retryMax || 3)) {
        ledger[key] = { status: 'failed', reason: prior.reason || 'Retries exhausted', ts: Date.now(), attempts: prior.attempts };
        _saveLedger();
        _advanceSchedule(sched, 'Failed after ' + prior.attempts + ' attempts: ' + (prior.reason || ''), 'failed', null, { token: sched.token, amount: sched.amount });
        _pauseAfterFailure(sched, defaults)
        _notify(sched, 'failed', 'Schedule "' + sched.name + '" failed after ' + prior.attempts + ' attempts ÔÇö ' + (defaults.pauseOnFailure ? 'paused' : 'skipped'), 'error');
        return { status: 'failed_final' };
      }
      if (Date.now() - (prior.lastAttempt || 0) < (defaults.retryDelayMs || 30000)) return { status: 'retry_waiting' };
    }

    var overdueMs = Date.now() - new Date(sched.nextRun).getTime();
    if (overdueMs > MISS_WINDOW_MS) {
      ledger[key] = { status: 'skipped_stale', reason: 'Missed execution window (>24h overdue)', ts: Date.now() };
      _saveLedger();
      _advanceSchedule(sched, 'Skipped: missed execution window by ' + Math.round(overdueMs / 3600000) + 'h', 'skipped', null, { token: sched.token, amount: sched.amount });
      _notify(sched, 'skipped', 'Schedule "' + sched.name + '" missed its execution window and was skipped (deadline protection)', 'warning');
      return { status: 'skipped_stale' };
    }

    if (MANUAL_TYPES.indexOf(sched.type) !== -1) {
      if (!prior) {
        ledger[key] = { status: 'manual_required', reason: sched.type + ' requires manual execution', ts: Date.now() };
        _saveLedger();
        _notify(sched, 'manual', 'Schedule "' + sched.name + '" (' + sched.type + ') is due ÔÇö open the Schedules tab to run it manually', 'warning');
      }
      return { status: 'manual_required' };
    }

    _inFlight[key] = true;
    // Shared cross-executor claim (atomic across tabs/instances): only one executor
    // may run this occurrence. Bound to wallet/chain context.
    var eng0 = _engine();
    var _outcome = 'running';
    if (eng0 && typeof eng0.claimExecution === 'function') {
      var claimRes = await eng0.claimExecution(key, 'agent_schedule_executor', {
        scheduleId: sched.id, occurrenceId: key,
        wallet: sched.walletAddress || null, chain: 'Arc Testnet'
      });
      if (!claimRes || !claimRes.acquired) {
        delete _inFlight[key];
        if (claimRes && (claimRes.reason === 'submitted' || claimRes.reason === 'terminal_confirmed' || claimRes.reason === 'terminal_failed')) {
          return { status: 'claimed_by_other', reason: claimRes.reason };
        }
        return { status: 'claimed_by_other' };
      }
    }
    var startTime = Date.now();
    var attempts = ((prior && prior.attempts) || 0) + 1;

    // Persist an in-flight marker IMMEDIATELY after the claim so any concurrent
    // instance observes this occurrence as taken (via _ledgerRefresh) even before
    // validation/simulation completes — closing the window where only the Web-Locks
    // claim guarded against a double broadcast.
    ledger[key] = { status: 'executing', ts: Date.now(), attempts: attempts };
    _saveLedger();

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
          _recordOutcome(sched, v.auth, v.total || sched.amount || 0, sched.token || 'USDC', 'unauthorized', null, Date.now() - startTime, 0, v.reason, { sender: agentAddr, token: sched.token || 'USDC', amount: v.total || sched.amount || 0 });
          if (firstNotice) _notify(sched, 'blocked', 'Agent cannot execute "' + sched.name + '": ' + v.reason, 'warning');
          return { status: 'awaiting_auth', reason: v.reason };
        }
        ledger[key] = { status: 'retry_pending', reason: v.reason, ts: Date.now(), attempts: attempts, lastAttempt: Date.now() };
        _saveLedger();
        _recordOutcome(sched, v.auth, v.total || sched.amount || 0, sched.token || 'USDC', 'failed', null, Date.now() - startTime, 0, v.reason, { sender: agentAddr, token: sched.token || 'USDC', amount: v.total || sched.amount || 0 });
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

      var pol = _validatePolicy(sched, v.auth, v.total, v.token, sim.simulationHash, v.underlyingOp);
      if (!pol.ok) {
        ledger[key] = { status: 'blocked', reason: pol.reason, ts: Date.now(), attempts: attempts };
        _saveLedger();
        _advanceSchedule(sched, 'Blocked by policy: ' + pol.reason, 'failed', null, { sender: agentAddr, token: v.token, amount: v.total });
        _pauseAfterFailure(sched, defaults)
        _recordOutcome(sched, v.auth, v.total, v.token, 'failed', null, Date.now() - startTime, 0, pol.reason, { sender: agentAddr, token: v.token, amount: v.total });
        _notify(sched, 'blocked', 'Policy blocked "' + sched.name + '": ' + pol.reason, 'error');
        return { status: 'policy_blocked', reason: pol.reason };
      }

      if (sched.type === 'multisend') {
        var msRes = await _executeMultiSendSequential(sched, key, v, provider, signer, agentAddr, startTime, attempts, defaults);
        if (msRes && msRes.status === 'submitted') _outcome = 'submitted';
        return msRes;
      }

      var task = null;
      try {
        if (typeof ExecutionQueue !== 'undefined') {
          task = ExecutionQueue.enqueue({ type: 'scheduled', operation: 'scheduled:' + sched.type, amount: v.total, asset: v.token, destination: v.transfers.length === 1 ? v.transfers[0].to : v.transfers.length + ' recipients' });
          ExecutionQueue.updateStatus(task.id, 'running');
        }
      } catch(e){}

      ledger[key] = { status: 'executing', ts: Date.now(), attempts: attempts };
      _saveLedger();

      var confirmed = 0;
      var spent = 0;
      var lastHash = '';
      var gasUsed = 0;
      for (var i = 0; i < v.transfers.length; i++) {
        // 1. Prepare (compute nonce + rawTx + fingerprint). No broadcast yet.
        var prep;
        try {
          prep = await _prepareTransfer(provider, agentAddr, v.tokenInfo, v.transfers[i]);
        } catch(prepErr) {
          var prepNote = 'Transfer ' + (i + 1) + '/' + v.transfers.length + ' preparation failed: ' + ((prepErr.shortMessage || prepErr.message || 'prepare error')).substring(0, 120) + (confirmed > 0 ? ' (' + confirmed + ' confirmed before failure)' : '');
          ledger[key] = { status: 'failed', reason: prepNote, ts: Date.now(), attempts: attempts, txHash: lastHash };
          _saveLedger();
          if (eng0 && typeof eng0.updateExecutionClaim === 'function') eng0.updateExecutionClaim(key, 'agent_schedule_executor', { status: 'failed', txHash: lastHash || null });
          if (spent > 0) { try { _authz().recordUsage(v.auth.id, spent, 'scheduled:' + sched.type, 'partial'); } catch(e){} }
          _advanceSchedule(sched, prepNote, 'failed', lastHash, { sender: agentAddr, recipient: v.transfers[i].to, token: v.token, amount: v.transfers[i].amount, gasUsed: gasUsed });
          _pauseAfterFailure(sched, defaults)
          _recordOutcome(sched, null, spent, v.token, 'failed', lastHash, Date.now() - startTime, gasUsed, prepNote, { sender: agentAddr, recipient: v.transfers[i].to, token: v.token, amount: v.transfers[i].amount, gasUsed: gasUsed });
          try { if (task) ExecutionQueue.updateStatus(task.id, 'failed', { error: prepNote, txHash: lastHash }); } catch(e){}
          _notify(sched, 'failed', 'Schedule "' + sched.name + '" failed: ' + prepNote, 'error');
          _outcome = 'failed';
          return { status: 'failed', reason: prepNote };
        }

        // 2. Persist the execution intent (nonce + fingerprint) BEFORE broadcast.
        //    This is the recovery anchor: a crash between the send and the txHash
        //    persistence is reconciled by nonce/fingerprint — never re-broadcast.
        ledger[key] = { status: 'execution_unknown', nonce: prep.nonce, from: prep.from, to: prep.to, data: prep.data, value: prep.value, chainId: prep.chainId, fingerprint: prep.fingerprint, ts: Date.now(), attempts: attempts, amount: spent + v.transfers[i].amount, asset: v.token };
        _saveLedger();
        if (eng0 && typeof eng0.updateExecutionClaim === 'function') eng0.updateExecutionClaim(key, 'agent_schedule_executor', { status: 'execution_unknown', nonce: prep.nonce });

        // 3. Sign + broadcast. On throw the outcome is AMBIGUOUS — reconcile, never blind-retry.
        var txHash;
        try {
          txHash = await _signAndSend(signer, provider, prep.rawTx);
        } catch(sendErr) {
          var unkRes = await _reconcileUnknown(sched, key, ledger[key]);
          _outcome = (unkRes.status === 'reconciling' || unkRes.status === 'submitted') ? 'submitted' : 'running';
          return unkRes;
        }

        // 4. txHash is known — persist it IMMEDIATELY (before waiting for the receipt).
        lastHash = txHash;
        ledger[key] = { status: 'submitted', txHash: txHash, nonce: prep.nonce, from: prep.from, ts: Date.now(), attempts: attempts, amount: spent + v.transfers[i].amount, asset: v.token };
        _saveLedger();
        if (eng0 && typeof eng0.updateExecutionClaim === 'function') eng0.updateExecutionClaim(key, 'agent_schedule_executor', { status: 'submitted', txHash: txHash });

        var rec;
        try {
          rec = await _waitReceipt(provider, txHash);
        } catch(wErr) {
          rec = { ok: false, txHash: txHash, reason: (wErr.shortMessage || wErr.message || 'receipt error').substring(0, 120) };
        }
        if (!rec.ok) {
          if (rec.receipt && rec.receipt.status === 0) {
            // Deterministic on-chain revert → terminal failure.
            ledger[key] = { status: 'failed', reason: 'Transfer ' + (i + 1) + ' reverted on-chain', txHash: rec.txHash, ts: Date.now(), attempts: attempts };
            _saveLedger();
            if (eng0 && typeof eng0.updateExecutionClaim === 'function') eng0.updateExecutionClaim(key, 'agent_schedule_executor', { status: 'failed', txHash: rec.txHash });
            if (spent > 0) { try { _authz().recordUsage(v.auth.id, spent, 'scheduled:' + sched.type, 'partial'); } catch(e){} }
            _advanceSchedule(sched, 'Transfer ' + (i + 1) + ' reverted on-chain', 'failed', rec.txHash, { sender: agentAddr, recipient: v.transfers[i].to, token: v.token, amount: v.transfers[i].amount, gasUsed: gasUsed });
            _pauseAfterFailure(sched, defaults)
            _recordOutcome(sched, null, spent, v.token, 'failed', rec.txHash, Date.now() - startTime, gasUsed, 'Transfer reverted on-chain', { sender: agentAddr, recipient: v.transfers[i].to, token: v.token, amount: v.transfers[i].amount, gasUsed: gasUsed });
            try { if (task) ExecutionQueue.updateStatus(task.id, 'failed', { error: 'reverted', txHash: rec.txHash }); } catch(e){}
            _notify(sched, 'failed', 'Schedule "' + sched.name + '" failed: transfer reverted on-chain', 'error');
            _outcome = 'failed';
            return { status: 'failed', reason: 'reverted', txHash: rec.txHash };
          }
          // Receipt timeout (tx possibly confirmed): keep 'submitted', reconcile later. Never re-send.
          _notify(sched, 'pending', 'Schedule "' + sched.name + '" transfer submitted (tx ' + rec.txHash.slice(0, 10) + '...) — awaiting confirmation', 'info');
          _outcome = 'submitted';
          return { status: 'submitted', txHash: rec.txHash, reason: 'receipt_timeout' };
        }

        confirmed++;
        spent += v.transfers[i].amount;
        try { gasUsed += Number(rec.receipt.gasUsed || 0); } catch(e){}
        if (eng0 && typeof eng0.renewExecutionClaim === 'function') eng0.renewExecutionClaim(key, 'agent_schedule_executor');
      }

      var duration = Date.now() - startTime;
      ledger[key] = { status: 'executed', ts: Date.now(), attempts: attempts, txHash: lastHash, amount: spent, asset: v.token };
      _saveLedger();
      if (eng0 && typeof eng0.updateExecutionClaim === 'function') eng0.updateExecutionClaim(key, 'agent_schedule_executor', { status: 'confirmed', txHash: lastHash || null });
      _advanceSchedule(sched, 'Executed by Agent Wallet ÔÇö ' + spent.toFixed(2) + ' ' + v.token + ' to ' + confirmed + ' recipient(s)', 'executed', lastHash, { sender: agentAddr, recipient: v.transfers.length === 1 ? v.transfers[0].to : (v.transfers.length + ' recipients'), token: v.token, amount: spent, gasUsed: gasUsed });
      _recordOutcome(sched, v.auth, spent, v.token, 'success', lastHash, duration, gasUsed, null, { sender: agentAddr, recipient: v.transfers.length === 1 ? v.transfers[0].to : (v.transfers.length + ' recipients'), token: v.token, amount: spent, gasUsed: gasUsed });
      try { if (task) ExecutionQueue.updateStatus(task.id, 'completed', { txHash: lastHash, result: 'success', progress: 100 }); } catch(e){}
      _notify(sched, 'executed', 'Schedule "' + sched.name + '" executed by Agent Wallet ÔÇö ' + spent.toFixed(2) + ' ' + v.token + ' (tx ' + lastHash.slice(0, 10) + '...)', 'success');
      return { status: 'executed', txHash: lastHash };
    } catch(fatal) {
      var fReason = (fatal && (fatal.shortMessage || fatal.message)) ? String(fatal.shortMessage || fatal.message).substring(0, 140) : 'Unknown executor error';
      ledger[key] = { status: 'retry_pending', reason: fReason, ts: Date.now(), attempts: attempts, lastAttempt: Date.now() };
      _saveLedger();
      return { status: 'error', reason: fReason };
    } finally {
      delete _inFlight[key];
      var engF = _engine();
      if (_outcome === 'submitted' || _outcome === 'reconciling') {
        // Keep the claim marked 'submitted' (with txHash) so no other instance can
        // re-broadcast this occurrence. A later tick reconciles the receipt.
      } else {
        try { if (engF && typeof engF.releaseExecutionClaim === 'function') engF.releaseExecutionClaim(key, 'agent_schedule_executor'); } catch(_e) {}
      }
    }
  }

  /* ── Execute a scheduled MultiSend as a SEQUENTIAL payment queue ──
     Sends each recipient row ONE AT A TIME using the single-payment send path
     (_prepareTransfer + _signAndSend + _waitReceipt). The next row only starts after
     the previous transaction receipt is confirmed. The on-chain batch contract is
     NEVER used here. Per-row state (intent nonce + txHash of each submitted row) is
     persisted in the execution ledger so an interrupted run resumes or reconciles
     without re-sending already-confirmed rows. */
  function _emitProgress(sched, current, total, message) {
    try {
      if (typeof document !== 'undefined') {
        document.dispatchEvent(new CustomEvent('AGENT_SCHEDULE_PROGRESS', { detail: { scheduleId: sched ? sched.id : null, current: current, total: total, message: message, ts: Date.now() } }));
      }
    } catch(e){}
    try { if (sched && typeof schLogEntry === 'function') schLogEntry(sched.id, 'info', message); } catch(e){}
  }

  async function _executeMultiSendSequential(sched, key, v, provider, signer, agentAddr, startTime, attempts, defaults) {
    var transfers = v.transfers;
    var tokenInfo = v.tokenInfo;
    var total = v.total;

    // Per-row execution state — restored from a prior partial run (replay protection).
    var prior = ledger[key];
    var rows = (prior && Array.isArray(prior.rows) && prior.rows.length === transfers.length)
      ? prior.rows
      : transfers.map(function (t, i) { return { rowIndex: i, status: 'pending', to: t.to, amount: t.amount, txHash: null }; });

    var confirmed = 0;
    var spent = 0;
    var lastHash = '';
    var gasUsed = 0;

    var task = null;
    try {
      if (typeof ExecutionQueue !== 'undefined') {
        task = ExecutionQueue.enqueue({ type: 'scheduled', operation: 'scheduled:multisend', amount: total, asset: v.token, destination: transfers.length + ' recipients' });
        ExecutionQueue.updateStatus(task.id, 'running');
      }
    } catch(e){}

    // Sequential, one row at a time — never fires recipients concurrently.
    for (var i = 0; i < transfers.length; i++) {
      if (rows[i] && rows[i].status === 'completed') {
        confirmed++;
        spent += transfers[i].amount;
        lastHash = rows[i].txHash || lastHash;
        continue; // already confirmed — do not re-send
      }

      _emitProgress(sched, confirmed + 1, transfers.length, 'MultiSend: ' + (confirmed + 1) + ' / ' + transfers.length + ' — Processing recipient #' + (i + 1) + '...');

      var rowTxHash = null;
      var engM = _engine();

      // Reconcile a row whose broadcast was uncertain (crash between send and hash
      // persistence) — recover the original tx by nonce/fingerprint, NEVER re-broadcast.
      if (rows[i] && rows[i].status === 'execution_unknown' && rows[i].nonce != null) {
        var unk = await _resolveUnknownIntent(rows[i], provider);
        if (unk.resolved) {
          rowTxHash = unk.txHash; // recovered — do NOT re-broadcast
        } else {
          rows[i] = { rowIndex: i, status: 'failed', to: transfers[i].to, amount: transfers[i].amount, txHash: null, error: unk.reason };
          var unkNote = 'MultiSend recipient #' + (i + 1) + '/' + transfers.length + ' broadcast unknown: ' + unk.reason + (confirmed > 0 ? ' (' + confirmed + ' confirmed before failure)' : '');
          ledger[key] = { status: 'failed', reason: unkNote, ts: Date.now(), attempts: attempts, txHash: lastHash, rows: rows, amount: total, asset: v.token };
          _saveLedger();
          if (spent > 0) { try { _authz().recordUsage(v.auth.id, spent, 'scheduled:multisend', 'partial'); } catch(e){} }
          _advanceSchedule(sched, unkNote, 'failed', lastHash, { sender: agentAddr, recipient: transfers[i].to, token: v.token, amount: total, gasUsed: gasUsed, rows: rows });
          _pauseAfterFailure(sched, defaults)
          _notify(sched, 'failed', 'Schedule "' + sched.name + '" MultiSend broadcast unknown at recipient #' + (i + 1) + '/' + transfers.length + ' — ' + unk.reason, 'error');
          return { status: 'failed', reason: unkNote, rows: rows };
        }
      }

      if (!rowTxHash) {
        // Fresh broadcast: prepare (nonce+fingerprint), persist intent, then sign+send.
        var prep;
        try {
          prep = await _prepareTransfer(provider, agentAddr, tokenInfo, transfers[i]);
        } catch(prepErr) {
          rows[i] = { rowIndex: i, status: 'failed', to: transfers[i].to, amount: transfers[i].amount, txHash: null, error: (prepErr.shortMessage || prepErr.message || 'prepare error') };
          var prepNote = 'MultiSend recipient #' + (i + 1) + '/' + transfers.length + ' preparation failed: ' + ((prepErr.shortMessage || prepErr.message || 'prepare error')) + (confirmed > 0 ? ' (' + confirmed + ' confirmed before failure)' : '');
          ledger[key] = { status: 'failed', reason: prepNote, ts: Date.now(), attempts: attempts, txHash: lastHash, rows: rows, amount: total, asset: v.token };
          _saveLedger();
          if (spent > 0) { try { _authz().recordUsage(v.auth.id, spent, 'scheduled:multisend', 'partial'); } catch(e){} }
          _advanceSchedule(sched, prepNote, 'failed', lastHash, { sender: agentAddr, recipient: transfers[i].to, token: v.token, amount: total, gasUsed: gasUsed, rows: rows });
          _pauseAfterFailure(sched, defaults)
          _notify(sched, 'failed', 'Schedule "' + sched.name + '" MultiSend failed at recipient #' + (i + 1) + '/' + transfers.length, 'error');
          return { status: 'failed', reason: prepNote, rows: rows };
        }

        // Persist the row execution intent BEFORE broadcast (crash-safe recovery anchor).
        rows[i] = { rowIndex: i, status: 'execution_unknown', to: transfers[i].to, amount: transfers[i].amount, txHash: null, nonce: prep.nonce, from: prep.from, data: prep.data, value: prep.value, chainId: prep.chainId, fingerprint: prep.fingerprint };
        ledger[key] = { status: 'in_progress', ts: Date.now(), attempts: attempts, txHash: lastHash, rows: rows, amount: total, asset: v.token };
        _saveLedger();
        if (engM && typeof engM.updateExecutionClaim === 'function') engM.updateExecutionClaim(key, 'agent_schedule_executor', { status: 'execution_unknown', nonce: prep.nonce });

        try {
          rowTxHash = await _signAndSend(signer, provider, prep.rawTx);
        } catch(sendErr) {
          // Ambiguous broadcast — reconcile by nonce, never blind-retry.
          var unk2 = await _resolveUnknownIntent(rows[i], provider);
          if (unk2.resolved) {
            rowTxHash = unk2.txHash;
          } else {
            rows[i].status = 'failed';
            rows[i].error = unk2.reason;
            var unk2Note = 'MultiSend recipient #' + (i + 1) + '/' + transfers.length + ' broadcast unknown: ' + unk2.reason;
            ledger[key] = { status: 'failed', reason: unk2Note, ts: Date.now(), attempts: attempts, txHash: lastHash, rows: rows, amount: total, asset: v.token };
            _saveLedger();
            _advanceSchedule(sched, unk2Note, 'failed', lastHash, { sender: agentAddr, recipient: transfers[i].to, token: v.token, amount: total, gasUsed: gasUsed, rows: rows });
            _pauseAfterFailure(sched, defaults)
            _notify(sched, 'failed', 'Schedule "' + sched.name + '" MultiSend broadcast unknown at recipient #' + (i + 1) + '/' + transfers.length, 'error');
            return { status: 'failed', reason: unk2Note, rows: rows };
          }
        }
      }

      // txHash known — persist the row as 'submitted' IMMEDIATELY (before receipt).
      lastHash = rowTxHash;
      rows[i] = { rowIndex: i, status: 'submitted', to: transfers[i].to, amount: transfers[i].amount, txHash: rowTxHash, nonce: rows[i].nonce };
      ledger[key] = { status: 'in_progress', ts: Date.now(), attempts: attempts, txHash: lastHash, rows: rows, amount: total, asset: v.token };
      _saveLedger();
      if (engM && typeof engM.updateExecutionClaim === 'function') engM.updateExecutionClaim(key, 'agent_schedule_executor', { status: 'submitted', txHash: rowTxHash });

      var rec;
      try {
        rec = await _waitReceipt(provider, rowTxHash);
      } catch(wErr) {
        rec = { ok: false, txHash: rowTxHash, reason: (wErr.shortMessage || wErr.message || 'receipt error').substring(0, 120) };
      }
      if (!rec.ok) {
        rows[i].txHash = rec.txHash;
        rows[i].error = rec.reason || null;
        if (rec.receipt && rec.receipt.status === 0) {
          rows[i].status = 'failed';
          var revertNote = 'MultiSend recipient #' + (i + 1) + '/' + transfers.length + ' reverted on-chain';
          ledger[key] = { status: 'failed', reason: revertNote, ts: Date.now(), attempts: attempts, txHash: rec.txHash, rows: rows, amount: total, asset: v.token };
          _saveLedger();
          if (engM && typeof engM.updateExecutionClaim === 'function') engM.updateExecutionClaim(key, 'agent_schedule_executor', { status: 'failed', txHash: rec.txHash });
          _advanceSchedule(sched, revertNote, 'failed', rec.txHash, { sender: agentAddr, recipient: transfers[i].to, token: v.token, amount: total, gasUsed: gasUsed, rows: rows });
          _pauseAfterFailure(sched, defaults)
          _recordOutcome(sched, null, spent, v.token, 'failed', rec.txHash, Date.now() - startTime, gasUsed, revertNote, { sender: agentAddr, recipient: transfers[i].to, token: v.token, amount: spent, gasUsed: gasUsed });
          _notify(sched, 'failed', 'Schedule "' + sched.name + '" MultiSend reverted at recipient #' + (i + 1) + '/' + transfers.length, 'error');
          return { status: 'failed', reason: revertNote, rows: rows };
        }
        // Receipt timeout → keep row 'submitted', stop here and reconcile later. Never re-send.
        ledger[key] = { status: 'submitted', txHash: rec.txHash, rows: rows, ts: Date.now(), attempts: attempts, amount: total, asset: v.token };
        _saveLedger();
        _notify(sched, 'pending', 'Schedule "' + sched.name + '" MultiSend row submitted (tx ' + rec.txHash.slice(0, 10) + '...) — awaiting confirmation', 'info');
        return { status: 'submitted', txHash: rec.txHash, rows: rows };
      }

      confirmed++;
      spent += transfers[i].amount;
      rows[i] = { rowIndex: i, status: 'completed', to: transfers[i].to, amount: transfers[i].amount, txHash: rowTxHash };
      try { gasUsed += Number(rec.receipt.gasUsed || 0); } catch(e){}
      if (engM && typeof engM.renewExecutionClaim === 'function') engM.renewExecutionClaim(key, 'agent_schedule_executor');

      // Persist per-row progress after EVERY confirmed row (crash-safe resume).
      ledger[key] = { status: 'in_progress', ts: Date.now(), attempts: attempts, txHash: lastHash, rows: rows, amount: total, asset: v.token };
      _saveLedger();

      _emitProgress(sched, confirmed, transfers.length, 'MultiSend: ' + confirmed + ' / ' + transfers.length);
    }

    var duration = Date.now() - startTime;
    ledger[key] = { status: 'executed', ts: Date.now(), attempts: attempts, txHash: lastHash, amount: spent, asset: v.token, rows: rows };
    _saveLedger();
    var engM2 = _engine();
    if (engM2 && typeof engM2.updateExecutionClaim === 'function') engM2.updateExecutionClaim(key, 'agent_schedule_executor', { status: 'confirmed', txHash: lastHash || null });
    _advanceSchedule(sched, 'Executed by Agent Wallet — MultiSend ' + transfers.length + '/' + transfers.length + ' recipients (' + spent.toFixed(2) + ' ' + v.token + ')', 'executed', lastHash, { sender: agentAddr, recipient: transfers.length + ' recipients', token: v.token, amount: spent, gasUsed: gasUsed, rows: rows });
    _recordOutcome(sched, v.auth, spent, v.token, 'success', lastHash, duration, gasUsed, null, { sender: agentAddr, recipient: transfers.length + ' recipients', token: v.token, amount: spent, gasUsed: gasUsed, rows: rows });
    try { if (task) ExecutionQueue.updateStatus(task.id, 'completed', { txHash: lastHash, result: 'success', progress: 100 }); } catch(e){}
    _notify(sched, 'executed', 'Schedule "' + sched.name + '" MultiSend completed — ' + transfers.length + '/' + transfers.length + ' recipients processed', 'success');
    return { status: 'executed', txHash: lastHash, rows: rows };
  }

  /* Delegate swap/bridge/crosschain to the existing agent executors */
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
        _notify(sched, 'manual', 'Schedule "' + sched.name + '" (' + sched.type + ') is due ÔÇö agent executor unavailable, run manually', 'warning');
      }
      return { status: 'manual_required' };
    }

    try { _authz().recordUsage(v.auth.id, v.total, 'scheduled:' + sched.type, 'delegated'); } catch(e){}
    ledger[key] = { status: 'delegating', ts: Date.now(), attempts: attempts, amount: v.total, asset: v.token };
    _saveLedger();

    var delResult = null;
    // [AUTONOMA-0] Mark this invocation as a schedule delegation so the centralized
    // execution gate recognizes the already-validated + claimed occurrence and does
    // not re-claim it (avoiding a second idempotency authority for the same tx).
    var _prevDeleg = undefined;
    try { _prevDeleg = window.__autonomaScheduledDelegation; } catch(_e) {}
    try { window.__autonomaScheduledDelegation = { schedId: sched.id, key: key, ts: Date.now() }; } catch(_e) {}
    try {
      delResult = await fn.apply(null, args);
    } catch(delErr) {
      var delFailReason = (delErr.shortMessage || delErr.message || '').substring(0, 140);
      ledger[key] = { status: 'failed', reason: 'Delegated ' + sched.type + ' execution failed: ' + delFailReason, ts: Date.now(), attempts: attempts };
      _saveLedger();
      _recordOutcome(sched, v.auth, v.total, v.token, 'failed', null, Date.now() - startTime, 0, delFailReason, { token: v.token, amount: v.total });
      _advanceSchedule(sched, 'Delegated ' + sched.type + ' failed: ' + delFailReason, 'failed', null, { token: v.token, amount: v.total });
      _notify(sched, 'failed', 'Delegated ' + sched.type + ' failed to execute: ' + delFailReason, 'error');
      return { status: 'failed', reason: delFailReason };
    } finally {
      if (_prevDeleg !== undefined) { try { window.__autonomaScheduledDelegation = _prevDeleg; } catch(_e) {} }
      else { try { delete window.__autonomaScheduledDelegation; } catch(_e) {} }
    }

    if (delResult && (delResult === false || delResult.ok === false || delResult.success === false)) {
      var failReason = (delResult && (delResult.reason || delResult.error || delResult.message)) || 'Unknown delegation failure';
      ledger[key] = { status: 'failed', reason: failReason, ts: Date.now(), attempts: attempts };
      _saveLedger();
      _recordOutcome(sched, v.auth, v.total, v.token, 'failed', delResult && delResult.txHash || null, Date.now() - startTime, 0, failReason, { token: v.token, amount: v.total });
      _advanceSchedule(sched, 'Delegated ' + sched.type + ' returned failure: ' + failReason, 'failed', delResult && delResult.txHash || null, { token: v.token, amount: v.total });
      _notify(sched, 'failed', 'Delegated ' + sched.type + ' returned failure: ' + failReason, 'error');
      return { status: 'failed', reason: failReason };
    }

    var actualTxHash = (delResult && delResult.txHash) || null;
    var mintTxHash = (delResult && delResult.mintTxHash) || null;
    var txNote = actualTxHash ? ' \u00B7 tx ' + actualTxHash.slice(0, 10) + '...' : '';

    ledger[key] = { status: 'executed', ts: Date.now(), attempts: attempts, amount: v.total, asset: v.token, txHash: actualTxHash, mintTxHash: mintTxHash };
    _saveLedger();
    _advanceSchedule(sched, 'Executed by Agent Wallet ' + sched.type + ' executor \u2014 ' + v.total + ' ' + v.token + txNote, 'executed', actualTxHash, { token: v.token, amount: v.total, mintTxHash: mintTxHash });
    _recordOutcome(sched, v.auth, v.total, v.token, 'success', actualTxHash, Date.now() - startTime, 0, null, { token: v.token, amount: v.total, mintTxHash: mintTxHash });
    _notify(sched, 'executed', 'Schedule "' + sched.name + '" \u2014 Agent Wallet executed the ' + sched.type + ' (' + v.total + ' ' + v.token + ')' + txNote, 'success');
    return { status: 'executed', txHash: actualTxHash, mintTxHash: mintTxHash };
  }

  /* ÔöÇÔöÇ Tick loop ÔöÇÔöÇ */
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
    /* ── AUTONOMA-1 — single execution authority primitives ──
       Every Autonoma financial broadcast, nonce read and receipt wait must
       go through these (the ONLY eth_sendRawTransaction lives in `broadcast`). */
    broadcast: _signAndSend,
    waitReceipt: _waitReceipt,
    nextNonce: _nextNonce,
    SUPPORTED_TYPES: SUPPORTED_TYPES.slice(),
    ARC_CHAIN_ID: ARC_CHAIN_ID,
    version: '1.1.0'
  };

  if (typeof window !== 'undefined') window.AgentScheduleExecutor = API;
  else if (typeof globalThis !== 'undefined') globalThis.AgentScheduleExecutor = API;
})();
