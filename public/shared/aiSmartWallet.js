/**
 * AI Smart Wallet — Independent Financial Execution Layer (v1.0.0)
 *
 * Isolated, additive module. Zero modifications to existing systems.
 *
 * Architecture:
 *   Autonoma (AI Brain) → creates intents/schedules (unchanged)
 *   AI Smart Wallet     → receives intents → permission → risk → policy →
 *                         schedule → balance → nonce → deadline → chain
 *                         validation → hands execution to the EXISTING
 *                         Agent Wallet execution layer (ScheduleEngine +
 *                         AgentScheduler). Never signs or broadcasts itself.
 *
 * Reused engines (all optional, typeof-guarded, never duplicated):
 *   AgentAuthorization (permission engine)   PolicyEngine (policy engine)
 *   RiskEngine (risk engine)                 ScheduleEngine (schedule engine)
 *   AgentWalletManager (agent wallet)        AgentAudit (audit trail)
 *   window._agentCheckSchedules (execution tick)
 *
 * Attached to window.AIWallet
 */
(function () {
  'use strict';

  const VERSION = '1.0.0';

  /* ── Own storage namespace (never touches existing keys) ─────────── */
  const K = {
    mode: 'elligentt_aiw_mode_v1',
    estop: 'elligentt_aiw_estop_v1',
    limits: 'elligentt_aiw_limits_v1',
    intents: 'elligentt_aiw_intents_v1',
    history: 'elligentt_aiw_history_v1',
    nonce: 'elligentt_aiw_nonce_v1',
    usedNonces: 'elligentt_aiw_used_nonces_v1',
    settings: 'elligentt_aiw_settings_v1',
    stopPaused: 'elligentt_aiw_stop_paused_v1',
    vault: 'elligentt_aiw_vault_v1',
    gas: 'elligentt_aiw_gas_v1',
    gaslog: 'elligentt_aiw_gaslog_v1',
    approvals: 'elligentt_aiw_approvals_v1',
    profile: 'elligentt_aiw_profile_v1',
    workflows: 'elligentt_aiw_workflows_v1',
    wfstate: 'elligentt_aiw_wfstate_v1'
  };

  function lsLoad(key, def) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? def : JSON.parse(raw);
    } catch (_e) { return def; }
  }
  function lsSave(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (_e) { /* quota */ }
  }

  /* ── State ────────────────────────────────────────────────────────── */
  let mode = lsLoad(K.mode, 'hybrid');                 // 'personal' | 'ai' | 'hybrid'
  let emergencyStop = lsLoad(K.estop, false) === true;
  const limits = Object.assign({
    perOpUsd: 250,
    dailyUsd: 1000,
    monthlyUsd: 10000,
    allowedTokens: ['USDC', 'EURC'],
    allowedOps: ['payment', 'transfer', 'recurring', 'payroll', 'multisend', 'swap', 'bridge', 'crosschain', 'treasury'],
    allowedNetworks: ['Arc_Testnet'],
    hourStart: 0,
    hourEnd: 24
  }, lsLoad(K.limits, {}));
  const settings = Object.assign({
    autoExecute: false,          // approved intents still need 1 click unless enabled
    maxRisk: 'MEDIUM',           // LOW | MEDIUM | HIGH
    deadlineMinutes: 15,
    requireAgentAuth: true,      // consult AgentAuthorization when available
    lastTab: 'mission'
  }, lsLoad(K.settings, {}));
  let intents = lsLoad(K.intents, []);
  let history = lsLoad(K.history, []);
  const usedNonces = lsLoad(K.usedNonces, {});
  let nonceCounter = lsLoad(K.nonce, 0);
  let stopPausedIds = lsLoad(K.stopPaused, []);
  let portfolioCache = { at: 0, rows: [] };
  let monitorTimer = null;
  let balanceDedup = {}; // short-lived RPC dedup: addr:token → {promise,at}

  /* Vault allocations (internal ledger over REAL balances — never exceeds them) */
  const vault = Object.assign({
    USDC: { locked: 0, automation: 0, treasury: 0 },
    EURC: { locked: 0, automation: 0, treasury: 0 },
    cirBTC: { locked: 0, automation: 0, treasury: 0 }
  }, lsLoad(K.vault, {}));

  /* Gas manager config — on Arc the gas token IS USDC (native) */
  const gasCfg = Object.assign({
    minReserve: 1,          // USDC kept untouchable for gas
    topupEnabled: false,
    topupThreshold: 0.5,    // trigger below this
    topupAmount: 5,         // USDC per top-up
    topupSource: 'personal',// personal | vault | reserve
    topupPolicy: 'manual'   // [M8 FIX] manual | notify (never automatic — always requires user action)
  }, lsLoad(K.gas, {}));
  let gasLog = lsLoad(K.gaslog, []);          // [{at, hash, cost}] — real receipts only
  let nativeCache = { at: 0, bal: null };
  let topupLastNotify = 0;
  const approvals = lsLoad(K.approvals, []);  // pending user approvals (never auto-applied)
  let activeProfile = lsLoad(K.profile, 'custom');
  const workflows = lsLoad(K.workflows, []);  // workflow DEFINITIONS only — execution always approval-gated
  const wfState = Object.assign({ lastBalUSDC: null, lastPortfolioUsd: null, lastAuthCount: null, fired: {} }, lsLoad(K.wfstate, {}));
  const chatLog = [];                          // assistant conversation (session only)

  const NETWORKS = {
    Arc_Testnet: { chainId: 5042002, label: 'Arc Testnet' },
    Ethereum_Sepolia: { chainId: 11155111, label: 'Ethereum Sepolia' },
    Base_Sepolia: { chainId: 84532, label: 'Base Sepolia' },
    Arbitrum_Sepolia: { chainId: 421614, label: 'Arbitrum Sepolia' },
    Optimism_Sepolia: { chainId: 11155420, label: 'Optimism Sepolia' },
    Polygon_Amoy: { chainId: 80002, label: 'Polygon Amoy' }
  };
  const OP_TO_SCHED = {
    payment: 'payment', transfer: 'payment', recurring: 'payment', treasury: 'payment',
    payroll: 'multisend', multisend: 'multisend',
    swap: 'swap', bridge: 'bridge', crosschain: 'crosschain'
  };
  const OP_TO_AUTH = {
    payment: 'payment', transfer: 'payment', recurring: 'recurring', treasury: 'treasury',
    payroll: 'multisend', multisend: 'multisend',
    swap: 'swap', bridge: 'bridge', crosschain: 'crosschain'
  };
  const FALLBACK_TOKENS = {
    USDC: { address: '0x3600000000000000000000000000000000000000', decimals: 6 },
    EURC: { address: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a', decimals: 6 },
    cirBTC: { address: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF', decimals: 8 }
  };
  function arcTokens() {
    try {
      if (typeof CHAIN_REGISTRY !== 'undefined' && CHAIN_REGISTRY[5042002] && CHAIN_REGISTRY[5042002].tokens) {
        return CHAIN_REGISTRY[5042002].tokens;
      }
    } catch (_e) { /* ignore */ }
    return FALLBACK_TOKENS;
  }
  const ERC20_ABI = ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)', 'function decimals() view returns (uint8)'];

  /* ── Helpers ──────────────────────────────────────────────────────── */
  function $id(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function short(addr) {
    const a = String(addr || '');
    return a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : a;
  }
  /* strip HTML-relevant chars from names that flow into OTHER modules'
     renderers (e.g. Schedule page), which may not escape them */
  function plain(s) {
    return String(s == null ? '' : s).replace(/[<>&"'`]/g, '').replace(/[\u0000-\u001f]/g, '').slice(0, 80);
  }
  function usdRate(token) {
    try {
      if (typeof getTokenUSDRate === 'function') {
        const r = getTokenUSDRate(token);
        if (r && isFinite(r)) return r;
      }
    } catch (_e) { /* fall through */ }
    return token === 'EURC' ? 1.08 : 1;
  }
  function fmtUsd(n) {
    const v = Number(n) || 0;
    return '$' + v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  function notify(msg, kind) {
    try { if (typeof toast === 'function') { toast(msg, kind || 'info'); return; } } catch (_e) { /* ignore */ }
    try { console.log('[AIWallet] ' + msg); } catch (_e) { /* ignore */ }
  }
  function saveIntents() { lsSave(K.intents, intents.slice(0, 100)); }
  function pushHistory(entry) {
    history.unshift(Object.assign({ at: Date.now() }, entry));
    history = history.slice(0, 200);
    lsSave(K.history, history);
  }
  function spentUsdSince(ms) {
    const cutoff = Date.now() - ms;
    return history.reduce(function (sum, h) {
      if (h.at >= cutoff && h.kind === 'execution' && h.status === 'executed') {
        return sum + (Number(h.amountUsd) || 0);
      }
      return sum;
    }, 0);
  }
  function agentAddr() {
    try {
      if (typeof AgentWalletManager !== 'undefined' && AgentWalletManager.getAgentAddress) {
        return AgentWalletManager.getAgentAddress() || null;
      }
    } catch (_e) { /* ignore */ }
    return null;
  }
  function personalAddr() {
    try {
      if (window.__App && typeof window.__App.walletAddress !== 'undefined') return window.__App.walletAddress || null;
    } catch (_e) { /* ignore */ }
    try { if (typeof walletAddress !== 'undefined') return walletAddress || null; } catch (_e) { /* ignore */ }
    return null;
  }
  function arcRpc() {
    try {
      if (typeof AgentWalletManager !== 'undefined' && AgentWalletManager.ARC_RPC) return AgentWalletManager.ARC_RPC;
    } catch (_e) { /* ignore */ }
    return 'https://rpc.testnet.arc.network';
  }
  function getProvider() {
    if (typeof ethers === 'undefined') return null;
    try {
      if (typeof RPCManager !== 'undefined' && RPCManager.getHealthyRPC) {
        var r = RPCManager.getCurrentProvider();
        if (r) return r;
      }
    } catch (_e) { /* ignore */ }
    try {
      if (typeof getCachedProvider === 'function') return getCachedProvider(arcRpc());
    } catch (_e) { /* ignore */ }
    try { return new ethers.JsonRpcProvider(arcRpc()); } catch (_e) { return null; }
  }

  /* ══════════════════════════════════════════════════════════════════
     VALIDATION PIPELINE
     permission → balance → risk → policy → schedule → nonce → deadline
     → chain. Every check runs; execution aborts if ANY check fails.
     ══════════════════════════════════════════════════════════════════ */
  async function validateIntent(it) {
    const checks = [];
    function add(name, passed, reason) { checks.push({ name: name, passed: !!passed, reason: reason || '' }); }

    /* 0. Emergency stop */
    add('Emergency Stop', !emergencyStop, emergencyStop ? 'Emergency Stop is active — all AI Smart Wallet operations disabled' : 'Inactive');

    /* 1. Wallet mode */
    const modeOk = mode === 'ai' || mode === 'hybrid';
    add('Wallet Mode', modeOk, modeOk ? 'Mode "' + mode + '" allows autonomous execution' : 'Personal mode — autonomous execution disabled');

    /* 2. Chain validation */
    const net = NETWORKS[it.network];
    const chainAllowed = !!net && limits.allowedNetworks.indexOf(it.network) !== -1;
    add('Chain', chainAllowed, chainAllowed ? net.label + ' (' + net.chainId + ') allowed' : 'Network "' + it.network + '" not in allowed list');
    const execOnArc = it.network === 'Arc_Testnet';
    add('Execution Chain', execOnArc || OP_TO_SCHED[it.op] === 'bridge' || OP_TO_SCHED[it.op] === 'crosschain',
      execOnArc ? 'Agent executes on Arc' : 'Cross-chain ops route via existing bridge executor');

    /* 3. Token allowlist */
    const tokenOk = limits.allowedTokens.indexOf(it.token) !== -1;
    add('Token', tokenOk, tokenOk ? it.token + ' allowed' : 'Token ' + it.token + ' not allowed');

    /* 4. Operation allowlist */
    const opOk = limits.allowedOps.indexOf(it.op) !== -1;
    add('Operation', opOk, opOk ? it.op + ' allowed' : 'Operation "' + it.op + '" not allowed');

    /* 5. Time restrictions */
    const hour = new Date().getHours();
    const timeOk = limits.hourStart <= hour && hour < (limits.hourEnd === 0 ? 24 : limits.hourEnd);
    add('Time Window', timeOk, timeOk ? 'Within allowed hours (' + limits.hourStart + 'h–' + limits.hourEnd + 'h)' : 'Outside allowed execution hours');

    /* 6. Spending limits (per-op / daily / monthly) */
    const amountUsd = (Number(it.amount) || 0) * usdRate(it.token);
    add('Per-Op Limit', amountUsd <= limits.perOpUsd, fmtUsd(amountUsd) + ' vs max ' + fmtUsd(limits.perOpUsd));
    const daily = spentUsdSince(86400000);
    add('Daily Limit', daily + amountUsd <= limits.dailyUsd, fmtUsd(daily + amountUsd) + ' vs ' + fmtUsd(limits.dailyUsd) + '/day');
    const monthly = spentUsdSince(2592000000);
    add('Monthly Limit', monthly + amountUsd <= limits.monthlyUsd, fmtUsd(monthly + amountUsd) + ' vs ' + fmtUsd(limits.monthlyUsd) + '/month');

    /* 7. Permission engine (existing AgentAuthorization — reused) */
    if (settings.requireAgentAuth && typeof AgentAuthorization !== 'undefined') {
      try {
        const authOp = OP_TO_AUTH[it.op] || 'payment';
        const hasOp = AgentAuthorization.hasOperationAuth(authOp);
        if (!hasOp) {
          add('Permission Engine', false, 'No active authorization for "' + authOp + '" — grant it in AI Permissions');
        } else {
          const av = AgentAuthorization.validateExecution({
            operation: authOp, amount: Number(it.amount) || 0, asset: it.token,
            network: (net && net.label) || 'Arc Testnet', contract: '', destination: it.to || ''
          });
          add('Permission Engine', !!(av && av.valid), (av && av.reason) || (av && av.valid ? 'Authorized' : 'Denied by authorization scope'));
        }
      } catch (e) { add('Permission Engine', false, 'Permission check error: ' + (e.message || e)); }
    } else {
      add('Permission Engine', true, settings.requireAgentAuth ? 'AgentAuthorization unavailable — overlay limits enforced' : 'Agent auth consultation disabled (overlay limits still enforced)');
    }

    /* 8. Risk engine (existing RiskEngine — reused) */
    if (typeof RiskEngine !== 'undefined') {
      try {
        const risk = RiskEngine.analyze({
          operation: OP_TO_AUTH[it.op] || it.op, amount: Number(it.amount) || 0, asset: it.token,
          contract: '', destination: it.to || '', network: (net && net.label) || 'Arc Testnet', purpose: it.name || ''
        });
        const order = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
        const ok = order[risk.level] <= order[settings.maxRisk];
        it.riskLevel = risk.level;
        add('Risk Engine', ok, 'Risk ' + risk.level + (ok ? ' within max ' : ' exceeds max ') + settings.maxRisk);
      } catch (e) { add('Risk Engine', false, 'Risk analysis error: ' + (e.message || e)); }
    } else {
      const heurOk = amountUsd <= limits.perOpUsd;
      add('Risk Engine', heurOk, 'RiskEngine unavailable — heuristic amount check');
    }

    /* 9. Policy engine (existing PolicyEngine — reused) */
    if (typeof PolicyEngine !== 'undefined') {
      try {
        const pv = PolicyEngine.quickCheck(OP_TO_AUTH[it.op] || it.op, Number(it.amount) || 0, it.token, (net && net.label) || 'Arc Testnet');
        const failed = (pv && pv.failedRules) ? pv.failedRules.map(function (r) { return r.rule; }).join(', ') : '';
        add('Policy Engine', !!(pv && pv.valid), pv && pv.valid ? 'All policy rules passed' : 'Failed: ' + failed);
      } catch (e) { add('Policy Engine', false, 'Policy check error: ' + (e.message || e)); }
    } else {
      add('Policy Engine', true, 'PolicyEngine unavailable — overlay limits enforced');
    }

    /* 10. Schedule / executor readiness */
    let agentReady = false, agentReason = 'Agent Wallet unavailable';
    try {
      if (typeof AgentWalletManager !== 'undefined') {
        if (AgentWalletManager.isPaused && AgentWalletManager.isPaused()) agentReason = 'Agent Wallet is paused';
        else if (!agentAddr()) agentReason = 'Agent Wallet not created yet';
        else { agentReady = true; agentReason = 'Agent ' + short(agentAddr()) + ' ready'; }
      }
    } catch (e) { agentReason = 'Agent check error: ' + (e.message || e); }
    add('Schedule Engine', agentReady && typeof ScheduleEngine !== 'undefined', agentReady ? (typeof ScheduleEngine !== 'undefined' ? agentReason : 'ScheduleEngine unavailable') : agentReason);

    /* 11. Balance validation (agent wallet, on-chain read-only) */
    let onchainBal = null;
    var needBal = false;
    if (OP_TO_SCHED[it.op] === 'payment' || OP_TO_SCHED[it.op] === 'multisend' || OP_TO_SCHED[it.op] === 'swap') {
      needBal = true;
    }

    /* 11c. Gas reserve check — launch in parallel with balance check for performance */
    var balPromise = needBal ? tokenBalance(agentAddr(), it.token) : Promise.resolve(null);
    var gasPromise = nativeBalance(agentAddr(), false);
    var results = await Promise.allSettled([balPromise, gasPromise]);
    onchainBal = results[0].status === 'fulfilled' ? results[0].value : null;
    var gasBal = results[1].status === 'fulfilled' ? results[1].value : null;

    if (needBal) {
      var need = Number(it.amount) || 0;
      if (onchainBal === null) add('Balance', false, 'Balance check failed (RPC unavailable) — failing closed');
      else add('Balance', onchainBal >= need, 'Agent holds ' + onchainBal.toFixed(2) + ' ' + it.token + ' vs required ' + need);
    } else {
      add('Balance', true, 'Checked by bridge executor at execution time');
    }

    /* 11b. Vault allocation — AI spends ONLY operational/automation buckets */
    if (onchainBal !== null) {
      const v = vault[it.token] || { locked: 0, automation: 0, treasury: 0 };
      const operational = Math.max(0, onchainBal - (v.locked || 0) - (v.automation || 0) - (v.treasury || 0));
      const bucket = (it.freq && it.freq !== 'once') || it.source === 'automation-center' ? 'automation' : 'operational';
      const available = bucket === 'automation' ? (v.automation || 0) + operational : operational;
      const needAmt = Number(it.amount) || 0;
      add('Vault Allocation', available >= needAmt, 'Bucket "' + bucket + '" has ' + available.toFixed(2) + ' ' + it.token + ' spendable (locked/treasury/gas reserve untouchable)');
    } else {
      add('Vault Allocation', OP_TO_SCHED[it.op] === 'bridge' || OP_TO_SCHED[it.op] === 'crosschain', 'Evaluated with balance at execution time');
    }

    /* 11c. Gas reserve — abort if the agent cannot pay gas safely (result already fetched) */
    if (gasBal === null) add('Gas Reserve', false, 'Gas balance check failed (RPC) — failing closed');
    else {
      var gasOk = gasBal >= gasCfg.minReserve;
      add('Gas Reserve', gasOk, gasOk ? gasBal.toFixed(4) + ' USDC gas ≥ reserve ' + gasCfg.minReserve : 'Gas ' + gasBal.toFixed(4) + ' below reserve ' + gasCfg.minReserve + ' — use Auto Top-Up (Vault & Gas tab)');
      if (!gasOk) checkAutoTopup();
    }

    /* 12. Nonce validation (replay protection) */
    const nonceFree = !usedNonces[String(it.nonce)];
    add('Nonce', typeof it.nonce === 'number' && nonceFree, nonceFree ? 'Nonce #' + it.nonce + ' unused' : 'Nonce already consumed (replay blocked)');

    /* 13. Deadline validation */
    const deadlineOk = Number(it.deadline) > Date.now();
    add('Deadline', deadlineOk, deadlineOk ? 'Valid until ' + new Date(it.deadline).toLocaleTimeString() : 'Intent expired');

    return { valid: checks.every(function (c) { return c.passed; }), checks: checks };
  }

  async function tokenBalance(addr, token) {
    try {
      if (!addr || typeof ethers === 'undefined') return null;
      var meta = arcTokens()[token];
      if (!meta || !meta.address) return null;
      // Short-lived dedup cache — avoids duplicate RPC calls within same batch
      var dedupKey = String(addr).toLowerCase() + ':' + token;
      var cached = balanceDedup[dedupKey];
      if (cached && (Date.now() - cached.at) < 15000 && cached.val !== null) return cached.val;
      var provider = getProvider();
      if (!provider) return null;
      var c = new ethers.Contract(meta.address, ERC20_ABI, provider);
      var promise = c.balanceOf(addr);
      balanceDedup[dedupKey] = { promise: promise, at: Date.now() };
      var raw = await promise;
      var val = Number(ethers.formatUnits(raw, meta.decimals || 6));
      balanceDedup[dedupKey] = { val: val, at: Date.now() };
      // Cleanup stale entries periodically
      if (Object.keys(balanceDedup).length > 50) {
        var cutoff = Date.now() - 30000;
        var keys = Object.keys(balanceDedup);
        for (var i = 0; i < keys.length; i++) {
          if (balanceDedup[keys[i]].at < cutoff) delete balanceDedup[keys[i]];
        }
      }
      return val;
    } catch (_e) { return null; }
  }

  /* ══════════════════════════════════════════════════════════════════
     GAS ENGINE — real native balance (USDC is the gas token on Arc)
     Consumption is derived exclusively from real tx receipts.
     ══════════════════════════════════════════════════════════════════ */
  async function nativeBalance(addr, force) {
    if (!force && Date.now() - nativeCache.at < 30000 && nativeCache.bal !== null) return nativeCache.bal;
    try {
      if (!addr || typeof ethers === 'undefined') return null;
      const provider = getProvider();
      if (!provider) return null;
      const raw = await provider.getBalance(addr);
      nativeCache = { at: Date.now(), bal: Number(ethers.formatUnits(raw, 18)) };
      return nativeCache.bal;
    } catch (_e) { return null; }
  }

  function logGas(hash, cost) {
    if (!hash || !isFinite(cost) || cost <= 0) return;
    if (gasLog.some(function (g) { return g.hash === hash; })) return;
    gasLog.unshift({ at: Date.now(), hash: hash, cost: cost });
    gasLog = gasLog.slice(0, 300);
    lsSave(K.gaslog, gasLog);
  }

  async function recordReceiptGas(hash) {
    try {
      const provider = getProvider();
      if (!provider || !hash) return;
      const rc = await provider.getTransactionReceipt(hash);
      if (rc && rc.gasUsed) {
        const price = rc.gasPrice || rc.effectiveGasPrice || 0n;
        logGas(hash, Number(ethers.formatUnits(rc.gasUsed * price, 18)));
      }
    } catch (_e) { /* ignore */ }
  }

  function gasSums() {
    const now = Date.now();
    const sum = function (ms) {
      return gasLog.reduce(function (s, g) { return g.at >= now - ms ? s + g.cost : s; }, 0);
    };
    return { today: sum(86400000), week: sum(604800000), month: sum(2592000000) };
  }

  function avgGasPerTx() {
    if (!gasLog.length) return null;
    const take = gasLog.slice(0, 20);
    return take.reduce(function (s, g) { return s + g.cost; }, 0) / take.length;
  }

  async function gasStatus(force) {
    const bal = await nativeBalance(agentAddr(), force);
    let status = 'unknown';
    if (bal !== null) {
      if (bal < gasCfg.minReserve * 0.5) status = 'critical';
      else if (bal < gasCfg.minReserve) status = 'warning';
      else status = 'healthy';
    }
    const avg = avgGasPerTx();
    const sums = gasSums();
    const daily7 = gasLog.length ? Math.max(sums.week / 7, 0.000001) : null;
    return {
      bal: bal,
      status: status,
      avgPerTx: avg,
      capacity: (bal !== null && avg && avg > 0) ? Math.floor(Math.max(0, bal - gasCfg.minReserve) / avg) : null,
      runtimeDays: (bal !== null && daily7) ? Math.floor(bal / daily7) : null,
      sums: sums
    };
  }

  /* ══════════════════════════════════════════════════════════════════
     AI WALLET VAULT — internal allocation ledger over real balances.
     operational = real − locked − automation − treasury (derived, ≥0).
     AI may spend ONLY operational + automation. Locked & gas reserve
     are untouchable.
     ══════════════════════════════════════════════════════════════════ */
  /** [A5 FIX] Get REAL on-chain balance — prefer fresh RPC over portfolio cache */
  function agentRealBal(token) {
    // Try fresh on-chain via balanceDedup cache first
    var addr = agentAddr();
    if (addr && balanceDedup[String(addr).toLowerCase() + ':' + token]) {
      var dedup = balanceDedup[String(addr).toLowerCase() + ':' + token];
      if (dedup.val !== undefined && (Date.now() - dedup.at) < 30000) return dedup.val;
    }
    // Fallback to portfolio cache
    var row = portfolioCache.rows.find(function (r) { return r.tag === 'agent'; });
    if (!row) return null;
    var t = row.tokens.find(function (x) { return x.sym === token; });
    return t ? t.bal : null;
  }

  function vaultView(token) {
    const v = vault[token] || { locked: 0, automation: 0, treasury: 0 };
    const real = agentRealBal(token);
    const allocated = (v.locked || 0) + (v.automation || 0) + (v.treasury || 0);
    return {
      real: real,
      locked: v.locked || 0,
      automation: v.automation || 0,
      treasury: v.treasury || 0,
      operational: real === null ? null : Math.max(0, real - allocated),
      overAllocated: real !== null && allocated > real + 1e-9
    };
  }

  async function setVaultAlloc() {
    if (emergencyStop) { notify('Emergency Stop active — vault allocations are frozen', 'error'); return; }
    const token = ($id('aiw-vault-token') || {}).value || 'USDC';
    const num = function (id) { const v = parseFloat(($id(id) || {}).value); return isFinite(v) && v >= 0 ? v : 0; };
    const locked = num('aiw-vault-locked');
    const automation = num('aiw-vault-automation');
    const treasury = num('aiw-vault-treasury');
    const real = await tokenBalance(agentAddr(), token);
    if (real === null) { notify('Cannot verify on-chain balance (RPC) — allocation aborted', 'error'); return; }
    if (locked + automation + treasury > real + 1e-9) {
      notify('Allocation exceeds real balance (' + real.toFixed(2) + ' ' + token + ') — reduce amounts', 'error');
      return;
    }
    vault[token] = { locked: locked, automation: automation, treasury: treasury };
    lsSave(K.vault, vault);
    pushHistory({ kind: 'vault', status: 'allocated', reason: token + ' locked ' + locked + ' · automation ' + automation + ' · treasury ' + treasury });
    notify('Vault allocation saved for ' + token, 'success');
    renderVaultPanel(); renderPortfolioIntelligence(); renderHistory();
  }

  /* ══════════════════════════════════════════════════════════════════
     AUTO TOP-UP — never moves funds without explicit authorization.
     personal source requires the user's signature (manual approval).
     ══════════════════════════════════════════════════════════════════ */
  function saveGasCfg() {
    const num = function (id, def) { const v = parseFloat(($id(id) || {}).value); return isFinite(v) && v >= 0 ? v : def; };
    gasCfg.minReserve = num('aiw-gas-minreserve', gasCfg.minReserve);
    gasCfg.topupThreshold = num('aiw-topup-threshold', gasCfg.topupThreshold);
    gasCfg.topupAmount = num('aiw-topup-amount', gasCfg.topupAmount);
    gasCfg.topupSource = ($id('aiw-topup-source') || {}).value || gasCfg.topupSource;
    gasCfg.topupPolicy = ($id('aiw-topup-policy') || {}).value || gasCfg.topupPolicy;
    lsSave(K.gas, gasCfg);
    pushHistory({ kind: 'settings', status: 'gas_config_updated' });
    notify('Gas / Auto Top-Up configuration saved', 'success');
    renderVaultPanel(); renderHistory();
  }

  function toggleTopup() {
    gasCfg.topupEnabled = !gasCfg.topupEnabled;
    lsSave(K.gas, gasCfg);
    pushHistory({ kind: 'settings', status: gasCfg.topupEnabled ? 'topup_enabled' : 'topup_disabled' });
    renderVaultPanel();
  }

  async function checkAutoTopup() {
    if (!gasCfg.topupEnabled || emergencyStop) return;
    const bal = await nativeBalance(agentAddr(), true);
    if (bal === null || bal >= gasCfg.topupThreshold) return;
    if (Date.now() - topupLastNotify < 3600000) return;
    topupLastNotify = Date.now();
    pushHistory({ kind: 'gas', status: 'topup_needed', reason: 'gas ' + bal.toFixed(4) + ' < threshold ' + gasCfg.topupThreshold });
    notify('Gas low (' + bal.toFixed(4) + ' USDC). Auto Top-Up requires your approval — open AI Smart Wallet → Vault & Gas → Top Up Now', 'error');
    renderVaultPanel(); renderHistory();
  }

  async function topupNow() {
    if (emergencyStop) { notify('Emergency Stop active — Auto Top-Up frozen', 'error'); return; }
    if (gasCfg.topupSource === 'personal') {
      await depositToAgent('USDC', gasCfg.topupAmount);
      renderVaultPanel();
    } else if (gasCfg.topupSource === 'vault') {
      notify('Treasury Vault withdrawals stay in the existing Treasury page flow — withdraw there, then deposit here', 'info');
    } else {
      const vv = vaultView('USDC');
      notify('On Arc, USDC is the gas token — your Operational Balance (' + (vv.operational === null ? '—' : vv.operational.toFixed(2)) + ' USDC) already backs gas. Keep it above the ' + gasCfg.minReserve + ' USDC reserve.', 'info');
    }
  }


  /* ══════════════════════════════════════════════════════════════════
     INTENT LIFECYCLE
     [C3 FIX] Nonce with timestamp + random for replay protection
     ══════════════════════════════════════════════════════════════════ */
  function submitIntent(raw) {
    if (emergencyStop) { notify('Emergency Stop active — intent rejected', 'error'); return null; }
    // [C3 FIX] Nonce with timestamp-derived component for replay protection — survives localStorage clear
    nonceCounter += 1; lsSave(K.nonce, nonceCounter);
    var tsNonce = Date.now() * 1000 + (nonceCounter % 1000); // timestamp-based with counter uniqueness
    var it = {
      id: 'AIW-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
      op: String(raw.op || 'payment'),
      name: plain(raw.name || ''),
      amount: Number(raw.amount) || 0,
      token: String(raw.token || 'USDC').toUpperCase(),
      to: String(raw.to || ''),
      recipients: Array.isArray(raw.recipients) ? raw.recipients : [],
      network: String(raw.network || 'Arc_Testnet'),
      toNetwork: String(raw.toNetwork || 'Base_Sepolia'),
      swapToToken: raw.swapToToken || undefined,
      freq: String(raw.freq || 'once'),
      startAt: raw.startAt || null,
      source: String(raw.source || 'user'),
      nonce: tsNonce,                                   // [C3] Timestamp-derived nonce
      nonceCounter: nonceCounter,                        // [C3] Sequential counter for ordering
      deadline: Date.now() + (settings.deadlineMinutes * 60000) + tsNonce,
      status: 'validating',
      checks: [],
      schedId: null,
      createdAt: Date.now()
    };
    intents.unshift(it);
    intents = intents.slice(0, 100);
    saveIntents();
    renderExecutions();
    pushHistory({ kind: 'intent', status: 'received', intentId: it.id, op: it.op, amount: it.amount, token: it.token, source: it.source });
    validateIntent(it).then(function (res) {
      it.checks = res.checks;
      it.status = res.valid ? 'approved' : 'rejected';
      if (!res.valid) {
        it.reason = res.checks.filter(function (c) { return !c.passed; }).map(function (c) { return c.name; }).join(', ');
        pushHistory({ kind: 'validation', status: 'rejected', intentId: it.id, reason: it.reason });
      } else {
        pushHistory({ kind: 'validation', status: 'approved', intentId: it.id });
        if (settings.autoExecute) { executeIntent(it.id); }
      }
      saveIntents(); renderExecutions(); renderHistory();
      // Emit status to Autonoma via shared bridge
      try {
        if (typeof FinancialContext !== 'undefined' && FinancialContext.emitStatus) {
          FinancialContext.emitStatus({
            type: 'intent_validation',
            intentId: it.id,
            op: it.op,
            amount: it.amount,
            token: it.token,
            status: it.status,
            passed: res.checks.filter(function(c){return c.passed;}).length,
            total: res.checks.length,
            valid: res.valid,
            timestamp: Date.now()
          });
        }
      } catch (_e) {}
    });
    return it.id;
  }

  async function executeIntent(id) {
    const it = intents.find(function (x) { return x.id === id; });
    if (!it) return false;
    if (it.status === 'executing' || it.status === 'executed') return false;

    /* Full re-validation immediately before execution — abort on any failure */
    const res = await validateIntent(it);
    it.checks = res.checks;
    if (!res.valid) {
      it.status = 'rejected';
      it.reason = res.checks.filter(function (c) { return !c.passed; }).map(function (c) { return c.name + ': ' + c.reason; }).join(' | ');
      saveIntents(); renderExecutions();
      notify('Execution aborted — validation failed (' + it.reason.split('|')[0].trim() + ')', 'error');
      pushHistory({ kind: 'execution', status: 'aborted', intentId: it.id, reason: it.reason });
      return false;
    }

    /* Consume nonce (replay guard) */
    usedNonces[String(it.nonce)] = Date.now();
    lsSave(K.usedNonces, usedNonces);

    /* Hand off to the EXISTING Agent Wallet execution layer via ScheduleEngine */
    try {
      const schedType = OP_TO_SCHED[it.op] || 'payment';
      const sched = ScheduleEngine.create({
        type: schedType,
        name: 'AIW · ' + (it.name || it.op) + ' · ' + it.id,
        token: it.token,
        amount: it.amount,
        total: it.amount,
        network: it.network,
        fromNetwork: it.network,
        toNetwork: it.toNetwork,
        swapToToken: it.swapToToken,
        recipients: it.recipients.length ? it.recipients : (it.to ? [{ addr: it.to, amount: it.amount }] : []),
        address: it.to || '',
        freq: it.freq === 'once' ? 'once' : it.freq,
        nextRun: it.startAt ? new Date(it.startAt).toISOString() : new Date().toISOString(),
        createdBy: 'aiwallet',
        status: 'Active'
      });
      it.schedId = sched.id;
      it.status = 'executing';
      saveIntents(); renderExecutions();
      pushHistory({ kind: 'execution', status: 'dispatched', intentId: it.id, schedId: sched.id, op: it.op, amount: it.amount, token: it.token, amountUsd: (Number(it.amount) || 0) * usdRate(it.token) });
      notify('Intent ' + it.id + ' dispatched to Agent Wallet executor', 'success');
      /* Trigger the existing scheduler tick for immediate pickup */
      try { if (!it.startAt && typeof window._agentCheckSchedules === 'function') setTimeout(window._agentCheckSchedules, 400); } catch (_e) { /* next 60s tick */ }
      return true;
    } catch (e) {
      it.status = 'failed';
      it.reason = 'Dispatch error: ' + (e.message || e);
      saveIntents(); renderExecutions();
      pushHistory({ kind: 'execution', status: 'failed', intentId: it.id, reason: it.reason });
      notify('Dispatch failed: ' + (e.message || e), 'error');
      return false;
    }
  }

  function cancelIntent(id) {
    const it = intents.find(function (x) { return x.id === id; });
    if (!it) return;
    if (it.status === 'executing' && it.schedId && typeof ScheduleEngine !== 'undefined') {
      try { ScheduleEngine.update(it.schedId, { status: 'Paused' }); } catch (_e) { /* ignore */ }
    }
    it.status = 'cancelled';
    saveIntents(); renderExecutions();
    pushHistory({ kind: 'intent', status: 'cancelled', intentId: id });
  }

  /* Link schedule execution results back to intents (event-driven, read-only) */
  function onScheduleUpdated(detail) {
    if (!detail || !detail.item) return;
    const s = detail.item;
    const it = intents.find(function (x) { return x.schedId === s.id; });
    if (it && it.status === 'executing' && (s.execCount || 0) > 0) {
      it.status = 'executed';
      it.executedAt = Date.now();
      saveIntents();
      var execEntry = { kind: 'execution', status: 'executed', intentId: it.id, schedId: s.id, op: it.op, amount: it.amount, token: it.token, amountUsd: (Number(it.amount) || 0) * usdRate(it.token) };
      pushHistory(execEntry);
      notify('Intent ' + it.id + ' executed by Agent Wallet', 'success');
      renderExecutions(); renderHistory();
      // Emit status update to Autonoma via shared bridge
      try {
        if (typeof FinancialContext !== 'undefined' && FinancialContext.emitStatus) {
          FinancialContext.emitStatus({ type: 'intent_executed', intentId: it.id, schedId: s.id, amount: it.amount, token: it.token, status: 'executed', timestamp: Date.now() });
        }
      } catch (_e) {}
    }
    renderScheduled();
  }

  /* Observe intents created elsewhere (Autonoma / user) — read-only mirror */
  function onScheduleCreated(detail) {
    if (!detail || detail.createdBy === 'aiwallet') { renderScheduled(); return; }
    pushHistory({ kind: 'observed', status: 'created', schedId: detail.id, source: detail.createdBy || 'user', op: detail.type, amount: detail.amount, token: detail.token });
    renderScheduled(); renderHistory();
  }

  /* ══════════════════════════════════════════════════════════════════
     EMERGENCY STOP — scoped strictly to AI Smart Wallet automations
     ══════════════════════════════════════════════════════════════════ */
  function setEmergencyStop(on) {
    emergencyStop = !!on;
    lsSave(K.estop, emergencyStop);
    if (emergencyStop) {
      stopPausedIds = [];
      try {
        if (typeof ScheduleEngine !== 'undefined') {
          ScheduleEngine.getAll().forEach(function (s) {
            if (s.createdBy === 'aiwallet' && s.status === 'Active') {
              stopPausedIds.push(s.id);
              ScheduleEngine.update(s.id, { status: 'Paused' });
            }
          });
        }
      } catch (_e) { /* ignore */ }
      lsSave(K.stopPaused, stopPausedIds);
      pushHistory({ kind: 'security', status: 'emergency_stop_on', paused: stopPausedIds.length });
      notify('EMERGENCY STOP — ' + stopPausedIds.length + ' AI automation(s) paused. Rest of the app unaffected.', 'error');
    } else {
      try {
        if (typeof ScheduleEngine !== 'undefined') {
          stopPausedIds.forEach(function (sid) {
            const s = ScheduleEngine.getById(sid);
            if (s && s.status === 'Paused') ScheduleEngine.update(sid, { status: 'Active' });
          });
        }
      } catch (_e) { /* ignore */ }
      pushHistory({ kind: 'security', status: 'emergency_stop_off', resumed: stopPausedIds.length });
      stopPausedIds = [];
      lsSave(K.stopPaused, stopPausedIds);
      notify('Emergency Stop lifted — AI automations resumed', 'success');
    }
    renderStatus(); renderScheduled(); renderSecurity(); renderVaultPanel(); renderPortfolioIntelligence();
  }

  /* ══════════════════════════════════════════════════════════════════
     FUNDING SYSTEM — real on-chain transfers only (no mocks)
     Personal → AI (deposit, signed by the user's connected wallet)
     AI → Personal (withdraw) · AI → address (transfer) · AI → Treasury Vault
     ══════════════════════════════════════════════════════════════════ */
  let fundingBusy = false;

  function vaultAddress() {
    try { if (typeof TREASURY_VAULT_ADDRESS !== 'undefined' && TREASURY_VAULT_ADDRESS) return TREASURY_VAULT_ADDRESS; } catch (_e) { /* ignore */ }
    return null;
  }

  function explorerTx(hash) {
    return 'https://testnet.arcscan.app/tx/' + hash;
  }

  /** [A6 FIX] Get AGENT_MAX_GAS_USD from system config */
  function _getMaxGasUsd() {
    var max = 5;
    try {
      if (typeof SystemConfig !== 'undefined' && SystemConfig.AGENT_MAX_GAS_USD) {
        max = Number(SystemConfig.AGENT_MAX_GAS_USD);
      }
    } catch(_e) {}
    return max;
  }

  /** [A6 FIX] Estimate gas with AGENT_MAX_GAS_USD enforcement */
  async function _estimateGasSafe(contract, method, args) {
    try {
      var gasEst = await contract[method].estimateGas.apply(contract, args);
      var maxGasUsd = _getMaxGasUsd();
      // On Arc, USDC is native (1 USDC ≈ 1 gas unit for estimation)
      var gasLimit = Number(gasEst);
      if (gasLimit > maxGasUsd * 1000000) { // heuristic: 1M gas units ≈ 1 USDC on Arc
        notify('Gas estimate exceeds max allowed (' + maxGasUsd + ' USDC) — transaction aborted', 'error');
        return { ok: false, gasEst: gasEst };
      }
      return { ok: true, gasEst: gasEst };
    } catch(_e) { return { ok: true, gasEst: null }; } // let ethers handle default
  }

  async function fundingSubmit() {
    if (fundingBusy) { notify('A funding operation is already in progress', 'info'); return; }
    const flow = ($id('aiw-fund-flow') || {}).value || 'deposit';
    const token = ($id('aiw-fund-token') || {}).value || 'USDC';
    const amount = parseFloat(($id('aiw-fund-amount') || {}).value);
    const destRaw = (($id('aiw-fund-dest') || {}).value || '').trim();
    if (!isFinite(amount) || amount <= 0) { notify('Enter a valid amount', 'error'); return; }
    fundingBusy = true;
    const btn = $id('aiw-fund-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Signing…'; }
    try {
      if (flow === 'deposit') await depositToAgent(token, amount);
      else if (flow === 'withdraw') await agentSend(token, amount, personalAddr(), 'withdraw');
      else if (flow === 'transfer') await agentSend(token, amount, destRaw, 'transfer');
      else if (flow === 'vault') await agentSend(token, amount, vaultAddress(), 'vault');
    } finally {
      fundingBusy = false;
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-arrows-transfer-down"></i>Execute On-Chain'; }
    }
  }

  async function depositToAgent(token, amount) {
    const agent = agentAddr();
    if (!agent) { notify('AI Smart Wallet not created yet', 'error'); return false; }
    const from = personalAddr();
    let userSigner = null;
    try { if (typeof signer !== 'undefined') userSigner = signer; } catch (_e) { /* ignore */ }
    if (!from || !userSigner) { notify('Connect your Personal Wallet first (Connect button in the top bar)', 'error'); return false; }
    const meta = arcTokens()[token];
    if (!meta) { notify('Token not supported on Arc', 'error'); return false; }
    try {
      try { if (typeof ensureNetwork === 'function') await ensureNetwork(5042002); } catch (_e) { /* wallet may reject */ }
      try { if (typeof activeChainId !== 'undefined' && Number(activeChainId) !== 5042002) { notify('Switch your wallet to Arc Testnet first', 'error'); return false; } } catch (_e) { /* ignore */ }
      const c = new ethers.Contract(meta.address, ERC20_ABI, userSigner);
      // [A6 FIX] Gas limit enforcement
      var gasCheck = await _estimateGasSafe(c, 'transfer', [agent, ethers.parseUnits(String(amount), meta.decimals || 6)]);
      if(!gasCheck.ok) return false;
      const tx = await c.transfer(agent, ethers.parseUnits(String(amount), meta.decimals || 6), gasCheck.gasEst ? { gasLimit: gasCheck.gasEst } : {});
      notify('Deposit submitted — waiting for confirmation…', 'info');
      pushHistory({ kind: 'funding', status: 'submitted', op: 'deposit', amount: amount, token: token, txHash: tx.hash });
      renderHistory();
      const rc = await tx.wait();
      const ok = !!(rc && rc.status === 1);
      pushHistory({ kind: 'funding', status: ok ? 'confirmed' : 'failed', op: 'deposit', amount: amount, token: token, txHash: tx.hash });
      notify(ok ? 'Deposit confirmed on-chain' : 'Deposit transaction failed', ok ? 'success' : 'error');
      refreshPortfolio(true); renderHistory(); renderHistoryStats();
      return ok;
    } catch (e) {
      const msg = (e && (e.shortMessage || e.message)) || String(e);
      pushHistory({ kind: 'funding', status: 'failed', op: 'deposit', amount: amount, token: token, reason: msg.slice(0, 120) });
      notify('Deposit failed: ' + msg.slice(0, 90), 'error');
      renderHistory();
      return false;
    }
  }

  async function agentSend(token, amount, to, kind) {
    if (typeof AgentWalletManager === 'undefined' || !AgentWalletManager.getAgentSigner) { notify('Agent Wallet unavailable', 'error'); return; }
    if (!to || (typeof ethers !== 'undefined' && !ethers.isAddress(to))) { notify(kind === 'vault' ? 'Treasury Vault address unavailable' : 'Enter a valid destination address', 'error'); return; }
    const isSelfWithdraw = kind === 'withdraw' && personalAddr() && to.toLowerCase() === String(personalAddr()).toLowerCase();
    if (emergencyStop && !isSelfWithdraw) { notify('Emergency Stop active — only withdrawals to your own Personal Wallet are allowed', 'error'); return; }
    if (AgentWalletManager.isPaused && AgentWalletManager.isPaused() && !isSelfWithdraw) { notify('AI Wallet is paused — resume it in Security or withdraw to your own wallet', 'error'); return; }
    const meta = arcTokens()[token];
    if (!meta) { notify('Token not supported on Arc', 'error'); return; }
    try {
      const bal = await tokenBalance(agentAddr(), token);
      if (bal === null) { notify('Balance check failed (RPC) — aborting', 'error'); return; }
      if (bal < amount) { notify('Insufficient AI Wallet balance: ' + bal.toFixed(4) + ' ' + token, 'error'); return; }
      const aSigner = AgentWalletManager.getAgentSigner();
      if (!aSigner) { notify('Agent signer unavailable', 'error'); return; }
      const c = new ethers.Contract(meta.address, ERC20_ABI, aSigner);
      // [A6 FIX] Gas limit enforcement
      var agCheck = await _estimateGasSafe(c, 'transfer', [to, ethers.parseUnits(String(amount), meta.decimals || 6)]);
      if(!agCheck.ok) return;
      const tx = await c.transfer(to, ethers.parseUnits(String(amount), meta.decimals || 6), agCheck.gasEst ? { gasLimit: agCheck.gasEst } : {});
      notify(kind.charAt(0).toUpperCase() + kind.slice(1) + ' submitted — waiting for confirmation…', 'info');
      pushHistory({ kind: 'funding', status: 'submitted', op: kind, amount: amount, token: token, to: to, txHash: tx.hash });
      renderHistory();
      const rc = await tx.wait();
      recordReceiptGas(tx.hash);
      pushHistory({ kind: 'funding', status: rc && rc.status === 1 ? 'confirmed' : 'failed', op: kind, amount: amount, token: token, to: to, txHash: tx.hash });
      notify(rc && rc.status === 1 ? kind + ' confirmed on-chain' : kind + ' transaction failed', rc && rc.status === 1 ? 'success' : 'error');
      refreshPortfolio(true); renderHistory(); renderHistoryStats();
    } catch (e) {
      const msg = (e && (e.shortMessage || e.message)) || String(e);
      pushHistory({ kind: 'funding', status: 'failed', op: kind, amount: amount, token: token, reason: msg.slice(0, 120) });
      notify(kind + ' failed: ' + msg.slice(0, 90), 'error');
      renderHistory();
    }
  }

  function onFundFlowChange() {
    const flow = ($id('aiw-fund-flow') || {}).value || 'deposit';
    const destWrap = $id('aiw-fund-dest-wrap');
    if (destWrap) destWrap.style.display = flow === 'transfer' ? '' : 'none';
    const hint = $id('aiw-fund-hint');
    if (hint) {
      const map = {
        deposit: 'Personal Wallet → AI Smart Wallet. Signed by your connected wallet on Arc Testnet.',
        withdraw: 'AI Smart Wallet → your Personal Wallet. Signed by the Agent Wallet.',
        transfer: 'AI Smart Wallet → any address on Arc. Blocked while Emergency Stop is active.',
        vault: 'AI Smart Wallet → Treasury Vault (' + (vaultAddress() ? short(vaultAddress()) : 'unavailable') + '). Vault → AI flows are managed on the Treasury page.'
      };
      hint.textContent = map[flow] || '';
    }
  }

  /* ══════════════════════════════════════════════════════════════════
     RECEIVE ASSETS — address, copy, QR, supported chains
     ══════════════════════════════════════════════════════════════════ */
  let qrRenderedFor = null;
  function renderReceive() {
    const box = $id('aiw-receive-body');
    if (!box) return;
    const addr = agentAddr();
    const addrEl = $id('aiw-receive-addr');
    if (addrEl) addrEl.textContent = addr || 'Agent Wallet not created yet';
    const qrEl = $id('aiw-receive-qr');
    if (qrEl && addr && qrRenderedFor !== addr) {
      qrEl.innerHTML = '';
      try {
        if (typeof QRCode !== 'undefined') {
          new QRCode(qrEl, { text: addr, width: 108, height: 108, colorDark: '#000000', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
          qrRenderedFor = addr;
        } else {
          qrEl.innerHTML = '<div style="font-size:8.5px;color:var(--muted2)">QR library unavailable</div>';
        }
      } catch (_e) { /* ignore */ }
    }
  }

  function copyAgentAddress() {
    const addr = agentAddr();
    if (!addr) { notify('Agent Wallet not created yet', 'error'); return; }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(addr).then(function () { notify('Address copied', 'success'); });
        return;
      }
    } catch (_e) { /* fallback below */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = addr; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
      notify('Address copied', 'success');
    } catch (_e) { notify('Copy failed — address: ' + addr, 'info'); }
  }

  /* ══════════════════════════════════════════════════════════════════
     WALLET MANAGER — status + default executor (never touches the
     existing connection flow; connection stays in the app top bar)
     ══════════════════════════════════════════════════════════════════ */
  function renderWalletManager() {
    const box = $id('aiw-wm-body');
    if (!box) return;
    const p = personalAddr();
    let wtype = '';
    try { if (typeof activeWalletType !== 'undefined' && activeWalletType) wtype = ' · ' + activeWalletType; } catch (_e) { /* ignore */ }
    const a = agentAddr();
    let paused = false;
    try { paused = typeof AgentWalletManager !== 'undefined' && AgentWalletManager.isPaused && AgentWalletManager.isPaused(); } catch (_e) { /* ignore */ }
    function wRow(label, connected, detail, extra) {
      return '<div style="display:flex;align-items:center;gap:8px;padding:7px 9px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;background:rgba(0,0,0,.15)">' +
        '<span style="width:8px;height:8px;border-radius:50%;flex-shrink:0;background:' + (connected ? 'var(--green)' : 'var(--muted)') + '"></span>' +
        '<div style="flex:1;min-width:0"><div style="font-size:10px;font-weight:600;color:var(--text)">' + esc(label) + '</div>' +
        '<div style="font-size:8.5px;color:var(--muted2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(detail) + '</div></div>' +
        '<span class="chip" style="border:1px solid var(--border);color:' + (connected ? 'var(--green)' : 'var(--muted2)') + '">' + (connected ? 'Connected' : 'Disconnected') + '</span>' + (extra || '') + '</div>';
    }
    box.innerHTML =
      wRow('Personal Wallet', !!p, p ? short(p) + wtype : 'Use the Connect button in the top bar') +
      wRow('AI Smart Wallet', !!a && !paused, a ? short(a) + (paused ? ' · paused' : ' · Agent Wallet on Arc') : 'Not created yet') +
      '<div class="swap-label" style="margin-top:6px">Default Executor (AI operations)</div>' +
      '<div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:4px">' +
      ['personal', 'ai', 'hybrid'].map(function (m) {
        const lbl = m === 'personal' ? 'Personal Wallet' : m === 'ai' ? 'AI Smart Wallet' : 'Hybrid Mode';
        const on = mode === m;
        return '<button class="btn" style="font-size:8.5px;padding:3px 9px;' + (on ? 'border-color:var(--purple);color:var(--purple);background:rgba(167,139,250,.1)' : '') + '" onclick="AIWallet.setMode(\'' + m + '\')">' + lbl + (m === 'hybrid' ? ' ★' : '') + '</button>';
      }).join('') + '</div>' +
      '<div style="font-size:8px;color:var(--muted2);margin-top:6px">Personal = manual only · AI = autonomous authorized ops · Hybrid (recommended) = both. The existing connection flow is untouched.</div>';
  }

  /* ══════════════════════════════════════════════════════════════════
     PERMISSION GRANTS — thin UI over the EXISTING AgentAuthorization
     engine (no duplicated permission system)
     ══════════════════════════════════════════════════════════════════ */
  const GRANT_OPS = [
    { key: 'allowPayments', label: 'Payments' },
    { key: 'allowSwap', label: 'Swap' },
    { key: 'allowBridge', label: 'Bridge' },
    { key: 'allowCrosschain', label: 'Crosschain' },
    { key: 'allowScheduled', label: 'Scheduled Tasks' },
    { key: 'allowRecurring', label: 'Recurring' },
    { key: 'allowTreasury', label: 'Treasury' },
    { key: 'allowVault', label: 'Vault' }
  ];
  const grantSelection = { allowPayments: true, allowSwap: true, allowScheduled: true };

  function toggleGrantOp(el) {
    const key = el.getAttribute('data-aiw-grant');
    grantSelection[key] = !grantSelection[key];
    el.classList.toggle('on', !!grantSelection[key]);
  }

  function renderGrantOps() {
    const box = $id('aiw-grant-ops');
    if (!box) return;
    box.innerHTML = GRANT_OPS.map(function (o) {
      return '<span class="stg-toggle ' + (grantSelection[o.key] ? 'on' : '') + '" data-aiw-grant="' + o.key + '" style="font-size:8.5px;padding:4px 8px" onclick="AIWallet.toggleGrantOp(this)">' + o.label + '</span>';
    }).join('');
  }

  function grantPermission() {
    if (typeof AgentAuthorization === 'undefined') { notify('Permission engine unavailable', 'error'); return; }
    if (emergencyStop) { notify('Emergency Stop active — lift it before granting permissions', 'error'); return; }
    const num = function (id, def) { const v = parseFloat(($id(id) || {}).value); return isFinite(v) && v >= 0 ? v : def; };
    const maxSpending = num('aiw-grant-max', 0);
    const dailyLimit = num('aiw-grant-daily', 0);
    const maxTx = num('aiw-grant-maxtx', 0);
    const hours = Math.max(1, num('aiw-grant-hours', 24));
    const tokens = limits.allowedTokens.slice();
    const opts = {
      maxSpending: maxSpending || maxTx || 0,
      dailyLimit: dailyLimit || null,
      durationMs: hours * 3600000,
      allowedTokens: tokens.length ? tokens : ['USDC'],
      allowedNetworks: ['Arc Testnet'],
      maxRiskLevel: settings.maxRisk,
      timeWindow: (limits.hourStart > 0 || limits.hourEnd < 24) ? { start: limits.hourStart, end: limits.hourEnd } : null,
      purpose: 'AI Smart Wallet grant (max tx ' + (maxTx || '—') + ')',
      allowContracts: false
    };
    GRANT_OPS.forEach(function (o) { opts[o.key] = !!grantSelection[o.key]; });
    try {
      const auth = AgentAuthorization.createAuthorization(opts);
      if (maxTx > 0) limits.perOpUsd = Math.min(limits.perOpUsd, maxTx);
      lsSave(K.limits, limits);
      pushHistory({ kind: 'security', status: 'auth_granted', reason: auth.id + ' · ' + hours + 'h' });
      notify('Authorization ' + auth.id + ' granted until ' + new Date(auth.expiresAt).toLocaleString(), 'success');
    } catch (e) { notify('Grant failed: ' + (e.message || e), 'error'); }
    renderPermissions(); renderLimits(); renderHistory();
  }

  function revokeAllPerms() {
    if (typeof AgentAuthorization === 'undefined') return;
    try {
      AgentAuthorization.revokeAll('AI Smart Wallet — Security Center');
      pushHistory({ kind: 'security', status: 'auth_revoked_all' });
      notify('All agent authorizations revoked', 'success');
    } catch (e) { notify('Revoke failed: ' + (e.message || e), 'error'); }
    renderPermissions(); renderSecurityCenter(); renderHistory();
  }

  /* ══════════════════════════════════════════════════════════════════
     SECURITY CENTER — engine status, pause AI wallet, sessions
     ══════════════════════════════════════════════════════════════════ */
  function togglePauseAgent() {
    if (typeof AgentWalletManager === 'undefined') return;
    try {
      if (AgentWalletManager.isPaused()) {
        if (emergencyStop) { notify('Lift Emergency Stop before resuming', 'error'); return; }
        AgentWalletManager.resume();
        pushHistory({ kind: 'security', status: 'ai_wallet_resumed' });
        notify('AI Wallet resumed', 'success');
      } else {
        AgentWalletManager.pause();
        pushHistory({ kind: 'security', status: 'ai_wallet_paused' });
        notify('AI Wallet paused — autonomous executions halted', 'info');
      }
    } catch (e) { notify('Pause toggle failed: ' + (e.message || e), 'error'); }
    renderStatus(); renderSecurityCenter(); renderWalletManager(); renderAgentInfo(); renderHistory();
  }

  function renderSecurityCenter() {
    const eng = $id('aiw-sec-engines');
    if (eng) {
      function engRow(name, ok, detail) {
        return '<div style="display:flex;align-items:center;gap:7px;padding:4px 0;font-size:9.5px;border-bottom:1px solid rgba(255,255,255,.03)">' +
          '<span style="width:7px;height:7px;border-radius:50%;flex-shrink:0;background:' + (ok ? 'var(--green)' : 'var(--red)') + '"></span>' +
          '<span style="color:var(--text);min-width:120px">' + esc(name) + '</span>' +
          '<span style="color:var(--muted2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(detail) + '</span></div>';
      }
      let permDetail = 'unavailable';
      let permOk = false;
      try { if (typeof AgentAuthorization !== 'undefined') { const s = AgentAuthorization.getAuthSummary(); permOk = true; permDetail = s.count + ' active grant(s) · daily cap ' + fmtUsd(s.totalDailyLimit); } } catch (_e) { /* ignore */ }
      let polDetail = 'unavailable';
      let polOk = false;
      try { if (typeof PolicyEngine !== 'undefined') { const d = PolicyEngine.getDefaults(); polOk = true; polDetail = 'max ' + d.maxDailyOps + ' ops/day · gas cap $' + d.maxGasUsd; } } catch (_e) { /* ignore */ }
      const riskOk = typeof RiskEngine !== 'undefined';
      const schedOk = typeof ScheduleEngine !== 'undefined';
      let audDetail = 'unavailable';
      let audOk = false;
      try { if (typeof AgentAudit !== 'undefined') { audOk = true; audDetail = (AgentAudit.count || 0) + ' audit record(s)'; } } catch (_e) { /* ignore */ }
      eng.innerHTML =
        engRow('Permission Engine', permOk, permDetail) +
        engRow('Policy Engine', polOk, polDetail) +
        engRow('Risk Engine', riskOk, riskOk ? 'max accepted: ' + settings.maxRisk : 'unavailable') +
        engRow('Schedule Engine', schedOk, schedOk ? 'executor: existing Agent Wallet scheduler' : 'unavailable') +
        engRow('Audit Trail', audOk, audDetail);
    }
    const pauseBtn = $id('aiw-sec-pause-btn');
    if (pauseBtn) {
      let paused = false;
      try { paused = typeof AgentWalletManager !== 'undefined' && AgentWalletManager.isPaused(); } catch (_e) { /* ignore */ }
      pauseBtn.innerHTML = paused ? '<i class="ti ti-player-play"></i>Resume AI Wallet' : '<i class="ti ti-player-pause"></i>Pause AI Wallet';
      pauseBtn.style.color = paused ? 'var(--green)' : 'var(--yellow)';
      pauseBtn.style.borderColor = paused ? 'rgba(34,197,94,.4)' : 'rgba(245,158,11,.4)';
    }
    const sess = $id('aiw-sec-session');
    if (sess) {
      let html = '';
      try {
        if (typeof AgentWalletManager !== 'undefined' && AgentWalletManager.getSecureWalletSummary) {
          const s = AgentWalletManager.getSecureWalletSummary() || {};
          Object.keys(s).slice(0, 6).forEach(function (k) {
            const v = s[k];
            if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
              html += '<div style="display:flex;justify-content:space-between;font-size:9px;padding:2px 0"><span style="color:var(--muted2)">' + esc(k) + '</span><span style="color:var(--text)">' + esc(String(v)) + '</span></div>';
            }
          });
        }
      } catch (_e) { /* ignore */ }
      if (!html) html = '<div style="font-size:9px;color:var(--muted2)">Session details unavailable.</div>';
      sess.innerHTML = html;
    }
  }

  /* ══════════════════════════════════════════════════════════════════
     HISTORY DASHBOARD — read-only stats + real gas from receipts
     ══════════════════════════════════════════════════════════════════ */
  let gasCache = { at: 0, text: null, running: false };

  async function computeGasSpent() {
    if (gasCache.running) return;
    if (Date.now() - gasCache.at < 120000 && gasCache.text) { const el = $id('aiw-stat-gas'); if (el) el.textContent = gasCache.text; return; }
    gasCache.running = true;
    try {
      const provider = getProvider();
      if (!provider) return;
      const hashes = [];
      history.forEach(function (h) { if (h.txHash && hashes.indexOf(h.txHash) === -1) hashes.push(h.txHash); });
      try {
        if (typeof AgentAudit !== 'undefined' && AgentAudit.getRecords) {
          (AgentAudit.getRecords(10) || []).forEach(function (r) { if (r.transactionHash && hashes.indexOf(r.transactionHash) === -1) hashes.push(r.transactionHash); });
        }
      } catch (_e) { /* ignore */ }
      const take = hashes.slice(0, 8);
      if (!take.length) { gasCache = { at: Date.now(), text: 'no on-chain txs yet', running: false }; const el0 = $id('aiw-stat-gas'); if (el0) el0.textContent = gasCache.text; return; }
      let total = 0n;
      let counted = 0;
      for (let i = 0; i < take.length; i++) {
        try {
          const rc = await provider.getTransactionReceipt(take[i]);
          if (rc && rc.gasUsed) {
            const price = rc.gasPrice || rc.effectiveGasPrice || 0n;
            total += rc.gasUsed * price;
            counted++;
          }
        } catch (_e) { /* skip */ }
      }
      const val = Number(ethers.formatUnits(total, 18));
      gasCache = { at: Date.now(), text: val.toFixed(6) + ' USDC · last ' + counted + ' tx', running: false };
      const el = $id('aiw-stat-gas');
      if (el) el.textContent = gasCache.text;
    } catch (_e) { /* ignore */ } finally { gasCache.running = false; }
  }

  function renderHistoryStats() {
    const box = $id('aiw-hist-stats');
    if (!box) return;
    const executed = intents.filter(function (i) { return i.status === 'executed'; }).length;
    const failed = intents.filter(function (i) { return i.status === 'failed' || i.status === 'rejected'; }).length;
    const pending = intents.filter(function (i) { return ['validating', 'approved', 'executing'].indexOf(i.status) !== -1; }).length;
    const onchain = history.filter(function (h) { return h.txHash; }).length;
    let auditTotal = 0;
    try { if (typeof AgentAudit !== 'undefined') auditTotal = AgentAudit.count || 0; } catch (_e) { /* ignore */ }
    function stat(label, value, color) {
      return '<div style="flex:1;min-width:90px;background:rgba(0,0,0,.18);border:1px solid var(--border);border-radius:6px;padding:8px"><div class="st-lbl">' + esc(label) + '</div><div style="font-size:14px;font-weight:700;color:' + (color || 'var(--text)') + '">' + esc(String(value)) + '</div></div>';
    }
    box.innerHTML =
      stat('Total Intents', intents.length) +
      stat('Executed', executed, 'var(--green)') +
      stat('Failed / Rejected', failed, failed ? 'var(--red)' : 'var(--text)') +
      stat('Pending', pending, pending ? 'var(--yellow)' : 'var(--text)') +
      stat('On-chain Txs', onchain, 'var(--blue)') +
      stat('Agent Audit Ops', auditTotal, 'var(--purple)') +
      '<div style="flex:1.6;min-width:150px;background:rgba(0,0,0,.18);border:1px solid var(--border);border-radius:6px;padding:8px"><div class="st-lbl">Gas Spent (real, from receipts)</div><div id="aiw-stat-gas" style="font-size:11px;font-weight:600;color:var(--teal);margin-top:2px">calculating…</div></div>';
    computeGasSpent();
  }


  /* ══════════════════════════════════════════════════════════════════
     PORTFOLIO (read-only)
     ══════════════════════════════════════════════════════════════════ */
  async function refreshPortfolio(force) {
    var box = $id('aiw-portfolio-body');
    if (!box) return;
    if (!force && Date.now() - portfolioCache.at < 30000 && portfolioCache.rows.length) { renderPortfolio(); return; }
    if (box) box.innerHTML = '<div style="font-size:9.5px;color:var(--muted2)">Loading balances…</div>';
    var rows = [];
    var wallets = [
      { label: 'Personal Wallet', addr: personalAddr(), tag: 'personal' },
      { label: 'AI Agent Wallet', addr: agentAddr(), tag: 'agent' }
    ];

    // Use multicall for batch reads when available (avoids sequential RPC trips)
    for (var w = 0; w < wallets.length; w++) {
      var entry = { label: wallets[w].label, tag: wallets[w].tag, addr: wallets[w].addr, tokens: [], totalUsd: 0 };
      if (entry.addr) {
        var symbols = Object.keys(arcTokens());
        var tokenMetas = symbols.map(function(s) { return arcTokens()[s]; });
        var batchResults = null;
        try {
          if (typeof Multicall !== 'undefined' && tokenMetas.length > 1) {
            var provider = getProvider();
            if (provider) {
              batchResults = await Multicall.batchBalances(provider, entry.addr, tokenMetas);
            }
          }
        } catch (_e) { /* fall back to sequential */ }
        if (batchResults && batchResults.length) {
          for (var t = 0; t < batchResults.length; t++) {
            var sym = symbols[t];
            var bal = batchResults[t].error ? null : batchResults[t].formatted;
            if (bal !== null) {
              entry.tokens.push({ sym: sym, bal: bal, usd: bal * usdRate(sym) });
              entry.totalUsd += bal * usdRate(sym);
            }
          }
        } else {
          for (var t2 = 0; t2 < symbols.length; t2++) {
            var bal2 = await tokenBalance(entry.addr, symbols[t2]);
            if (bal2 !== null) {
              entry.tokens.push({ sym: symbols[t2], bal: bal2, usd: bal2 * usdRate(symbols[t2]) });
              entry.totalUsd += bal2 * usdRate(symbols[t2]);
            }
          }
        }
      }
      rows.push(entry);
    }
    portfolioCache = { at: Date.now(), rows: rows };
    // Update FinancialContext bridge for Autonoma to read
    try {
      var snap = { personal: {}, agent: {}, totalUsd: 0, at: Date.now() };
      rows.forEach(function(r) {
        var target = r.tag === 'agent' ? snap.agent : snap.personal;
        r.tokens.forEach(function(tok) { target[tok.sym] = tok.bal; });
        snap.totalUsd += r.totalUsd;
      });
      if (typeof FinancialContext !== 'undefined' && FinancialContext.updatePortfolioSnapshot) {
        FinancialContext.updatePortfolioSnapshot(snap);
      }
    } catch (_e) {}
    renderPortfolio();
  }

  /* ══════════════════════════════════════════════════════════════════
     FUND AI WALLET WIZARD — Personal → AI with allocation
     Steps: asset → amount → allocate → review → approve → transfer
     Reuses depositToAgent (no new funding flow).
     ══════════════════════════════════════════════════════════════════ */
  const wiz = { step: 0, asset: 'USDC', amount: 0, locked: 0, automation: 0, treasury: 0, approved: false, busy: false };

  function wizOpen() {
    if (emergencyStop) { notify('Emergency Stop active — funding wizard frozen', 'error'); return; }
    wiz.step = 1; wiz.asset = 'USDC'; wiz.amount = 0; wiz.locked = 0; wiz.automation = 0; wiz.treasury = 0; wiz.approved = false; wiz.busy = false;
    const m = $id('aiw-wiz-modal');
    if (m) m.classList.add('open');
    renderWizard();
  }
  function wizClose() {
    const m = $id('aiw-wiz-modal');
    if (m) m.classList.remove('open');
    wiz.step = 0;
  }
  function wizBack() { if (wiz.step > 1 && !wiz.busy) { wiz.step--; renderWizard(); } }
  async function wizNext() {
    if (wiz.busy) return;
    if (wiz.step === 1) { wiz.asset = ($id('aiw-wiz-asset') || {}).value || 'USDC'; }
    if (wiz.step === 2) {
      const a = parseFloat(($id('aiw-wiz-amount') || {}).value);
      if (!isFinite(a) || a <= 0) { notify('Enter a valid amount', 'error'); return; }
      wiz.amount = a;
    }
    if (wiz.step === 3) {
      const num = function (id) { const v = parseFloat(($id(id) || {}).value); return isFinite(v) && v >= 0 ? v : 0; };
      wiz.locked = num('aiw-wiz-locked'); wiz.automation = num('aiw-wiz-automation'); wiz.treasury = num('aiw-wiz-treasury');
      if (wiz.locked + wiz.automation + wiz.treasury > wiz.amount + 1e-9) { notify('Allocations exceed the deposit amount', 'error'); return; }
      // [A7 FIX] Validate on-chain personal wallet balance before proceeding to review
      wiz.step = 4; renderWizard(); // show review while loading
      var persBal = await tokenBalance(personalAddr(), wiz.asset);
      if (persBal === null) { notify('Cannot verify Personal Wallet balance (RPC) — try again', 'error'); wiz.step = 3; renderWizard(); return; }
      if (persBal < wiz.amount) { notify('Insufficient balance: ' + persBal.toFixed(2) + ' ' + wiz.asset + ' in Personal Wallet (need ' + wiz.amount + ')', 'error'); wiz.step = 3; renderWizard(); return; }
      return; // wizNext will be called again by user clicking Next on review
    }
    if (wiz.step === 5) {
      if (!wiz.approved) { notify('Tick the approval checkbox first', 'error'); return; }
      wiz.step = 6; renderWizard();
      wiz.busy = true;
      try {
        const ok = await depositToAgent(wiz.asset, wiz.amount);
        if (ok) {
          const v = vault[wiz.asset] || { locked: 0, automation: 0, treasury: 0 };
          vault[wiz.asset] = {
            locked: (v.locked || 0) + wiz.locked,
            automation: (v.automation || 0) + wiz.automation,
            treasury: (v.treasury || 0) + wiz.treasury
          };
          lsSave(K.vault, vault);
          pushHistory({ kind: 'vault', status: 'wizard_funded', reason: wiz.amount + ' ' + wiz.asset + ' → locked ' + wiz.locked + ' / automation ' + wiz.automation + ' / treasury ' + wiz.treasury + ' / operational ' + (wiz.amount - wiz.locked - wiz.automation - wiz.treasury).toFixed(2) });
          renderVaultPanel(); renderPortfolioIntelligence(); renderHistory();
        } else {
          notify('Allocation NOT applied — the deposit did not confirm', 'error');
        }
      } finally { wiz.busy = false; }
      wizClose();
      return;
    }
    wiz.step = Math.min(6, wiz.step + 1);
    renderWizard();
  }
  function wizApprove(el) { wiz.approved = !!(el && el.checked); }

  function renderWizard() {
    const box = $id('aiw-wiz-body');
    const stepEl = $id('aiw-wiz-step');
    if (!box) return;
    if (stepEl) stepEl.textContent = 'Step ' + wiz.step + ' of 6';
    const opBal = wiz.amount - wiz.locked - wiz.automation - wiz.treasury;
    const steps = {
      1: '<div class="swap-label">Select Asset</div><select class="cinput" id="aiw-wiz-asset" style="width:100%;cursor:pointer"><option' + (wiz.asset === 'USDC' ? ' selected' : '') + '>USDC</option><option' + (wiz.asset === 'EURC' ? ' selected' : '') + '>EURC</option><option' + (wiz.asset === 'cirBTC' ? ' selected' : '') + '>cirBTC</option></select><div style="font-size:8.5px;color:var(--muted2);margin-top:6px">USDC and EURC are the primary assets. Deposits run on Arc Testnet.</div>',
      2: '<div class="swap-label">Enter Amount (' + esc(wiz.asset) + ')</div><input class="cinput" id="aiw-wiz-amount" type="number" min="0" step="0.01" value="' + (wiz.amount || '') + '" placeholder="0.00" style="width:100%"/>',
      3: '<div class="swap-label">Allocate Funds (' + esc(String(wiz.amount)) + ' ' + esc(wiz.asset) + ')</div>' +
        '<div style="display:flex;flex-direction:column;gap:6px;margin-top:4px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span style="font-size:9.5px;color:var(--muted2)">Locked Balance (AI cannot spend)</span><input class="cinput" id="aiw-wiz-locked" type="number" min="0" value="' + wiz.locked + '" style="width:90px"/></div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span style="font-size:9.5px;color:var(--muted2)">Automation Balance (schedules only)</span><input class="cinput" id="aiw-wiz-automation" type="number" min="0" value="' + wiz.automation + '" style="width:90px"/></div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span style="font-size:9.5px;color:var(--muted2)">Treasury Allocation</span><input class="cinput" id="aiw-wiz-treasury" type="number" min="0" value="' + wiz.treasury + '" style="width:90px"/></div>' +
        '<div style="font-size:8.5px;color:var(--muted2)">Remainder becomes <b style="color:var(--text)">Operational Balance</b> (AI spendable). Gas reserve is managed in Vault &amp; Gas.</div></div>',
      4: '<div class="swap-label">Review</div><div style="font-size:10px;display:flex;flex-direction:column;gap:4px;margin-top:4px">' +
        '<div style="display:flex;justify-content:space-between"><span style="color:var(--muted2)">Flow</span><span style="color:var(--text)">Personal Wallet → AI Smart Wallet</span></div>' +
        '<div style="display:flex;justify-content:space-between"><span style="color:var(--muted2)">Asset / Amount</span><span style="color:var(--text)">' + esc(String(wiz.amount)) + ' ' + esc(wiz.asset) + '</span></div>' +
        '<div style="display:flex;justify-content:space-between"><span style="color:var(--muted2)">Operational</span><span style="color:var(--green)">' + opBal.toFixed(2) + '</span></div>' +
        '<div style="display:flex;justify-content:space-between"><span style="color:var(--muted2)">Locked</span><span style="color:var(--text)">' + wiz.locked.toFixed(2) + '</span></div>' +
        '<div style="display:flex;justify-content:space-between"><span style="color:var(--muted2)">Automation</span><span style="color:var(--text)">' + wiz.automation.toFixed(2) + '</span></div>' +
        '<div style="display:flex;justify-content:space-between"><span style="color:var(--muted2)">Treasury</span><span style="color:var(--text)">' + wiz.treasury.toFixed(2) + '</span></div>' +
        '<div style="display:flex;justify-content:space-between"><span style="color:var(--muted2)">Destination</span><span style="color:var(--text);font-family:monospace">' + esc(short(agentAddr() || '—')) + '</span></div></div>',
      5: '<div class="swap-label">Approve</div><label style="display:flex;gap:8px;align-items:flex-start;font-size:9.5px;color:var(--muted2);cursor:pointer;margin-top:4px"><input type="checkbox" onchange="AIWallet.wizApprove(this)" style="margin-top:2px"/> I authorize transferring ' + esc(String(wiz.amount)) + ' ' + esc(wiz.asset) + ' from my Personal Wallet to the AI Smart Wallet with the allocation above. My wallet will ask for a signature.</label>',
      6: '<div style="font-size:10px;color:var(--text);display:flex;align-items:center;gap:8px"><i class="ti ti-loader" style="color:var(--yellow)"></i>Transferring on-chain — confirm in your wallet…</div>'
    };
    box.innerHTML = steps[wiz.step] || '';
    const back = $id('aiw-wiz-back');
    const next = $id('aiw-wiz-next');
    if (back) back.style.visibility = wiz.step > 1 && wiz.step < 6 ? 'visible' : 'hidden';
    if (next) {
      next.style.display = wiz.step === 6 ? 'none' : '';
      next.textContent = wiz.step === 5 ? 'Approve & Transfer' : 'Next';
    }
  }

  /* ══════════════════════════════════════════════════════════════════
     PHASE 3 RENDERS — Vault & Gas panel, Portfolio Intelligence,
     Schedule dashboard, Automation stats (all real data)
     ══════════════════════════════════════════════════════════════════ */
  function renderVaultPanel() {
    const vb = $id('aiw-vault-body');
    if (vb) {
      const token = ($id('aiw-vault-token') || {}).value || 'USDC';
      const vv = vaultView(token);
      const fmtB = function (n) { return n === null ? '—' : n.toFixed(2) + ' ' + token; };
      function bRow(label, val, color, note) {
        return '<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.03);font-size:10px">' +
          '<span style="color:var(--muted2)">' + esc(label) + ' <span style="font-size:8px">' + esc(note || '') + '</span></span>' +
          '<span style="font-weight:700;color:' + color + '">' + esc(val) + '</span></div>';
      }
      vb.innerHTML =
        bRow('Real On-Chain Balance', fmtB(vv.real), 'var(--text)', '') +
        bRow('Operational Balance', fmtB(vv.operational), 'var(--green)', '· AI spendable') +
        bRow('Locked Balance', fmtB(vv.locked), 'var(--red)', '· AI cannot spend') +
        bRow('Automation Balance', fmtB(vv.automation), 'var(--blue)', '· schedules only') +
        bRow('Treasury Allocation', fmtB(vv.treasury), 'var(--purple)', '· treasury ops only') +
        (vv.overAllocated ? '<div style="font-size:8.5px;color:var(--red);margin-top:5px"><i class="ti ti-alert-triangle"></i> Allocations exceed the real balance — reduce them.</div>' : '') +
        '<div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:8px">' +
        '<div><div class="swap-label">Locked</div><input class="cinput" id="aiw-vault-locked" type="number" min="0" value="' + vv.locked + '" style="width:80px"/></div>' +
        '<div><div class="swap-label">Automation</div><input class="cinput" id="aiw-vault-automation" type="number" min="0" value="' + vv.automation + '" style="width:80px"/></div>' +
        '<div><div class="swap-label">Treasury</div><input class="cinput" id="aiw-vault-treasury" type="number" min="0" value="' + vv.treasury + '" style="width:80px"/></div>' +
        '<button class="btn primary" style="font-size:9px;align-self:flex-end" onclick="AIWallet.setVaultAlloc()">Save Allocation</button></div>' +
        '<div style="font-size:8px;color:var(--muted2);margin-top:5px">Allocations are validated against the real on-chain balance before saving. Frozen while Emergency Stop is active.</div>';
    }
    const gb = $id('aiw-gas-body');
    if (gb) {
      gb.innerHTML = '<div style="font-size:9.5px;color:var(--muted2)">Reading on-chain gas balance…</div>';
      gasStatus(false).then(function (g) {
        const el = $id('aiw-gas-body');
        if (!el) return;
        const stColor = { healthy: 'var(--green)', warning: 'var(--yellow)', critical: 'var(--red)', unknown: 'var(--muted2)' }[g.status];
        el.innerHTML =
          '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">' +
          '<div style="flex:1;min-width:110px;background:rgba(0,0,0,.18);border:1px solid var(--border);border-radius:6px;padding:8px"><div class="st-lbl">Gas Balance (native)</div><div style="font-size:13px;font-weight:700;color:var(--text)">' + (g.bal === null ? 'RPC unavailable' : g.bal.toFixed(4) + ' USDC') + '</div></div>' +
          '<div style="flex:1;min-width:90px;background:rgba(0,0,0,.18);border:1px solid var(--border);border-radius:6px;padding:8px"><div class="st-lbl">Gas Health</div><div style="font-size:13px;font-weight:700;color:' + stColor + ';text-transform:capitalize">' + esc(g.status) + '</div></div>' +
          '<div style="flex:1;min-width:90px;background:rgba(0,0,0,.18);border:1px solid var(--border);border-radius:6px;padding:8px"><div class="st-lbl">Min Reserve</div><div style="font-size:13px;font-weight:700;color:var(--text)">' + gasCfg.minReserve + ' USDC</div></div>' +
          '<div style="flex:1;min-width:110px;background:rgba(0,0,0,.18);border:1px solid var(--border);border-radius:6px;padding:8px"><div class="st-lbl">Est. Capacity</div><div style="font-size:13px;font-weight:700;color:var(--text)">' + (g.capacity === null ? 'no tx data yet' : '~' + g.capacity + ' txs') + '</div></div>' +
          '<div style="flex:1;min-width:110px;background:rgba(0,0,0,.18);border:1px solid var(--border);border-radius:6px;padding:8px"><div class="st-lbl">Est. Runtime</div><div style="font-size:13px;font-weight:700;color:var(--text)">' + (g.runtimeDays === null ? 'no tx data yet' : '~' + g.runtimeDays + ' days') + '</div></div></div>' +
          '<div style="font-size:9px;color:var(--muted2)">Consumption (real receipts): today <b style="color:var(--text)">' + g.sums.today.toFixed(6) + '</b> · week <b style="color:var(--text)">' + g.sums.week.toFixed(6) + '</b> · month <b style="color:var(--text)">' + g.sums.month.toFixed(6) + '</b> USDC</div>' +
          '<div style="display:flex;gap:7px;align-items:flex-end;margin-top:7px;flex-wrap:wrap">' +
          '<div><div class="swap-label">Min Reserve (USDC)</div><input class="cinput" id="aiw-gas-minreserve" type="number" min="0" step="0.1" value="' + gasCfg.minReserve + '" style="width:90px"/></div>' +
          '<button class="btn" style="font-size:9px" onclick="AIWallet.saveGasCfg()">Save</button>' +
          '<span style="font-size:8px;color:var(--muted2)">Supported chains: Arc Testnet (agent executes here) · cross-chain via existing Bridge</span></div>';
      });
    }
    const tb = $id('aiw-topup-body');
    if (tb) {
      tb.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 0">' +
        '<span style="font-size:10px;color:var(--muted2)">Auto Top-Up</span>' +
        '<span class="stg-toggle ' + (gasCfg.topupEnabled ? 'on' : '') + '" style="min-width:44px" onclick="AIWallet.toggleTopup()"></span></div>' +
        '<div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:5px">' +
        '<div><div class="swap-label">Threshold (USDC)</div><input class="cinput" id="aiw-topup-threshold" type="number" min="0" step="0.1" value="' + gasCfg.topupThreshold + '" style="width:90px"/></div>' +
        '<div><div class="swap-label">Top-Up Amount</div><input class="cinput" id="aiw-topup-amount" type="number" min="0" step="0.1" value="' + gasCfg.topupAmount + '" style="width:90px"/></div>' +
        '<div><div class="swap-label">Source</div><select class="cinput" id="aiw-topup-source" style="width:150px;cursor:pointer">' +
        '<option value="personal"' + (gasCfg.topupSource === 'personal' ? ' selected' : '') + '>Personal Wallet</option>' +
        '<option value="vault"' + (gasCfg.topupSource === 'vault' ? ' selected' : '') + '>Treasury Vault</option>' +
        '<option value="reserve"' + (gasCfg.topupSource === 'reserve' ? ' selected' : '') + '>AI Wallet Reserve</option></select></div>' +
        '<div><div class="swap-label">Policy</div><select class="cinput" id="aiw-topup-policy" style="width:140px;cursor:pointer">' +
        '<option value="manual"' + (gasCfg.topupPolicy === 'manual' ? ' selected' : '') + '>Manual Approval</option>' +
        '<option value="notify"' + (gasCfg.topupPolicy === 'notify' || gasCfg.topupPolicy === 'automatic' ? ' selected' : '') + '>Notify Only (no auto-move)</option></select></div></div>' +
        '<div style="display:flex;gap:6px;margin-top:8px">' +
        '<button class="btn" style="font-size:9px" onclick="AIWallet.saveGasCfg()">Save Config</button>' +
        '<button class="btn primary" style="font-size:9px" onclick="AIWallet.topupNow()"><i class="ti ti-gas-station"></i>Top Up Now</button></div>' +
        '<div style="font-size:8px;color:var(--muted2);margin-top:5px">Funds never move without your authorization — Personal Wallet top-ups always require your signature. Balances are validated before execution. Frozen under Emergency Stop.</div>';
    }
  }

  function renderPortfolioIntelligence() {
    const box = $id('aiw-pi-body');
    if (!box) return;
    let total = 0;
    portfolioCache.rows.forEach(function (r) { total += r.totalUsd; });
    const vUS = vaultView('USDC');
    const vEU = vaultView('EURC');
    const aiAvail = (vUS.operational === null ? 0 : vUS.operational * usdRate('USDC')) + (vEU.operational === null ? 0 : vEU.operational * usdRate('EURC'));
    const lockedUsd = vUS.locked * usdRate('USDC') + vEU.locked * usdRate('EURC');
    let scheds = [];
    try { if (typeof ScheduleEngine !== 'undefined') scheds = ScheduleEngine.getAll(); } catch (_e) { /* ignore */ }
    const now = Date.now();
    const week = scheds.filter(function (s) { return s.status === 'Active' && s.nextRun && new Date(s.nextRun).getTime() <= now + 604800000; });
    const upcomingUsd = week.reduce(function (s, x) { return s + (Number(x.total || x.amount) || 0) * usdRate(x.token || 'USDC'); }, 0);
    const mine = scheds.filter(function (s) { return s.createdBy === 'aiwallet'; });
    const activeAuto = mine.filter(function (s) { return s.status === 'Active'; }).length;
    const monthCost = mine.filter(function (s) { return s.status === 'Active' && s.freq !== 'once'; }).reduce(function (s, x) {
      const per = (Number(x.amount) || 0) * usdRate(x.token || 'USDC');
      const mult = { daily: 30, weekly: 4.3, biweekly: 2.15, monthly: 1 }[x.freq] || 1;
      return s + per * mult;
    }, 0);
    let healthPts = 0;
    try { if (agentAddr()) healthPts += 25; } catch (_e) { /* ignore */ }
    try { if (typeof AgentWalletManager !== 'undefined' && !AgentWalletManager.isPaused()) healthPts += 20; } catch (_e) { /* ignore */ }
    try { if (typeof AgentAuthorization !== 'undefined' && AgentAuthorization.getAuthSummary().hasAuthorization) healthPts += 20; } catch (_e) { /* ignore */ }
    if (!emergencyStop) healthPts += 15;
    if (nativeCache.bal !== null && nativeCache.bal >= gasCfg.minReserve) healthPts += 20;
    function pi(label, value, color) {
      return '<div style="flex:1;min-width:105px;background:rgba(0,0,0,.18);border:1px solid var(--border);border-radius:6px;padding:8px"><div class="st-lbl">' + esc(label) + '</div><div style="font-size:12.5px;font-weight:700;color:' + (color || 'var(--text)') + '">' + esc(String(value)) + '</div></div>';
    }
    box.innerHTML =
      pi('Total Portfolio', fmtUsd(total), 'var(--green)') +
      pi('AI Available', fmtUsd(aiAvail), 'var(--blue)') +
      pi('Locked', fmtUsd(lockedUsd), 'var(--red)') +
      pi('Gas Balance', nativeCache.bal === null ? '—' : nativeCache.bal.toFixed(4) + ' USDC', 'var(--teal)') +
      pi('Upcoming 7d', fmtUsd(upcomingUsd) + ' · ' + week.length + ' ops', 'var(--yellow)') +
      pi('Monthly Automation Cost', fmtUsd(monthCost), 'var(--purple)') +
      pi('Monthly Spending', fmtUsd(spentUsdSince(2592000000))) +
      pi('AI Health Score', healthPts + '/100', healthPts >= 70 ? 'var(--green)' : healthPts >= 40 ? 'var(--yellow)' : 'var(--red)') +
      pi('Automations', activeAuto + ' active' + (emergencyStop ? ' · FROZEN' : ''), emergencyStop ? 'var(--red)' : 'var(--text)');
  }

  function renderSchedDash() {
    const box = $id('aiw-sched-dash');
    if (!box) return;
    let all = [];
    try { if (typeof ScheduleEngine !== 'undefined') all = ScheduleEngine.getAll(); } catch (_e) { /* ignore */ }
    const now = new Date();
    const endToday = new Date(now); endToday.setHours(23, 59, 59, 999);
    const endTomorrow = new Date(endToday.getTime() + 86400000);
    const active = all.filter(function (s) { return s.status === 'Active' && s.nextRun; });
    const groups = {
      "Today's Tasks": active.filter(function (s) { return new Date(s.nextRun) <= endToday; }),
      "Tomorrow's Tasks": active.filter(function (s) { const d = new Date(s.nextRun); return d > endToday && d <= endTomorrow; }),
      'Upcoming Tasks': active.filter(function (s) { return new Date(s.nextRun) > endTomorrow; })
    };
    const avg = avgGasPerTx();
    let html = '';
    Object.keys(groups).forEach(function (label) {
      const list = groups[label];
      html += '<div class="st-lbl" style="margin-top:6px">' + esc(label) + ' (' + list.length + ')</div>';
      if (!list.length) { html += '<div style="font-size:8.5px;color:var(--muted2);padding:3px 0">None.</div>'; return; }
      list.slice(0, 6).forEach(function (s) {
        html += '<div style="display:flex;align-items:center;gap:7px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;margin-top:4px;background:rgba(0,0,0,.15);font-size:9px">' +
          '<span style="color:var(--text);font-weight:600">' + esc(String(s.amount)) + ' ' + esc(s.token) + '</span>' +
          '<span style="color:var(--muted2)">' + esc(s.type) + '</span>' +
          '<span style="color:var(--muted2)">' + esc(new Date(s.nextRun).toLocaleString()) + '</span>' +
          '<span class="chip" style="border:1px solid var(--border);color:var(--purple)">' + (s.createdBy === 'aiwallet' ? 'AI Smart Wallet' : 'Agent Wallet') + '</span>' +
          '<span style="margin-left:auto;color:var(--muted2)">gas ' + (avg ? '~' + avg.toFixed(6) : '—') + '</span></div>';
      });
    });
    const failed = [];
    const completed = [];
    all.forEach(function (s) {
      (s.executionHistory || []).slice(-5).forEach(function (h) {
        (h.status === 'executed' ? completed : failed).push({ s: s, h: h });
      });
    });
    html += '<div class="st-lbl" style="margin-top:8px">Recent Executions (' + completed.length + ' ok · ' + failed.length + ' failed)</div>';
    completed.slice(-4).reverse().forEach(function (x) {
      html += '<div style="font-size:8.5px;color:var(--muted2);padding:2px 0"><span style="color:var(--green)">✓</span> ' + esc(x.h.amount + ' ' + x.h.token + ' · ' + x.h.type + ' · ' + new Date(x.h.timestamp).toLocaleString()) + (x.h.agent ? ' · by ' + esc(short(x.h.agent)) : '') + '</div>';
    });
    if (!completed.length) html += '<div style="font-size:8.5px;color:var(--muted2)">No executions recorded yet.</div>';
    box.innerHTML = html;
  }

  const TIMELINE_STEPS = ['Created', 'Authorized', 'Queued', 'Executing', 'Completed'];
  function timelineIdx(status) {
    return { validating: 0, approved: 1, executing: 3, executed: 4, rejected: 1, failed: 3, cancelled: 1 }[status] || 0;
  }
  function timelineHtml(it) {
    const idx = timelineIdx(it.status);
    const dead = it.status === 'rejected' || it.status === 'failed' || it.status === 'cancelled';
    return '<div style="display:flex;align-items:center;gap:3px;margin-top:4px;flex-wrap:wrap">' + TIMELINE_STEPS.map(function (s, i) {
      let color = 'var(--muted)';
      if (i < idx) color = 'var(--green)';
      else if (i === idx) color = dead ? 'var(--red)' : (it.status === 'executed' ? 'var(--green)' : 'var(--yellow)');
      return '<span style="font-size:7.5px;color:' + color + '">' + s + '</span>' + (i < TIMELINE_STEPS.length - 1 ? '<span style="font-size:7.5px;color:var(--muted)">→</span>' : '');
    }).join('') + '</div>';
  }

  function renderAutoStats() {
    const box = $id('aiw-autostats');
    if (!box) return;
    let mine = [];
    try { if (typeof ScheduleEngine !== 'undefined') mine = ScheduleEngine.getAll().filter(function (s) { return s.createdBy === 'aiwallet'; }); } catch (_e) { /* ignore */ }
    const cats = [
      { label: 'Recurring Payments', match: function (s) { return s.type === 'payment' && s.freq !== 'once'; } },
      { label: 'Payroll / MultiSend', match: function (s) { return s.type === 'multisend'; } },
      { label: 'Scheduled Swaps', match: function (s) { return s.type === 'swap'; } },
      { label: 'Crosschain / Bridge', match: function (s) { return s.type === 'bridge' || s.type === 'crosschain'; } },
      { label: 'One-time / Custom', match: function (s) { return s.type === 'payment' && s.freq === 'once'; } }
    ];
    const vUS = vaultView('USDC');
    let html = '';
    cats.forEach(function (c) {
      const list = mine.filter(c.match);
      if (!list.length) return;
      const totalRuns = list.reduce(function (s, x) { return s + (x.execCount || 0); }, 0);
      const processed = list.reduce(function (s, x) {
        return s + (x.executionHistory || []).reduce(function (a, h) { return a + (Number(h.amount) || 0); }, 0);
      }, 0);
      const next = list.filter(function (x) { return x.status === 'Active' && x.nextRun; }).map(function (x) { return new Date(x.nextRun).getTime(); }).sort()[0];
      const last = list.map(function (x) { return x.lastExecuted ? new Date(x.lastExecuted).getTime() : 0; }).sort().reverse()[0];
      let permOk = false;
      try { if (typeof AgentAuthorization !== 'undefined') permOk = AgentAuthorization.hasOperationAuth(list[0].type === 'multisend' ? 'multisend' : list[0].type === 'payment' ? 'payment' : list[0].type); } catch (_e) { /* ignore */ }
      html += '<div style="border:1px solid var(--border);border-radius:6px;padding:8px;margin-bottom:6px;background:rgba(0,0,0,.15)">' +
        '<div style="display:flex;align-items:center;gap:6px"><span style="font-size:10px;font-weight:600;color:var(--text)">' + esc(c.label) + '</span>' +
        '<span class="chip" style="border:1px solid var(--border);color:' + (permOk ? 'var(--green)' : 'var(--yellow)') + '">' + (permOk ? 'authorized' : 'no grant') + '</span>' +
        '<span style="margin-left:auto;font-size:8.5px;color:var(--muted2)">' + list.length + ' automation(s)</span></div>' +
        '<div style="font-size:8.5px;color:var(--muted2);margin-top:3px">Runs: ' + totalRuns + ' · Processed: ' + processed.toFixed(2) + ' · Allocation avail: ' + (vUS.automation + (vUS.operational || 0)).toFixed(2) + ' USDC · Daily cap: ' + fmtUsd(limits.dailyUsd) +
        ' · Next: ' + (next ? new Date(next).toLocaleString() : '—') + ' · Last: ' + (last ? new Date(last).toLocaleString() : 'never') + '</div></div>';
    });
    if (!html) html = '<div style="font-size:9px;color:var(--muted2)">No AI Smart Wallet automations yet — create one below.</div>';
    box.innerHTML = html;
  }

  /* ══════════════════════════════════════════════════════════════════
     PHASE 4 · AI APPROVAL CENTER — centralizes every request that
     needs explicit user approval. Never bypasses security layers.
     ══════════════════════════════════════════════════════════════════ */
  function saveApprovals() {
    if (approvals.length > 50) approvals.length = 50;
    lsSave(K.approvals, approvals);
  }

  function queueApproval(type, title, detail, payload) {
    const a = {
      id: 'APR-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      type: type, title: title, detail: detail, payload: payload || {},
      status: 'pending', createdAt: Date.now()
    };
    approvals.unshift(a);
    saveApprovals();
    pushHistory({ kind: 'approval', status: 'queued', reason: title });
    renderApprovals(); renderMission(); updatePendingBadge();
    return a.id;
  }

  function approveRequest(id) {
    const a = approvals.find(function (x) { return x.id === id; });
    if (!a || a.status !== 'pending') return;
    if (emergencyStop) { notify('Emergency Stop active — approvals frozen', 'error'); return; }
    try {
      if (a.type === 'permission_change') {
        if (typeof AgentAuthorization === 'undefined') { notify('Permission engine unavailable', 'error'); return; }
        const auth = AgentAuthorization.createAuthorization(a.payload.grantOpts || {});
        a.result = 'granted ' + auth.id;
        pushHistory({ kind: 'security', status: 'auth_granted', reason: auth.id + ' (approved from Approval Center)' });
      } else if (a.type === 'intent_execute') {
        executeIntent(a.payload.intentId);
        a.result = 'execution dispatched';
      } else if (a.type === 'vault_change') {
        const p = a.payload;
        vaultApply(p.token, p.changes, 'approved via Approval Center');
        a.result = 'vault updated';
      } else if (a.type === 'schedule_create') {
        if (typeof ScheduleEngine === 'undefined') { notify('ScheduleEngine unavailable', 'error'); return; }
        const s = ScheduleEngine.create(Object.assign({ createdBy: 'aiwallet' }, a.payload.sched));
        a.result = 'schedule ' + s.id + ' created';
        pushHistory({ kind: 'observed', status: 'created', schedId: s.id, source: 'approval-center', op: s.type, amount: s.amount, token: s.token });
      } else if (a.type === 'pause_automations') {
        let n = 0;
        try {
          ScheduleEngine.getAll().forEach(function (s) {
            if (s.createdBy === 'aiwallet' && s.status === 'Active') { ScheduleEngine.update(s.id, { status: 'Paused' }); n++; }
          });
        } catch (_e) { /* ignore */ }
        a.result = n + ' automation(s) paused';
        pushHistory({ kind: 'security', status: 'ai_wallet_paused', reason: 'assistant request — ' + n + ' automations' });
      } else if (a.type === 'workflow_run') {
        const acts = a.payload.actions || [];
        const outs = [];
        acts.forEach(function (ac) {
          if (ac.type === 'create_intent') { const iid = submitIntent(ac.intent); outs.push('intent ' + iid); }
          else if (ac.type === 'vault_allocate') { vaultApply(ac.token, ac.changes, 'workflow ' + a.payload.workflowId); outs.push('vault updated'); }
          else if (ac.type === 'create_schedule' && typeof ScheduleEngine !== 'undefined') { const ns = ScheduleEngine.create(Object.assign({ createdBy: 'aiwallet' }, ac.sched)); outs.push('schedule ' + ns.id); }
        });
        a.result = outs.join(' · ') || 'no transactional actions';
        wfLog(a.payload.workflowId, 'approved & dispatched: ' + a.result);
      }
      a.status = 'approved'; a.decidedAt = Date.now();
      saveApprovals();
      notify('Request ' + a.id + ' approved', 'success');
    } catch (e) { notify('Approval failed: ' + (e.message || e), 'error'); }
    renderApprovals(); renderPermissions(); renderMission(); renderTimeline(); updatePendingBadge();
    renderVaultPanel(); renderScheduled(); renderWorkflows();
  }

  function rejectRequest(id) {
    const a = approvals.find(function (x) { return x.id === id; });
    if (!a || a.status !== 'pending') return;
    a.status = 'rejected'; a.decidedAt = Date.now();
    saveApprovals();
    pushHistory({ kind: 'approval', status: 'rejected', reason: a.title });
    renderApprovals(); renderMission(); renderTimeline(); updatePendingBadge();
  }

  function renderApprovals() {
    // [L5 FIX] Auto-expire pending approvals older than 48 hours
    var cutoff = Date.now() - 172800000; // 48h
    var expiredCount = 0;
    for(var i = approvals.length - 1; i >= 0; i--){
      if(approvals[i].status === 'pending' && approvals[i].createdAt < cutoff){
        approvals[i].status = 'expired';
        approvals[i].decidedAt = Date.now();
        expiredCount++;
      }
    }
    if(expiredCount > 0){
      saveApprovals();
      pushHistory({ kind: 'approval', status: 'auto_expired', reason: expiredCount + ' approval(s) expired (>48h)' });
    }
    const box = $id('aiw-approvals-body');
    if (!box) return;
    const pendingAppr = approvals.filter(function (a) { return a.status === 'pending'; });
    const awaitingIntents = intents.filter(function (i) { return i.status === 'approved'; });
    const validatingIntents = intents.filter(function (i) { return i.status === 'validating'; });
    let html = '';
    if (pendingAppr.length) {
      html += '<div class="st-lbl">Pending Requests (' + pendingAppr.length + ')</div>';
      pendingAppr.forEach(function (a) {
        html += '<div style="border:1px solid var(--border);border-radius:6px;padding:8px;margin-top:5px;background:rgba(0,0,0,.15)">' +
          '<div style="display:flex;align-items:center;gap:6px"><span class="chip chip-p">' + esc(a.type.replace('_', ' ')) + '</span>' +
          '<span style="font-size:10px;font-weight:600;color:var(--text)">' + esc(a.title) + '</span>' +
          '<span style="margin-left:auto;display:flex;gap:4px">' +
          '<button class="btn" style="font-size:8.5px;padding:2px 9px;border-color:rgba(34,197,94,.4);color:var(--green)" onclick="AIWallet.approveRequest(\'' + esc(a.id) + '\')">Approve</button>' +
          '<button class="btn" style="font-size:8.5px;padding:2px 9px;border-color:rgba(239,68,68,.4);color:var(--red)" onclick="AIWallet.rejectRequest(\'' + esc(a.id) + '\')">Reject</button></span></div>' +
          '<div style="font-size:8.5px;color:var(--muted2);margin-top:3px">' + esc(a.detail) + ' · ' + new Date(a.createdAt).toLocaleString() + '</div></div>';
      });
    }
    if (awaitingIntents.length) {
      html += '<div class="st-lbl" style="margin-top:8px">Validated Intents Awaiting Execution (' + awaitingIntents.length + ')</div>';
      awaitingIntents.forEach(function (i) {
        html += '<div style="border:1px solid var(--border);border-radius:6px;padding:8px;margin-top:5px;background:rgba(0,0,0,.15)">' +
          '<div style="display:flex;align-items:center;gap:6px"><span class="chip chip-b">' + esc(i.op) + '</span>' +
          '<span style="font-size:10px;font-weight:600;color:var(--text)">' + esc(String(i.amount)) + ' ' + esc(i.token) + (i.to ? ' → ' + esc(short(i.to)) : '') + '</span>' +
          (i.riskLevel ? '<span style="font-size:8px;color:var(--muted2)">risk ' + esc(i.riskLevel) + '</span>' : '') +
          '<span style="margin-left:auto;display:flex;gap:4px">' +
          '<button class="btn" style="font-size:8.5px;padding:2px 9px;border-color:rgba(34,197,94,.4);color:var(--green)" onclick="AIWallet.executeIntent(\'' + esc(i.id) + '\')">Approve &amp; Execute</button>' +
          '<button class="btn" style="font-size:8.5px;padding:2px 9px;border-color:rgba(239,68,68,.4);color:var(--red)" onclick="AIWallet.cancelIntent(\'' + esc(i.id) + '\')">Reject</button></span></div>' +
          '<div style="font-size:8.5px;color:var(--muted2);margin-top:3px">' + esc(i.id) + ' · src ' + esc(i.source) + ' · all ' + (i.checks || []).length + ' validations passed · deadline ' + new Date(i.deadline).toLocaleTimeString() + '</div></div>';
      });
    }
    if (validatingIntents.length) {
      html += '<div class="st-lbl" style="margin-top:8px">In Validation (' + validatingIntents.length + ')</div>' +
        validatingIntents.map(function (i) { return '<div style="font-size:8.5px;color:var(--muted2);padding:2px 0">⏳ ' + esc(i.op + ' · ' + i.amount + ' ' + i.token + ' · ' + i.id) + '</div>'; }).join('');
    }
    const decided = approvals.filter(function (a) { return a.status !== 'pending'; }).slice(0, 5);
    if (decided.length) {
      html += '<div class="st-lbl" style="margin-top:8px">Recent Decisions</div>' +
        decided.map(function (a) {
          return '<div style="font-size:8.5px;color:var(--muted2);padding:2px 0"><span style="color:' + (a.status === 'approved' ? 'var(--green)' : 'var(--red)') + '">' + esc(a.status) + '</span> · ' + esc(a.title) + (a.result ? ' · ' + esc(a.result) : '') + '</div>';
        }).join('');
    }
    if (!html) html = '<div style="font-size:9.5px;color:var(--muted2)">No pending AI requests. Intents, permission changes and automation requests that need your approval will appear here.</div>';
    box.innerHTML = html;
  }

  /* ══════════════════════════════════════════════════════════════════
     PHASE 4 · AI SIMULATION CENTER — full pipeline dry-run.
     Reuses validateIntent + engines. NEVER executes.
     ══════════════════════════════════════════════════════════════════ */
  let lastSim = null;

  async function runSimulation() {
    const val = function (id) { const el = $id(id); return el ? el.value : ''; };
    const op = val('aiw-sim-op') || 'payment';
    const amount = parseFloat(val('aiw-sim-amount'));
    const token = val('aiw-sim-token') || 'USDC';
    const to = (val('aiw-sim-to') || '').trim();
    const box = $id('aiw-sim-result');
    if (!box) return;
    if (!isFinite(amount) || amount <= 0) { notify('Enter a valid amount to simulate', 'error'); return; }
    box.innerHTML = '<div style="font-size:9.5px;color:var(--muted2)"><i class="ti ti-loader"></i> Running full validation pipeline (read-only)…</div>';
    const cand = {
      op: op, name: 'simulation', amount: amount, token: token, to: to,
      recipients: to ? [{ addr: to, amount: amount }] : [],
      network: 'Arc_Testnet', toNetwork: 'Base_Sepolia', freq: op === 'recurring' ? 'monthly' : 'once',
      source: 'simulation', nonce: nonceCounter + 1, deadline: Date.now() + 900000
    };
    const res = await validateIntent(cand);
    const balNow = await tokenBalance(agentAddr(), token);
    const v = vault[token] || { locked: 0, automation: 0, treasury: 0 };
    const operationalNow = balNow === null ? null : Math.max(0, balNow - (v.locked || 0) - (v.automation || 0) - (v.treasury || 0));
    const avg = avgGasPerTx();
    let avgDur = null;
    try {
      if (typeof AgentAudit !== 'undefined' && AgentAudit.getRecords) {
        const recs = (AgentAudit.getRecords(20) || []).filter(function (r) { return isFinite(r.duration) && r.duration > 0; });
        if (recs.length) avgDur = recs.reduce(function (s, r) { return s + r.duration; }, 0) / recs.length;
      }
    } catch (_e) { /* ignore */ }
    lastSim = { cand: cand, res: res };
    function vRow(label, value, ok) {
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.03);font-size:9.5px">' +
        '<span style="color:var(--muted2)">' + esc(label) + '</span>' +
        '<span style="font-weight:600;color:' + (ok === undefined ? 'var(--text)' : ok ? 'var(--green)' : 'var(--red)') + '">' + esc(String(value)) + '</span></div>';
    }
    let html = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
      '<span style="font-size:11px;font-weight:700;color:' + (res.valid ? 'var(--green)' : 'var(--red)') + '">' + (res.valid ? 'SIMULATION PASSED' : 'SIMULATION FAILED') + '</span>' +
      (cand.riskLevel ? '<span class="chip" style="border:1px solid var(--border);color:var(--yellow)">Risk: ' + esc(cand.riskLevel) + '</span>' : '') +
      '<span style="margin-left:auto;font-size:8px;color:var(--muted2)">read-only · nothing was executed</span></div>';
    html += vRow('Operation', op + ' · ' + amount + ' ' + token + (to ? ' → ' + short(to) : ''));
    html += vRow('Estimated Gas Cost', avg ? avg.toFixed(6) + ' USDC (avg of real receipts)' : 'no execution data yet');
    html += vRow('Estimated Execution Time', avgDur ? (avgDur / 1000).toFixed(1) + 's (real avg) + scheduler tick ≤60s' : 'next scheduler tick ≤60s');
    html += vRow('Balance Now / After', balNow === null ? 'RPC unavailable' : balNow.toFixed(2) + ' → ' + (balNow - amount).toFixed(2) + ' ' + token, balNow !== null && balNow >= amount);
    html += vRow('Vault Impact (operational)', operationalNow === null ? '—' : operationalNow.toFixed(2) + ' → ' + Math.max(0, operationalNow - amount).toFixed(2) + ' ' + token, operationalNow !== null && operationalNow >= amount);
    html += '<div class="st-lbl" style="margin-top:7px">Validation Results (' + res.checks.filter(function (c) { return c.passed; }).length + '/' + res.checks.length + ')</div>';
    res.checks.forEach(function (c) {
      html += '<div style="display:flex;gap:6px;font-size:8.5px;padding:2px 0"><span style="color:' + (c.passed ? 'var(--green)' : 'var(--red)') + ';width:44px;flex-shrink:0">' + (c.passed ? 'PASSED' : 'FAILED') + '</span><span style="color:var(--text);width:110px;flex-shrink:0">' + esc(c.name) + '</span><span style="color:var(--muted2)">' + esc(c.reason) + '</span></div>';
    });
    html += '<div style="display:flex;gap:6px;margin-top:8px">' +
      (res.valid ? '<button class="btn primary" style="font-size:9px" onclick="AIWallet.simToIntent()"><i class="ti ti-send"></i>Submit as Real Intent</button>' : '') +
      '</div>';
    box.innerHTML = html;
  }

  function simToIntent() {
    if (!lastSim) return;
    const c = lastSim.cand;
    const id = submitIntent({ op: c.op, name: 'from simulation', amount: c.amount, token: c.token, to: c.to, network: c.network, freq: c.freq, source: 'simulation-center' });
    if (id) { notify('Intent ' + id + ' submitted through the full pipeline', 'info'); showTab('approvals'); }
  }

  function onSimOpChange() {
    const op = ($id('aiw-sim-op') || {}).value || 'payment';
    const wrap = $id('aiw-sim-to-wrap');
    if (wrap) wrap.style.display = ['payment', 'transfer', 'recurring', 'multisend', 'treasury', 'vault_allocation'].indexOf(op) !== -1 ? '' : 'none';
  }

  /* ══════════════════════════════════════════════════════════════════
     PHASE 4 · AI PROFILES — templates only. Limits/settings are local
     overlay config; engine permission changes ALWAYS go through the
     Approval Center (never auto-granted).
     ══════════════════════════════════════════════════════════════════ */
  const PROFILES = {
    conservative: {
      label: 'Conservative', icon: 'ti-shield-lock', color: 'var(--green)',
      desc: 'Low limits · LOW risk only · manual approval for everything · payments only',
      limits: { perOpUsd: 50, dailyUsd: 200, monthlyUsd: 2000, allowedOps: ['payment', 'transfer'] },
      settings: { maxRisk: 'LOW', autoExecute: false },
      grant: { allowPayments: true, allowSwap: false, allowBridge: false, allowCrosschain: false, allowScheduled: false, allowRecurring: false, allowTreasury: false, maxSpending: 200, dailyLimit: 100, durationMs: 86400000, maxRiskLevel: 'LOW' }
    },
    balanced: {
      label: 'Balanced', icon: 'ti-scale', color: 'var(--blue)',
      desc: 'Moderate limits · MEDIUM risk · payments, swaps and schedules',
      limits: { perOpUsd: 250, dailyUsd: 1000, monthlyUsd: 10000, allowedOps: ['payment', 'transfer', 'swap', 'recurring', 'multisend'] },
      settings: { maxRisk: 'MEDIUM', autoExecute: false },
      grant: { allowPayments: true, allowSwap: true, allowBridge: false, allowCrosschain: false, allowScheduled: true, allowRecurring: true, allowTreasury: false, maxSpending: 1000, dailyLimit: 500, durationMs: 172800000, maxRiskLevel: 'MEDIUM' }
    },
    business: {
      label: 'Business', icon: 'ti-building-bank', color: 'var(--purple)',
      desc: 'Treasury + payroll + scheduled payments · MEDIUM risk',
      limits: { perOpUsd: 1000, dailyUsd: 5000, monthlyUsd: 50000, allowedOps: ['payment', 'transfer', 'recurring', 'payroll', 'multisend', 'treasury', 'swap'] },
      settings: { maxRisk: 'MEDIUM', autoExecute: false },
      grant: { allowPayments: true, allowSwap: true, allowBridge: true, allowCrosschain: true, allowScheduled: true, allowRecurring: true, allowTreasury: true, maxSpending: 5000, dailyLimit: 2500, durationMs: 259200000, maxRiskLevel: 'MEDIUM' }
    },
    aggressive: {
      label: 'Aggressive', icon: 'ti-flame', color: 'var(--red)',
      desc: 'High limits · HIGH risk tolerance · auto-execution · all operations',
      limits: { perOpUsd: 2500, dailyUsd: 10000, monthlyUsd: 100000, allowedOps: ['payment', 'transfer', 'recurring', 'payroll', 'multisend', 'swap', 'bridge', 'crosschain', 'treasury'] },
      settings: { maxRisk: 'HIGH', autoExecute: true },
      grant: { allowPayments: true, allowSwap: true, allowBridge: true, allowCrosschain: true, allowScheduled: true, allowRecurring: true, allowTreasury: true, maxSpending: 10000, dailyLimit: 5000, durationMs: 604800000, maxRiskLevel: 'HIGH' }
    },
    custom: {
      label: 'Custom', icon: 'ti-adjustments', color: 'var(--teal)',
      desc: 'Fully configurable — manage everything in Limits & Policies and AI Permissions',
      limits: null, settings: null, grant: null
    }
  };

  function applyProfile(name) {
    const p = PROFILES[name];
    if (!p) return;
    if (emergencyStop) { notify('Emergency Stop active — profile changes frozen', 'error'); return; }
    activeProfile = name;
    lsSave(K.profile, name);
    if (p.limits) {
      Object.assign(limits, p.limits);
      lsSave(K.limits, limits);
    }
    if (p.settings) {
      Object.assign(settings, p.settings);
      lsSave(K.settings, settings);
    }
    pushHistory({ kind: 'profile', status: 'applied', reason: p.label });
    if (p.grant) {
      const g = Object.assign({ allowedTokens: limits.allowedTokens.slice(), allowedNetworks: ['Arc Testnet'], purpose: 'Profile: ' + p.label }, p.grant);
      queueApproval('permission_change', p.label + ' profile — permission grant',
        'Grant: cap ' + fmtUsd(g.maxSpending) + ' · daily ' + fmtUsd(g.dailyLimit) + ' · ' + Math.round(g.durationMs / 3600000) + 'h · risk ≤ ' + g.maxRiskLevel + '. Requires your explicit approval.',
        { grantOpts: g });
      notify('Profile "' + p.label + '" applied to local limits. The permission grant is waiting in the Approval Center.', 'info');
    } else {
      notify('Custom profile active — configure Limits & Policies manually', 'info');
    }
    renderProfiles(); renderLimits(); renderSecurity(); renderStatus(); renderTimeline(); renderHistory();
  }

  function renderProfiles() {
    const box = $id('aiw-profiles-body');
    if (!box) return;
    box.innerHTML = Object.keys(PROFILES).map(function (k) {
      const p = PROFILES[k];
      const active = activeProfile === k;
      return '<div style="border:1px solid ' + (active ? p.color : 'var(--border)') + ';border-radius:7px;padding:10px;background:rgba(0,0,0,.15);display:flex;flex-direction:column;gap:5px">' +
        '<div style="display:flex;align-items:center;gap:7px"><i class="ti ' + p.icon + '" style="color:' + p.color + ';font-size:14px"></i>' +
        '<span style="font-size:11px;font-weight:700;color:var(--text)">' + esc(p.label) + '</span>' +
        (active ? '<span class="chip" style="margin-left:auto;border:1px solid var(--border);color:' + p.color + '">active</span>' : '') + '</div>' +
        '<div style="font-size:8.5px;color:var(--muted2);line-height:1.5">' + esc(p.desc) + '</div>' +
        (p.limits ? '<div style="font-size:8px;color:var(--muted2)">Per-op ' + fmtUsd(p.limits.perOpUsd) + ' · daily ' + fmtUsd(p.limits.dailyUsd) + ' · monthly ' + fmtUsd(p.limits.monthlyUsd) + '</div>' : '') +
        '<button class="btn' + (active ? '' : ' primary') + '" style="font-size:8.5px;align-self:flex-start" ' + (active ? 'disabled' : '') + ' onclick="AIWallet.applyProfile(\'' + k + '\')">' + (active ? 'Active' : 'Apply Template') + '</button></div>';
    }).join('') ;
    const note = $id('aiw-profiles-note');
    if (note) note.innerHTML = 'Profiles are <b style="color:var(--text)">templates only</b>: they set local spending limits and preferences instantly, but every permission grant goes to the <b style="color:var(--text)">Approval Center</b> for your explicit approval. Nothing is granted automatically.';
  }

  /* ══════════════════════════════════════════════════════════════════
     PHASE 4 · AI FINANCIAL TIMELINE — chronological, read-only,
     merged from real sources (module history, audit, auth history,
     schedule executions).
     ══════════════════════════════════════════════════════════════════ */
  const EV_LABELS = {
    'funding:confirmed': { t: 'Funds Moved', c: 'var(--green)' },
    'funding:submitted': { t: 'Transfer Submitted', c: 'var(--yellow)' },
    'funding:failed': { t: 'Transfer Failed', c: 'var(--red)' },
    'vault:allocated': { t: 'Vault Allocation Updated', c: 'var(--purple)' },
    'vault:wizard_funded': { t: 'Received Funds (Wizard)', c: 'var(--green)' },
    'intent:received': { t: 'AI Intent Received', c: 'var(--blue)' },
    'validation:approved': { t: 'AI Decision — Approved', c: 'var(--green)' },
    'validation:rejected': { t: 'AI Decision — Rejected', c: 'var(--red)' },
    'execution:dispatched': { t: 'Execution Queued', c: 'var(--yellow)' },
    'execution:executed': { t: 'Transaction Executed', c: 'var(--green)' },
    'execution:failed': { t: 'Execution Failed', c: 'var(--red)' },
    'execution:aborted': { t: 'Execution Aborted', c: 'var(--red)' },
    'security:emergency_stop_on': { t: 'Emergency Stop Activated', c: 'var(--red)' },
    'security:emergency_stop_off': { t: 'Emergency Stop Lifted', c: 'var(--green)' },
    'security:auth_granted': { t: 'Permission Granted', c: 'var(--green)' },
    'security:auth_revoked': { t: 'Permission Revoked', c: 'var(--yellow)' },
    'security:auth_revoked_all': { t: 'All Permissions Revoked', c: 'var(--red)' },
    'security:ai_wallet_paused': { t: 'AI Wallet Paused', c: 'var(--yellow)' },
    'security:ai_wallet_resumed': { t: 'AI Wallet Resumed', c: 'var(--green)' },
    'profile:applied': { t: 'Profile Updated', c: 'var(--purple)' },
    'gas:topup_needed': { t: 'Gas Reserve Alert', c: 'var(--yellow)' },
    'settings:gas_config_updated': { t: 'Gas Reserve Updated', c: 'var(--teal)' },
    'approval:queued': { t: 'Approval Requested', c: 'var(--yellow)' },
    'approval:rejected': { t: 'Approval Rejected', c: 'var(--red)' },
    'observed:created': { t: 'Schedule Created', c: 'var(--blue)' }
  };

  function buildTimeline() {
    const events = [];
    history.forEach(function (h) {
      const key = h.kind + ':' + h.status;
      const meta = EV_LABELS[key] || { t: h.kind + ' · ' + h.status, c: 'var(--muted2)' };
      events.push({
        at: h.at, label: meta.t, color: meta.c,
        desc: (h.op ? h.op + ' · ' : '') + (h.amount ? h.amount + ' ' + (h.token || '') + ' · ' : '') + (h.intentId || h.schedId || '') + (h.reason ? ' · ' + h.reason : ''),
        status: h.status, txHash: h.txHash || null
      });
    });
    try {
      if (typeof AgentAudit !== 'undefined' && AgentAudit.getRecords) {
        (AgentAudit.getRecords(20) || []).forEach(function (r) {
          events.push({
            at: r.timestamp || 0, label: r.result === 'success' ? 'Automation Executed' : 'Automation Failed',
            color: r.result === 'success' ? 'var(--green)' : 'var(--red)',
            desc: (r.operation || '') + ' · ' + (r.amount || '') + ' ' + (r.asset || '') + ' · ' + (r.chain || ''),
            status: r.result || '', txHash: r.transactionHash || null
          });
        });
      }
    } catch (_e) { /* ignore */ }
    try {
      if (typeof AgentAuthorization !== 'undefined' && AgentAuthorization.getAuthHistory) {
        (AgentAuthorization.getAuthHistory(20) || []).forEach(function (r) {
          events.push({
            at: r.timestamp || 0,
            label: r.action === 'CREATED' ? 'Permission Granted' : r.action === 'REVOKED' || r.action === 'REVOKED_ALL' ? 'Permission Revoked' : 'Permission ' + r.action,
            color: r.action === 'CREATED' ? 'var(--green)' : 'var(--yellow)',
            desc: (r.authId || '') + (typeof r.details === 'string' ? ' · ' + r.details : ''),
            status: r.action, txHash: null
          });
        });
      }
    } catch (_e) { /* ignore */ }
    try {
      if (typeof ScheduleEngine !== 'undefined') {
        ScheduleEngine.getAll().slice(0, 15).forEach(function (s) {
          if (s.created) events.push({ at: new Date(s.created).getTime(), label: 'Schedule Created', color: 'var(--blue)', desc: (s.name || s.type) + ' · ' + s.amount + ' ' + s.token + ' · ' + s.freq + ' · by ' + (s.createdBy || 'user'), status: s.status, txHash: null });
        });
      }
    } catch (_e) { /* ignore */ }
    events.sort(function (a, b) { return b.at - a.at; });
    return events.slice(0, 60);
  }

  function renderTimeline() {
    const box = $id('aiw-timeline-body');
    if (!box) return;
    const events = buildTimeline();
    if (!events.length) { box.innerHTML = '<div style="font-size:9.5px;color:var(--muted2)">No financial activity recorded yet.</div>'; return; }
    box.innerHTML = '<div style="border-left:2px solid var(--border);margin-left:6px;padding-left:14px;display:flex;flex-direction:column;gap:9px">' +
      events.map(function (e) {
        const txLink = (e.txHash && /^0x[0-9a-fA-F]{64}$/.test(e.txHash))
          ? ' · <a href="' + explorerTx(e.txHash) + '" target="_blank" rel="noopener" style="color:var(--blue);text-decoration:none">' + esc(short(e.txHash)) + '</a>' : '';
        return '<div style="position:relative">' +
          '<span style="position:absolute;left:-19px;top:3px;width:8px;height:8px;border-radius:50%;background:' + e.color + ';border:2px solid var(--card)"></span>' +
          '<div style="font-size:8px;color:var(--muted2)">' + (e.at ? new Date(e.at).toLocaleString() : '—') + '</div>' +
          '<div style="font-size:10px;font-weight:600;color:' + e.color + '">' + esc(e.label) + '</div>' +
          '<div style="font-size:8.5px;color:var(--muted2)">' + esc(e.desc) + txLink + '</div></div>';
      }).join('') + '</div>';
  }

  /* ══════════════════════════════════════════════════════════════════
     PHASE 4 · AI MISSION CONTROL — real-time read-only overview
     ══════════════════════════════════════════════════════════════════ */
  function renderMission() {
    const box = $id('aiw-mission-body');
    if (!box) return;
    let total = 0;
    portfolioCache.rows.forEach(function (r) { total += r.totalUsd; });
    const vv = vaultView('USDC');
    let authCount = 0, authDaily = 0;
    try { if (typeof AgentAuthorization !== 'undefined') { const s = AgentAuthorization.getAuthSummary(); authCount = s.count; authDaily = s.totalDailyLimit; } } catch (_e) { /* ignore */ }
    let scheds = [];
    try { if (typeof ScheduleEngine !== 'undefined') scheds = ScheduleEngine.getAll(); } catch (_e) { /* ignore */ }
    const activeScheds = scheds.filter(function (s) { return s.status === 'Active'; });
    const pending = intents.filter(function (i) { return ['validating', 'approved'].indexOf(i.status) !== -1; }).length;
    const running = intents.filter(function (i) { return i.status === 'executing'; }).length;
    const done = intents.filter(function (i) { return i.status === 'executed'; }).length;
    const pendAppr = approvals.filter(function (a) { return a.status === 'pending'; }).length;
    let paused = false;
    try { paused = typeof AgentWalletManager !== 'undefined' && AgentWalletManager.isPaused(); } catch (_e) { /* ignore */ }
    const upcoming = activeScheds.filter(function (s) { return s.nextRun; })
      .sort(function (a, b) { return new Date(a.nextRun) - new Date(b.nextRun); }).slice(0, 3);
    const recentTx = history.filter(function (h) { return h.txHash; }).slice(0, 3);
    function tile(label, value, color, onclickTab) {
      return '<div ' + (onclickTab ? 'onclick="AIWallet.showTab(\'' + onclickTab + '\')" style="cursor:pointer;"' : 'style=""') + ' class="aiw-mc-tile">' +
        '<div class="st-lbl">' + esc(label) + '</div><div style="font-size:13px;font-weight:700;color:' + (color || 'var(--text)') + ';margin-top:2px">' + value + '</div></div>';
    }
    let html = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px">' +
      tile('Portfolio Value', esc(fmtUsd(total)), 'var(--green)', 'overview') +
      tile('Vault · Operational USDC', vv.operational === null ? '—' : esc(vv.operational.toFixed(2)), 'var(--blue)', 'vault') +
      tile('Vault · Locked USDC', esc(String(vv.locked.toFixed(2))), 'var(--red)', 'vault') +
      tile('Gas', '<span id="aiw-mc-gas">reading…</span>', 'var(--teal)', 'vault') +
      tile('Permissions', authCount + ' grant(s) · ' + esc(fmtUsd(authDaily)) + '/day', authCount ? 'var(--green)' : 'var(--yellow)', 'permissions') +
      tile('Schedules', activeScheds.length + ' active / ' + scheds.length, 'var(--yellow)', 'scheduled') +
      tile('Pending Approvals', String(pendAppr), pendAppr ? 'var(--yellow)' : 'var(--text)', 'approvals') +
      tile('Tasks P / R / C', pending + ' / ' + running + ' / ' + done, 'var(--purple)', 'executions') +
      tile('AI Wallet', emergencyStop ? 'EMERGENCY STOP' : paused ? 'Paused' : 'Operational', emergencyStop ? 'var(--red)' : paused ? 'var(--yellow)' : 'var(--green)', 'security') +
      tile('Profile', esc(PROFILES[activeProfile] ? PROFILES[activeProfile].label : 'Custom'), 'var(--purple)', 'profiles') +
      '</div>';
    html += '<div class="aiw-grid2" style="margin-top:10px">';
    html += '<div><div class="st-lbl">Upcoming Executions</div>' +
      (upcoming.length ? upcoming.map(function (s) {
        return '<div style="font-size:8.5px;color:var(--muted2);padding:3px 0">▸ ' + esc(new Date(s.nextRun).toLocaleString() + ' · ' + s.amount + ' ' + s.token + ' · ' + s.type) + '</div>';
      }).join('') : '<div style="font-size:8.5px;color:var(--muted2);padding:3px 0">None scheduled.</div>') + '</div>';
    html += '<div><div class="st-lbl">Recent Transactions</div>' +
      (recentTx.length ? recentTx.map(function (h) {
        return '<div style="font-size:8.5px;color:var(--muted2);padding:3px 0">▸ ' + esc(new Date(h.at).toLocaleTimeString() + ' · ' + (h.op || h.kind) + ' · ' + (h.amount || '') + ' ' + (h.token || '')) +
          ' <a href="' + explorerTx(h.txHash) + '" target="_blank" rel="noopener" style="color:var(--blue);text-decoration:none">' + esc(short(h.txHash)) + '</a></div>';
      }).join('') : '<div style="font-size:8.5px;color:var(--muted2);padding:3px 0">No on-chain transactions yet.</div>') + '</div>';
    html += '</div>';
    box.innerHTML = html;
    gasStatus(false).then(function (g) {
      const el = $id('aiw-mc-gas');
      if (el) el.textContent = g.bal === null ? 'RPC unavailable' : g.bal.toFixed(4) + ' USDC · ' + g.status;
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     PHASE 5 · shared helper — programmatic vault change (approval path)
     ══════════════════════════════════════════════════════════════════ */
  async function vaultApply(token, changes, why) {
    const real = await tokenBalance(agentAddr(), token);
    if (real === null) { notify('Vault change aborted — cannot verify on-chain balance', 'error'); return false; }
    const v = Object.assign({ locked: 0, automation: 0, treasury: 0 }, vault[token] || {});
    Object.keys(changes || {}).forEach(function (k) {
      if (['locked', 'automation', 'treasury'].indexOf(k) !== -1) v[k] = Math.max(0, (v[k] || 0) + Number(changes[k] || 0));
    });
    if (v.locked + v.automation + v.treasury > real + 1e-9) { notify('Vault change exceeds real balance — rejected', 'error'); return false; }
    vault[token] = v;
    lsSave(K.vault, vault);
    pushHistory({ kind: 'vault', status: 'allocated', reason: token + ' adjusted (' + (why || 'approved') + ')' });
    renderVaultPanel(); renderPortfolioIntelligence();
    return true;
  }

  /* ══════════════════════════════════════════════════════════════════
     PHASE 5 · AI FINANCIAL ASSISTANT — financial specialist inside the
     AI Smart Wallet. Rule-based (same approach as the app). It NEVER
     executes: every action becomes an intent or an approval request.
     Autonoma remains the general conversational AI — untouched.
     ══════════════════════════════════════════════════════════════════ */
  function asstPush(role, html) {
    chatLog.push({ role: role, html: html, at: Date.now() });
    if (chatLog.length > 50) chatLog.shift();
    renderAssistant();
  }

  function renderAssistant() {
    const box = $id('aiw-asst-log');
    if (!box) return;
    if (!chatLog.length) {
      box.innerHTML = '<div style="font-size:9px;color:var(--muted2);line-height:1.7">Financial specialist for your AI Smart Wallet. Try:<br>' +
        ['How much can I spend today?', 'What payments are scheduled this week?', 'Move 100 USDC to treasury', 'Send 25 USDC to 0x…', 'Simulate a payment of 50 USDC', 'Generate a monthly report', 'Pause all automations', 'Gas status', 'Recommendations']
          .map(function (s) { return '<span class="chip chip-b" style="cursor:pointer;margin:2px" onclick="AIWallet.asstQuick(this.textContent)">' + esc(s) + '</span>'; }).join(' ') + '</div>';
      return;
    }
    box.innerHTML = chatLog.map(function (m) {
      return '<div style="display:flex;gap:7px;margin-bottom:7px;' + (m.role === 'user' ? 'flex-direction:row-reverse' : '') + '">' +
        '<div style="max-width:82%;background:' + (m.role === 'user' ? 'rgba(79,142,247,.12)' : 'rgba(0,0,0,.2)') + ';border:1px solid var(--border);border-radius:8px;padding:7px 9px;font-size:9.5px;color:var(--text);line-height:1.6">' + m.html + '</div></div>';
    }).join('');
    box.scrollTop = box.scrollHeight;
  }

  function asstQuick(msg) { const inp = $id('aiw-asst-input'); if (inp) inp.value = msg; assistantSend(); }

  function assistantSend() {
    const inp = $id('aiw-asst-input');
    if (!inp) return;
    const msg = (inp.value || '').trim();
    if (!msg) return;
    inp.value = '';
    asstPush('user', esc(msg));
    try { asstProcess(msg); } catch (e) { asstPush('ai', 'Error: ' + esc(e.message || e)); }
  }

  function asstProcess(msg) {
    const m = msg.toLowerCase();
    const amt = (function () { const x = msg.match(/(\d+(?:[.,]\d+)?)/); return x ? parseFloat(x[1].replace(',', '.')) : null; })();
    const token = /eurc/i.test(msg) ? 'EURC' : /cirbtc/i.test(msg) ? 'cirBTC' : 'USDC';
    const addr = (function () { const x = msg.match(/0x[a-fA-F0-9]{40}/); return x ? x[0] : null; })();

    /* read-only queries — always available */
    if (/spend|gastar|quanto posso/.test(m) && /today|hoje|day/.test(m)) {
      const spent = spentUsdSince(86400000);
      const left = Math.max(0, limits.dailyUsd - spent);
      const vv = vaultView('USDC');
      asstPush('ai', 'Daily limit: <b>' + esc(fmtUsd(limits.dailyUsd)) + '</b> · spent today: <b>' + esc(fmtUsd(spent)) + '</b> · remaining: <b style="color:var(--green)">' + esc(fmtUsd(left)) + '</b>.<br>Per-op cap: ' + esc(fmtUsd(limits.perOpUsd)) + ' · Operational USDC: <b>' + (vv.operational === null ? '—' : esc(vv.operational.toFixed(2))) + '</b> (real on-chain minus locked/automation/treasury).');
      return;
    }
    if (/(scheduled|schedule|agendad)/.test(m) && /(week|semana|this)/.test(m)) {
      let list = [];
      try { list = ScheduleEngine.getAll().filter(function (s) { return s.status === 'Active' && s.nextRun && new Date(s.nextRun).getTime() <= Date.now() + 604800000; }); } catch (_e) { /* ignore */ }
      asstPush('ai', list.length ? 'Scheduled in the next 7 days (' + list.length + '):<br>' + list.slice(0, 8).map(function (s) { return '▸ ' + esc(new Date(s.nextRun).toLocaleString() + ' — ' + s.amount + ' ' + s.token + ' · ' + s.type + ' · by ' + (s.createdBy || 'user')); }).join('<br>') : 'No schedules due in the next 7 days.');
      return;
    }
    if (/portfolio|balance|saldo/.test(m) && !/after|impact/.test(m)) {
      refreshPortfolio(true).then(function () {
        let total = 0; const lines = [];
        portfolioCache.rows.forEach(function (r) {
          total += r.totalUsd;
          lines.push('<b>' + esc(r.label) + '</b>: ' + (r.tokens.length ? r.tokens.map(function (t) { return t.bal.toFixed(2) + ' ' + t.sym; }).join(' · ') : '—'));
        });
        asstPush('ai', 'Total portfolio: <b style="color:var(--green)">' + esc(fmtUsd(total)) + '</b><br>' + lines.join('<br>'));
      });
      asstPush('ai', 'Reading real on-chain balances…');
      return;
    }
    if (/gas/.test(m)) {
      gasStatus(true).then(function (g) {
        asstPush('ai', 'Gas (native USDC on Arc): <b>' + (g.bal === null ? 'RPC unavailable' : g.bal.toFixed(4)) + '</b> · health <b style="text-transform:capitalize">' + esc(g.status) + '</b> · reserve ' + gasCfg.minReserve + ' USDC · capacity ' + (g.capacity === null ? 'no data' : '~' + g.capacity + ' txs') + '.');
      });
      asstPush('ai', 'Checking gas…');
      return;
    }
    if (/recommend|recomenda|sugest/.test(m)) {
      const recs = buildRecommendations().slice(0, 5);
      asstPush('ai', recs.length ? recs.map(function (r) { return '▸ <b style="color:' + r.color + '">[' + esc(r.sev) + ']</b> ' + esc(r.text); }).join('<br>') : 'No recommendations right now — everything looks healthy.');
      return;
    }
    if (/report|relat[oó]rio/.test(m)) {
      const type = /month|mensal|mês/.test(m) ? 'monthly' : /week|semana/.test(m) ? 'weekly' : /portfolio/.test(m) ? 'portfolio' : /gas/.test(m) ? 'gas' : /security|seguran/.test(m) ? 'security' : 'daily';
      generateReport(type);
      asstPush('ai', 'Generated the <b>' + esc(type) + '</b> report from real historical data — open the <b>Reports</b> tab to view and export it.');
      showTab('reports');
      return;
    }

    /* actions — always approval-gated, frozen under Emergency Stop */
    if (emergencyStop && /(move|mover|send|pay|transfer|pause|aloca)/.test(m)) {
      asstPush('ai', '<b style="color:var(--red)">Emergency Stop is active</b> — actions are frozen. Read-only queries remain available.');
      return;
    }
    if (/(move|mover|aloca)/.test(m) && /(treasury|tesour|locked|automation|gas reserve)/.test(m) && amt) {
      const field = /locked/.test(m) ? 'locked' : /automation/.test(m) ? 'automation' : 'treasury';
      const ch = {}; ch[field] = amt;
      queueApproval('vault_change', 'Move ' + amt + ' ' + token + ' to ' + field + ' allocation', 'Requested via AI Financial Assistant. Validated against the real on-chain balance on approval.', { token: token, changes: ch });
      asstPush('ai', 'Queued: move <b>' + amt + ' ' + esc(token) + '</b> → <b>' + field + '</b>. Waiting for your approval in the <b>Approval Center</b>.');
      return;
    }
    if (/(send|pay|enviar|pagar|transfer)/.test(m) && amt) {
      if (!addr) { asstPush('ai', 'I need a destination address (0x…) to create the payment intent.'); return; }
      const id = submitIntent({ op: 'payment', name: 'assistant payment', amount: amt, token: token, to: addr, network: 'Arc_Testnet', freq: 'once', source: 'financial-assistant' });
      asstPush('ai', id ? 'Intent <b>' + esc(id) + '</b> created: ' + amt + ' ' + esc(token) + ' → ' + esc(short(addr)) + '. It is passing the full validation pipeline; execution requires approval in the <b>Approval Center</b>.' : 'Intent rejected (Emergency Stop).');
      return;
    }
    if (/simulat|simular/.test(m) && amt) {
      const cand = { op: /payroll|multisend/.test(m) ? 'multisend' : 'payment', name: 'assistant simulation', amount: amt, token: token, to: addr || '', recipients: addr ? [{ addr: addr, amount: amt }] : [], network: 'Arc_Testnet', toNetwork: 'Base_Sepolia', freq: 'once', source: 'simulation', nonce: nonceCounter + 1, deadline: Date.now() + 900000 };
      asstPush('ai', 'Running read-only simulation…');
      validateIntent(cand).then(function (res) {
        const failed = res.checks.filter(function (c) { return !c.passed; });
        asstPush('ai', (res.valid ? '<b style="color:var(--green)">SIMULATION PASSED</b>' : '<b style="color:var(--red)">SIMULATION FAILED</b>') + ' — ' + (res.checks.length - failed.length) + '/' + res.checks.length + ' validations' + (failed.length ? '<br>Failed: ' + esc(failed.map(function (c) { return c.name; }).join(', ')) : '') + '<br>Nothing was executed. Full details in the <b>Simulation</b> tab.');
      });
      return;
    }
    if (/pause/.test(m) && /(automa|all)/.test(m)) {
      queueApproval('pause_automations', 'Pause all AI Smart Wallet automations', 'Requested via AI Financial Assistant. Pauses only aiwallet-created schedules — the rest of the app is unaffected.', {});
      asstPush('ai', 'Queued: pause all AI Smart Wallet automations. Confirm in the <b>Approval Center</b>.');
      return;
    }
    if (/permission|permiss/.test(m)) {
      try {
        const s = AgentAuthorization.getAuthSummary();
        asstPush('ai', 'Active grants: <b>' + s.count + '</b> · total cap ' + esc(fmtUsd(s.totalSpendingLimit)) + ' · daily cap ' + esc(fmtUsd(s.totalDailyLimit)) + ' · ops: ' + esc(Array.from(s.allowedOps || []).join(', ') || 'none') + '. Manage in <b>AI Permissions</b>.');
      } catch (_e) { asstPush('ai', 'Permission engine unavailable.'); }
      return;
    }
    asstPush('ai', 'I can help with: spending capacity, weekly schedules, portfolio/gas status, vault moves ("move 100 USDC to treasury"), payments ("send 25 USDC to 0x…"), simulations, reports, pausing automations, permissions. Every action goes through the approval pipeline.');
  }

  /* ══════════════════════════════════════════════════════════════════
     PHASE 5 · AUTONOMOUS WORKFLOWS + BUILDER — definitions only.
     Triggers are monitored read-only; matched workflows bundle their
     transactional actions into ONE Approval Center request.
     ══════════════════════════════════════════════════════════════════ */
  function saveWorkflows() { if (workflows.length > 30) workflows.length = 30; lsSave(K.workflows, workflows); }
  function saveWfState() { lsSave(K.wfstate, wfState); }
  function wfLog(id, text) {
    const wf = workflows.find(function (w) { return w.id === id; });
    if (!wf) return;
    wf.log = wf.log || [];
    wf.log.unshift({ at: Date.now(), text: String(text).slice(0, 160) });
    wf.log = wf.log.slice(0, 20);
    saveWorkflows();
  }

  const wfDraft = { conditions: [], actions: [] };

  function wfAddCondition() {
    const field = ($id('aiw-wf-cond-field') || {}).value || 'amount';
    const op = ($id('aiw-wf-cond-op') || {}).value || '>';
    const value = parseFloat(($id('aiw-wf-cond-value') || {}).value);
    if (!isFinite(value)) { notify('Enter a condition value', 'error'); return; }
    wfDraft.conditions.push({ field: field, op: op, value: value });
    renderWfDraft();
  }

  function wfAddAction() {
    const type = ($id('aiw-wf-act-type') || {}).value || 'notify';
    const a = { type: type };
    const val = parseFloat(($id('aiw-wf-act-value') || {}).value);
    const dest = (($id('aiw-wf-act-dest') || {}).value || '').trim();
    const target = ($id('aiw-wf-act-target') || {}).value || 'treasury';
    const isPct = ($id('aiw-wf-act-mode') || {}).value === 'percent';
    if (type === 'create_intent') {
      if (!isFinite(val) || val <= 0) { notify('Action needs an amount', 'error'); return; }
      if (!/^0x[a-fA-F0-9]{40}$/.test(dest)) { notify('Action needs a valid destination address', 'error'); return; }
      a.amount = val; a.isPercent = isPct; a.to = dest; a.token = 'USDC';
    } else if (type === 'vault_allocate') {
      if (!isFinite(val) || val <= 0) { notify('Action needs an amount', 'error'); return; }
      a.amount = val; a.isPercent = isPct; a.target = target; a.token = 'USDC';
    } else if (type === 'create_schedule') {
      if (!isFinite(val) || val <= 0) { notify('Action needs an amount', 'error'); return; }
      if (!/^0x[a-fA-F0-9]{40}$/.test(dest)) { notify('Schedule action needs a valid address', 'error'); return; }
      a.amount = val; a.to = dest; a.token = 'USDC'; a.freq = 'monthly';
    }
    wfDraft.actions.push(a);
    renderWfDraft();
  }

  function wfRemoveCond(i) { wfDraft.conditions.splice(i, 1); renderWfDraft(); }
  function wfRemoveAct(i) { wfDraft.actions.splice(i, 1); renderWfDraft(); }

  function renderWfDraft() {
    const cb = $id('aiw-wf-conds');
    if (cb) cb.innerHTML = wfDraft.conditions.length ? wfDraft.conditions.map(function (c, i) {
      return '<span class="chip chip-b" style="margin:2px">' + esc(c.field + ' ' + c.op + ' ' + c.value) + ' <span style="cursor:pointer;color:var(--red)" onclick="AIWallet.wfRemoveCond(' + i + ')">×</span></span>';
    }).join('') : '<span style="font-size:8.5px;color:var(--muted2)">No conditions (always passes)</span>';
    const ab = $id('aiw-wf-acts');
    if (ab) ab.innerHTML = wfDraft.actions.length ? wfDraft.actions.map(function (a, i) {
      let txt = a.type;
      if (a.type === 'create_intent') txt = 'pay ' + a.amount + (a.isPercent ? '%' : ' USDC') + ' → ' + short(a.to);
      if (a.type === 'vault_allocate') txt = 'allocate ' + a.amount + (a.isPercent ? '%' : ' USDC') + ' → ' + a.target;
      if (a.type === 'create_schedule') txt = 'schedule ' + a.amount + ' USDC monthly → ' + short(a.to);
      return '<span class="chip chip-p" style="margin:2px">' + esc(txt) + ' <span style="cursor:pointer;color:var(--red)" onclick="AIWallet.wfRemoveAct(' + i + ')">×</span></span>';
    }).join('') : '<span style="font-size:8.5px;color:var(--muted2)">No actions yet</span>';
  }

  function wfOnActTypeChange() {
    const type = ($id('aiw-wf-act-type') || {}).value;
    const show = function (id, on) { const el = $id(id); if (el) el.style.display = on ? '' : 'none'; };
    show('aiw-wf-act-value-wrap', ['create_intent', 'vault_allocate', 'create_schedule'].indexOf(type) !== -1);
    show('aiw-wf-act-mode-wrap', ['create_intent', 'vault_allocate'].indexOf(type) !== -1);
    show('aiw-wf-act-dest-wrap', ['create_intent', 'create_schedule'].indexOf(type) !== -1);
    show('aiw-wf-act-target-wrap', type === 'vault_allocate');
  }

  function wfCreate() {
    if (emergencyStop) { notify('Emergency Stop active — workflow creation frozen', 'error'); return; }
    const name = (($id('aiw-wf-name') || {}).value || '').trim();
    if (!name) { notify('Name your workflow', 'error'); return; }
    if (!wfDraft.actions.length) { notify('Add at least one action', 'error'); return; }
    const trigType = ($id('aiw-wf-trigger') || {}).value || 'time_weekly';
    const trig = { type: trigType };
    if (trigType === 'time_weekly') trig.day = parseInt(($id('aiw-wf-trig-day') || {}).value, 10) || 5;
    if (trigType === 'gas_below') trig.threshold = parseFloat(($id('aiw-wf-trig-value') || {}).value) || gasCfg.topupThreshold;
    if (trigType === 'asset_received') trig.minAmount = parseFloat(($id('aiw-wf-trig-value') || {}).value) || 0;
    if (trigType === 'portfolio_drop') trig.percent = parseFloat(($id('aiw-wf-trig-value') || {}).value) || 10;
    const wf = {
      id: 'WF-' + Date.now().toString(36),
      name: plain(name),
      trigger: trig,
      conditions: wfDraft.conditions.slice(),
      actions: wfDraft.actions.slice(),
      approvalRequired: true,
      notifyUser: ($id('aiw-wf-notify') || {}).classList ? $id('aiw-wf-notify').classList.contains('on') : true,
      status: 'active', createdAt: Date.now(), runCount: 0, log: []
    };
    workflows.unshift(wf);
    saveWorkflows();
    wfDraft.conditions = []; wfDraft.actions = [];
    const nameEl = $id('aiw-wf-name'); if (nameEl) nameEl.value = '';
    pushHistory({ kind: 'workflow', status: 'created', reason: wf.name });
    notify('Workflow "' + wf.name + '" saved — definition only; every run waits for your approval', 'success');
    renderWfDraft(); renderWorkflows(); renderTimeline();
  }

  function wfToggle(id) {
    const wf = workflows.find(function (w) { return w.id === id; });
    if (!wf) return;
    if (wf.status !== 'active' && emergencyStop) { notify('Emergency Stop active — cannot resume workflows', 'error'); return; }
    wf.status = wf.status === 'active' ? 'paused' : 'active';
    saveWorkflows(); renderWorkflows();
  }
  function wfDelete(id) {
    const i = workflows.findIndex(function (w) { return w.id === id; });
    if (i !== -1) { pushHistory({ kind: 'workflow', status: 'deleted', reason: workflows[i].name }); workflows.splice(i, 1); saveWorkflows(); renderWorkflows(); }
  }

  function wfEvalConditions(wf, ctx) {
    return (wf.conditions || []).every(function (c) {
      let actual = null;
      if (c.field === 'amount') actual = ctx.amount || 0;
      else if (c.field === 'daily_spent') actual = spentUsdSince(86400000);
      else if (c.field === 'operational_usdc') { const vv = vaultView('USDC'); actual = vv.operational === null ? 0 : vv.operational; }
      else if (c.field === 'gas_balance') actual = nativeCache.bal === null ? 0 : nativeCache.bal;
      else if (c.field === 'active_schedules') { try { actual = ScheduleEngine.getAll().filter(function (s) { return s.status === 'Active'; }).length; } catch (_e) { actual = 0; } }
      if (actual === null) return false;
      return c.op === '>' ? actual > c.value : c.op === '<' ? actual < c.value : Math.abs(actual - c.value) < 1e-9;
    });
  }

  function wfFire(wf, ctx) {
    if (emergencyStop) { wfLog(wf.id, 'trigger matched but frozen by Emergency Stop'); return; }
    if (!wfEvalConditions(wf, ctx)) { wfLog(wf.id, 'trigger matched · conditions failed'); return; }
    const transactional = [];
    (wf.actions || []).forEach(function (a) {
      const base = ctx.amount || 0;
      const amount = a.isPercent ? +(base * (a.amount / 100)).toFixed(2) : a.amount;
      if (a.type === 'create_intent') transactional.push({ type: 'create_intent', intent: { op: 'payment', name: 'workflow ' + wf.name, amount: amount, token: a.token || 'USDC', to: a.to, network: 'Arc_Testnet', freq: 'once', source: 'workflow' } });
      else if (a.type === 'vault_allocate') { const ch = {}; ch[a.target || 'treasury'] = amount; transactional.push({ type: 'vault_allocate', token: a.token || 'USDC', changes: ch }); }
      else if (a.type === 'create_schedule') transactional.push({ type: 'create_schedule', sched: { type: 'payment', name: 'workflow ' + wf.name, token: a.token || 'USDC', amount: amount, address: a.to, recipients: [{ addr: a.to, amount: amount }], freq: a.freq || 'monthly', nextRun: new Date(Date.now() + 60000).toISOString(), status: 'Active' } });
      else if (a.type === 'generate_report') { generateReport('daily'); wfLog(wf.id, 'report generated'); }
      else if (a.type === 'simulate') { wfLog(wf.id, 'simulation requested — open Simulation tab'); }
      else if (a.type === 'pause_workflow') { wf.status = 'paused'; wfLog(wf.id, 'self-paused'); }
    });
    wf.runCount = (wf.runCount || 0) + 1;
    wf.lastRun = Date.now();
    if (transactional.length) {
      queueApproval('workflow_run', 'Workflow: ' + wf.name, 'Trigger fired (' + wf.trigger.type + (ctx.amount ? ' · amount ' + ctx.amount : '') + ') · ' + transactional.length + ' transactional action(s) awaiting your approval.', { workflowId: wf.id, actions: transactional });
      wfLog(wf.id, 'fired → ' + transactional.length + ' action(s) sent to Approval Center');
    } else {
      wfLog(wf.id, 'fired → read-only actions completed');
    }
    if (wf.notifyUser) notify('Workflow "' + wf.name + '" fired' + (transactional.length ? ' — waiting in Approval Center' : ''), 'info');
    saveWorkflows(); renderWorkflows(); renderTimeline();
  }

  async function checkWorkflows() {
    if (!workflows.length) return;
    const active = workflows.filter(function (w) { return w.status === 'active'; });
    if (!active.length) return;
    const now = new Date();
    /* asset_received: real balance delta on agent USDC */
    let balNow = null;
    if (active.some(function (w) { return w.trigger.type === 'asset_received'; })) {
      balNow = await tokenBalance(agentAddr(), 'USDC');
      if (balNow !== null && wfState.lastBalUSDC !== null && balNow > wfState.lastBalUSDC + 1e-9) {
        const received = +(balNow - wfState.lastBalUSDC).toFixed(6);
        active.forEach(function (w) {
          if (w.trigger.type === 'asset_received' && received >= (w.trigger.minAmount || 0)) wfFire(w, { amount: received });
        });
      }
      if (balNow !== null) { wfState.lastBalUSDC = balNow; saveWfState(); }
    }
    active.forEach(function (w) {
      const t = w.trigger || {};
      const key = w.id + ':' + t.type;
      if (t.type === 'time_weekly') {
        const period = now.getFullYear() + '-w' + Math.floor(now.getTime() / 604800000) + '-d' + t.day;
        if (now.getDay() === Number(t.day) && wfState.fired[key] !== period) { wfState.fired[key] = period; saveWfState(); wfFire(w, {}); }
      } else if (t.type === 'time_daily') {
        const dayKey = now.toISOString().slice(0, 10);
        if (wfState.fired[key] !== dayKey) { wfState.fired[key] = dayKey; saveWfState(); wfFire(w, {}); }
      } else if (t.type === 'gas_below') {
        if (nativeCache.bal !== null && nativeCache.bal < (t.threshold || 0)) {
          const hourKey = new Date().toISOString().slice(0, 13);
          if (wfState.fired[key] !== hourKey) { wfState.fired[key] = hourKey; saveWfState(); wfFire(w, { amount: nativeCache.bal }); }
        }
      } else if (t.type === 'portfolio_drop') {
        let total = 0;
        portfolioCache.rows.forEach(function (r) { total += r.totalUsd; });
        if (wfState.lastPortfolioUsd && total > 0 && total < wfState.lastPortfolioUsd * (1 - (t.percent || 10) / 100)) {
          const dayKey2 = new Date().toISOString().slice(0, 10);
          if (wfState.fired[key] !== dayKey2) { wfState.fired[key] = dayKey2; saveWfState(); wfFire(w, { amount: total }); }
        }
        if (total > 0) { wfState.lastPortfolioUsd = total; saveWfState(); }
      }
    });
  }

  function onScheduleExecutedForWorkflows(detail) {
    if (!detail || !detail.item) return;
    workflows.filter(function (w) { return w.status === 'active' && w.trigger.type === 'schedule_executed'; })
      .forEach(function (w) { wfFire(w, { amount: Number(detail.item.amount) || 0 }); });
  }

  function renderWorkflows() {
    const box = $id('aiw-wf-list');
    if (!box) return;
    if (!workflows.length) { box.innerHTML = '<div style="font-size:9.5px;color:var(--muted2)">No workflows yet — build one below. Workflows are definitions only: every transactional run waits in the Approval Center.</div>'; return; }
    box.innerHTML = workflows.map(function (w) {
      const trig = w.trigger.type + (w.trigger.day !== undefined ? ' (day ' + w.trigger.day + ')' : '') + (w.trigger.threshold ? ' < ' + w.trigger.threshold : '') + (w.trigger.minAmount ? ' ≥ ' + w.trigger.minAmount : '');
      return '<div style="border:1px solid var(--border);border-radius:6px;padding:8px;margin-bottom:6px;background:rgba(0,0,0,.15)">' +
        '<div style="display:flex;align-items:center;gap:6px">' +
        '<span style="width:7px;height:7px;border-radius:50%;background:' + (w.status === 'active' ? 'var(--green)' : 'var(--yellow)') + '"></span>' +
        '<span style="font-size:10px;font-weight:600;color:var(--text)">' + esc(w.name) + '</span>' +
        '<span class="chip" style="border:1px solid var(--border);color:var(--muted2)">' + esc(trig) + '</span>' +
        '<span style="margin-left:auto;display:flex;gap:4px">' +
        '<button class="btn" style="font-size:8px;padding:2px 7px" onclick="AIWallet.wfToggle(\'' + esc(w.id) + '\')">' + (w.status === 'active' ? 'Pause' : 'Resume') + '</button>' +
        '<button class="btn" style="font-size:8px;padding:2px 7px;border-color:rgba(239,68,68,.4);color:var(--red)" onclick="AIWallet.wfDelete(\'' + esc(w.id) + '\')">Delete</button></span></div>' +
        '<div style="font-size:8.5px;color:var(--muted2);margin-top:3px">' + (w.conditions || []).length + ' condition(s) · ' + (w.actions || []).length + ' action(s) · approval always required · runs ' + (w.runCount || 0) + (w.lastRun ? ' · last ' + new Date(w.lastRun).toLocaleString() : '') + '</div>' +
        ((w.log && w.log.length) ? '<div style="font-size:8px;color:var(--muted2);margin-top:3px">' + w.log.slice(0, 3).map(function (l) { return '▸ ' + esc(new Date(l.at).toLocaleTimeString() + ' ' + l.text); }).join('<br>') + '</div>' : '') +
        '</div>';
    }).join('');
  }

  /* ══════════════════════════════════════════════════════════════════
     PHASE 5 · AI RECOMMENDATIONS — informational only, from real data
     ══════════════════════════════════════════════════════════════════ */
  function buildRecommendations() {
    const recs = [];
    function add(sev, color, text, tab) { recs.push({ sev: sev, color: color, text: text, tab: tab }); }
    if (nativeCache.bal !== null) {
      if (nativeCache.bal < gasCfg.minReserve * 0.5) add('CRITICAL', 'var(--red)', 'Gas balance ' + nativeCache.bal.toFixed(4) + ' USDC is far below your ' + gasCfg.minReserve + ' USDC reserve — executions will abort. Top up now.', 'vault');
      else if (nativeCache.bal < gasCfg.minReserve) add('WARNING', 'var(--yellow)', 'Gas Reserve is below recommended levels (' + nativeCache.bal.toFixed(4) + ' / ' + gasCfg.minReserve + ' USDC).', 'vault');
    }
    const vv = vaultView('USDC');
    if (vv.real !== null && vv.real > 0) {
      if (vv.locked + vv.automation + vv.treasury === 0) add('INFO', 'var(--blue)', 'No vault allocations set — 100% of the AI balance is operational. Consider locking a portion.', 'vault');
      if (vv.treasury === 0 && vv.real >= 100) add('INFO', 'var(--blue)', 'Treasury Allocation is unused with ' + vv.real.toFixed(0) + ' USDC on the agent.', 'vault');
      if (vv.overAllocated) add('CRITICAL', 'var(--red)', 'Vault allocations exceed the real on-chain balance — fix the allocation.', 'vault');
    }
    const thisMonth = spentUsdSince(2592000000);
    const prevMonth = (function () {
      const from = Date.now() - 5184000000, to = Date.now() - 2592000000;
      return history.reduce(function (s, h) { return (h.at >= from && h.at < to && h.kind === 'execution' && h.status === 'executed') ? s + (Number(h.amountUsd) || 0) : s; }, 0);
    })();
    if (prevMonth > 0 && thisMonth > prevMonth) add('WARNING', 'var(--yellow)', 'Monthly spending increased by ' + Math.round(((thisMonth - prevMonth) / prevMonth) * 100) + '% (' + fmtUsd(prevMonth) + ' → ' + fmtUsd(thisMonth) + ').', 'history');
    try {
      const active = AgentAuthorization.getActive();
      const expiring = active.filter(function (a) { return a.expiresAt - Date.now() < 604800000; });
      if (expiring.length) add('WARNING', 'var(--yellow)', expiring.length + ' authorization(s) expiring within 7 days — renew to keep automations running.', 'permissions');
      if (!active.length && workflows.length + intents.length > 0) add('WARNING', 'var(--yellow)', 'No active permission grants — intents will fail the Permission Engine check.', 'permissions');
    } catch (_e) { /* ignore */ }
    try {
      const scheds = ScheduleEngine.getAll();
      const stale = scheds.filter(function (s) { return s.status === 'Active' && s.nextRun && new Date(s.nextRun).getTime() < Date.now() - 3600000; });
      if (stale.length) add('INFO', 'var(--blue)', stale.length + ' schedule(s) past due — the agent scheduler will pick them up, or run them manually.', 'scheduled');
    } catch (_e) { /* ignore */ }
    if (emergencyStop) add('CRITICAL', 'var(--red)', 'Emergency Stop is active — all AI operations are frozen.', 'security');
    let autoScore = 100;
    const failedRuns = intents.filter(function (i) { return i.status === 'failed'; }).length;
    const okRuns = intents.filter(function (i) { return i.status === 'executed'; }).length;
    if (failedRuns + okRuns > 0) autoScore -= Math.round((failedRuns / (failedRuns + okRuns)) * 40);
    if (nativeCache.bal !== null && nativeCache.bal < gasCfg.minReserve) autoScore -= 25;
    if (emergencyStop) autoScore -= 20;
    try { if (!AgentAuthorization.getActive().length) autoScore -= 15; } catch (_e) { /* ignore */ }
    add(autoScore >= 80 ? 'GOOD' : autoScore >= 50 ? 'WARNING' : 'CRITICAL', autoScore >= 80 ? 'var(--green)' : autoScore >= 50 ? 'var(--yellow)' : 'var(--red)', 'Automation Health Score: ' + Math.max(0, autoScore) + '/100 (derived from real executions, gas, grants and stop state).', 'mission');
    return recs;
  }

  function renderRecommendations() {
    const box = $id('aiw-recs-body');
    if (!box) return;
    const recs = buildRecommendations();
    box.innerHTML = recs.map(function (r) {
      return '<div style="display:flex;gap:8px;align-items:flex-start;border:1px solid var(--border);border-radius:6px;padding:8px;margin-bottom:6px;background:rgba(0,0,0,.15)">' +
        '<span class="chip" style="border:1px solid var(--border);color:' + r.color + ';flex-shrink:0">' + esc(r.sev) + '</span>' +
        '<span style="font-size:9.5px;color:var(--text);line-height:1.5;flex:1">' + esc(r.text) + '</span>' +
        (r.tab ? '<button class="btn" style="font-size:8px;padding:2px 8px;flex-shrink:0" onclick="AIWallet.showTab(\'' + r.tab + '\')">Open</button>' : '') + '</div>';
    }).join('') + '<div style="font-size:8px;color:var(--muted2)">Informational only — recommendations never change configurations, grant permissions or execute operations.</div>';
  }

  /* ══════════════════════════════════════════════════════════════════
     PHASE 5 · AI REPORTS CENTER — read-only, real historical data
     ══════════════════════════════════════════════════════════════════ */
  let lastReport = null;

  function reportWindowMs(type) {
    return type === 'daily' ? 86400000 : type === 'weekly' ? 604800000 : 2592000000;
  }

  function generateReport(type) {
    const since = Date.now() - reportWindowMs(type);
    const inWindow = history.filter(function (h) { return h.at >= since; });
    const txs = inWindow.filter(function (h) { return h.txHash; });
    const schedActivity = [];
    try {
      ScheduleEngine.getAll().forEach(function (s) {
        (s.executionHistory || []).forEach(function (e) {
          if (new Date(e.timestamp).getTime() >= since) schedActivity.push({ name: s.name || s.type, amount: e.amount, token: e.token, status: e.status, at: e.timestamp, by: s.createdBy });
        });
      });
    } catch (_e) { /* ignore */ }
    let authChanges = [];
    try { authChanges = (AgentAuthorization.getAuthHistory(50) || []).filter(function (r) { return r.timestamp >= since; }); } catch (_e) { /* ignore */ }
    const decisions = inWindow.filter(function (h) { return h.kind === 'validation'; });
    const security = inWindow.filter(function (h) { return h.kind === 'security'; });
    const gs = gasSums();
    const vaultSnap = { USDC: vaultView('USDC'), EURC: vaultView('EURC') };
    lastReport = {
      type: type, generatedAt: new Date().toISOString(), window: type,
      financialSummary: {
        spentUsd: spentUsdSince(reportWindowMs(type)),
        fundingOps: inWindow.filter(function (h) { return h.kind === 'funding'; }).length,
        onchainTxs: txs.length,
        portfolioUsd: portfolioCache.rows.reduce(function (s, r) { return s + r.totalUsd; }, 0)
      },
      transactions: txs.slice(0, 25),
      vaultAllocations: vaultSnap,
      scheduleActivity: schedActivity.slice(0, 25),
      automationActivity: { workflows: workflows.map(function (w) { return { name: w.name, status: w.status, runs: w.runCount || 0 }; }), intentsExecuted: intents.filter(function (i) { return i.status === 'executed' && i.executedAt >= since; }).length },
      aiDecisions: { approved: decisions.filter(function (d) { return d.status === 'approved'; }).length, rejected: decisions.filter(function (d) { return d.status === 'rejected'; }).length },
      permissionChanges: authChanges.slice(0, 15),
      securityEvents: security.slice(0, 15),
      gas: { today: gs.today, week: gs.week, month: gs.month, balance: nativeCache.bal },
      healthScores: { ai: null, recommendations: buildRecommendations().map(function (r) { return '[' + r.sev + '] ' + r.text; }) }
    };
    renderReports();
    pushHistory({ kind: 'report', status: 'generated', reason: type });
    return lastReport;
  }

  function renderReports() {
    const box = $id('aiw-reports-body');
    if (!box) return;
    if (!lastReport) { box.innerHTML = '<div style="font-size:9.5px;color:var(--muted2)">Pick a report above — assembled read-only from real historical data (module history, schedules, audit, auth history, receipts).</div>'; return; }
    const r = lastReport;
    function sec(title, inner) { return '<div class="st-lbl" style="margin-top:8px">' + esc(title) + '</div>' + inner; }
    let html = '<div style="display:flex;align-items:center;gap:8px"><span style="font-size:11px;font-weight:700;color:var(--text);text-transform:capitalize">' + esc(r.type) + ' Report</span><span style="font-size:8px;color:var(--muted2)">' + esc(new Date(r.generatedAt).toLocaleString()) + '</span>' +
      '<button class="btn" style="font-size:8px;padding:2px 8px;margin-left:auto" onclick="AIWallet.exportReport()"><i class="ti ti-download"></i>Export JSON</button></div>';
    html += sec('Financial Summary', '<div style="font-size:9px;color:var(--muted2)">Spent: <b style="color:var(--text)">' + fmtUsd(r.financialSummary.spentUsd) + '</b> · Funding ops: ' + r.financialSummary.fundingOps + ' · On-chain txs: ' + r.financialSummary.onchainTxs + ' · Portfolio: <b style="color:var(--green)">' + fmtUsd(r.financialSummary.portfolioUsd) + '</b></div>');
    html += sec('Vault Allocations (USDC)', '<div style="font-size:9px;color:var(--muted2)">Operational ' + (r.vaultAllocations.USDC.operational === null ? '—' : r.vaultAllocations.USDC.operational.toFixed(2)) + ' · Locked ' + r.vaultAllocations.USDC.locked.toFixed(2) + ' · Automation ' + r.vaultAllocations.USDC.automation.toFixed(2) + ' · Treasury ' + r.vaultAllocations.USDC.treasury.toFixed(2) + '</div>');
    html += sec('Transactions (' + r.transactions.length + ')', r.transactions.length ? r.transactions.slice(0, 8).map(function (t) {
      return '<div style="font-size:8.5px;color:var(--muted2)">▸ ' + esc(new Date(t.at).toLocaleString() + ' · ' + (t.op || t.kind) + ' · ' + (t.amount || '') + ' ' + (t.token || '')) + ' <a href="' + explorerTx(t.txHash) + '" target="_blank" rel="noopener" style="color:var(--blue)">' + esc(short(t.txHash)) + '</a></div>';
    }).join('') : '<div style="font-size:8.5px;color:var(--muted2)">None in window.</div>');
    html += sec('Schedule Activity (' + r.scheduleActivity.length + ')', r.scheduleActivity.length ? r.scheduleActivity.slice(0, 6).map(function (s) { return '<div style="font-size:8.5px;color:var(--muted2)">▸ ' + esc(s.name + ' · ' + s.amount + ' ' + s.token + ' · ' + s.status + ' · ' + new Date(s.at).toLocaleString()) + '</div>'; }).join('') : '<div style="font-size:8.5px;color:var(--muted2)">None.</div>');
    html += sec('Automation & Workflows', '<div style="font-size:8.5px;color:var(--muted2)">Intents executed: ' + r.automationActivity.intentsExecuted + (r.automationActivity.workflows.length ? '<br>' + r.automationActivity.workflows.map(function (w) { return '▸ ' + esc(w.name + ' · ' + w.status + ' · ' + w.runs + ' runs'); }).join('<br>') : '') + '</div>');
    html += sec('AI Decisions', '<div style="font-size:8.5px;color:var(--muted2)">Approved: <b style="color:var(--green)">' + r.aiDecisions.approved + '</b> · Rejected: <b style="color:var(--red)">' + r.aiDecisions.rejected + '</b></div>');
    html += sec('Permission Changes (' + r.permissionChanges.length + ')', r.permissionChanges.length ? r.permissionChanges.slice(0, 5).map(function (p) { return '<div style="font-size:8.5px;color:var(--muted2)">▸ ' + esc(new Date(p.timestamp).toLocaleString() + ' · ' + p.action + ' · ' + p.authId) + '</div>'; }).join('') : '<div style="font-size:8.5px;color:var(--muted2)">None.</div>');
    html += sec('Security Events (' + r.securityEvents.length + ')', r.securityEvents.length ? r.securityEvents.slice(0, 5).map(function (s) { return '<div style="font-size:8.5px;color:var(--muted2)">▸ ' + esc(new Date(s.at).toLocaleString() + ' · ' + s.status + (s.reason ? ' · ' + s.reason : '')) + '</div>'; }).join('') : '<div style="font-size:8.5px;color:var(--muted2)">None.</div>');
    html += sec('Gas (real receipts)', '<div style="font-size:8.5px;color:var(--muted2)">Today ' + r.gas.today.toFixed(6) + ' · Week ' + r.gas.week.toFixed(6) + ' · Month ' + r.gas.month.toFixed(6) + ' USDC · Balance ' + (r.gas.balance === null ? '—' : r.gas.balance.toFixed(4)) + '</div>');
    html += sec('Recommendations', r.healthScores.recommendations.slice(0, 5).map(function (t) { return '<div style="font-size:8.5px;color:var(--muted2)">▸ ' + esc(t) + '</div>'; }).join(''));
    box.innerHTML = html;
  }

  function exportReport() {
    if (!lastReport) return;
    try {
      const blob = new Blob([JSON.stringify(lastReport, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'aiw-report-' + lastReport.type + '-' + Date.now() + '.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    } catch (e) { notify('Export failed: ' + (e.message || e), 'error'); }
  }



  /* ══════════════════════════════════════════════════════════════════
     RENDERING (all output escaped; renders only inside #page-aiwallet)
     ══════════════════════════════════════════════════════════════════ */
  function chip(text, color) {
    return '<span class="chip" style="border:1px solid var(--border);color:' + color + '">' + esc(text) + '</span>';
  }

  /* ── Internal tab menu (scoped to #page-aiwallet) ─────────────────── */
  const TABS = ['mission', 'assistant', 'overview', 'vault', 'approvals', 'simulate', 'workflows', 'automation', 'executions', 'scheduled', 'permissions', 'limits', 'profiles', 'insights', 'reports', 'history', 'timeline', 'security'];
  function showTab(name) {
    if (TABS.indexOf(name) === -1) name = 'mission';
    TABS.forEach(function (t) {
      const tab = $id('aiw-tab-' + t);
      const panel = $id('aiw-panel-' + t);
      if (tab) tab.classList.toggle('active', t === name);
      if (panel) panel.classList.toggle('active', t === name);
    });
    settings.lastTab = name;
    lsSave(K.settings, settings);
    if (name === 'overview' || name === 'mission') { refreshPortfolio(false); if (name === 'mission') renderMission(); }
    if (name === 'vault') renderVaultPanel();
    if (name === 'timeline') renderTimeline();
    if (name === 'approvals') renderApprovals();
    if (name === 'assistant') renderAssistant();
    if (name === 'workflows') { renderWorkflows(); renderWfDraft(); }
    if (name === 'insights') renderRecommendations();
    if (name === 'reports') renderReports();
  }

  function updatePendingBadge() {
    const badge = $id('aiw-badge-pending');
    if (badge) {
      const n = intents.filter(function (i) { return ['validating', 'approved', 'executing'].indexOf(i.status) !== -1; }).length;
      badge.textContent = String(n);
      badge.style.display = n > 0 ? '' : 'none';
    }
    const ab = $id('aiw-badge-approvals');
    if (ab) {
      const m = approvals.filter(function (a) { return a.status === 'pending'; }).length + intents.filter(function (i) { return i.status === 'approved'; }).length;
      ab.textContent = String(m);
      ab.style.display = m > 0 ? '' : 'none';
    }
  }

  function renderStatus() {
    const el = $id('aiw-status-bar');
    if (!el) return;
    let agentOk = false, paused = false, rep = null;
    try {
      if (typeof AgentWalletManager !== 'undefined') {
        agentOk = !!agentAddr();
        paused = AgentWalletManager.isPaused && AgentWalletManager.isPaused();
        rep = AgentWalletManager.getReputationScore ? AgentWalletManager.getReputationScore() : null;
      }
    } catch (_e) { /* ignore */ }
    el.innerHTML =
      chip('Mode: ' + mode.toUpperCase(), mode === 'personal' ? 'var(--muted2)' : 'var(--purple)') +
      chip(emergencyStop ? 'EMERGENCY STOP' : 'Operational', emergencyStop ? 'var(--red)' : 'var(--green)') +
      chip(agentOk ? 'Agent ' + short(agentAddr()) + (paused ? ' (paused)' : ' active') : 'Agent not created', agentOk && !paused ? 'var(--green)' : 'var(--yellow)') +
      (rep !== null ? chip('Reputation ' + rep, 'var(--blue)') : '') +
      chip('v' + VERSION, 'var(--muted2)');
    const modeSel = $id('aiw-mode');
    if (modeSel && modeSel.value !== mode) modeSel.value = mode;
    const st = $id('aiw-estop-toggle');
    if (st) st.classList.toggle('on', emergencyStop);
  }

  function renderPortfolio() {
    const box = $id('aiw-portfolio-body');
    if (!box) return;
    if (!portfolioCache.rows.length) { box.innerHTML = '<div style="font-size:9.5px;color:var(--muted2)">No data — click Refresh.</div>'; return; }
    let total = 0;
    let html = '';
    portfolioCache.rows.forEach(function (r) {
      total += r.totalUsd;
      html += '<div style="background:rgba(0,0,0,.18);border:1px solid var(--border);border-radius:6px;padding:9px;margin-bottom:7px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">' +
        '<span style="font-size:10px;font-weight:600;color:var(--text)">' + esc(r.label) + '</span>' +
        '<span style="font-size:9px;color:var(--muted2)">' + (r.addr ? esc(short(r.addr)) : 'not connected') + '</span></div>';
      if (!r.addr) html += '<div style="font-size:9px;color:var(--muted2)">—</div>';
      else if (!r.tokens.length) html += '<div style="font-size:9px;color:var(--muted2)">Balance unavailable (RPC)</div>';
      else r.tokens.forEach(function (t) {
        html += '<div style="display:flex;justify-content:space-between;font-size:9.5px;padding:2px 0">' +
          '<span style="color:var(--muted2)">' + esc(t.sym) + '</span>' +
          '<span style="color:var(--text)">' + t.bal.toFixed(2) + ' <span style="color:var(--muted2)">(' + fmtUsd(t.usd) + ')</span></span></div>';
      });
      html += '</div>';
    });
    box.innerHTML = '<div style="display:flex;justify-content:space-between;margin-bottom:8px"><span class="st-lbl">Total Portfolio Value</span><span style="font-size:15px;font-weight:700;color:var(--green)">' + fmtUsd(total) + '</span></div>' + html +
      '<div style="font-size:8px;color:var(--muted2)">Read-only · balances on Arc Testnet · updated ' + new Date(portfolioCache.at).toLocaleTimeString() + '</div>';
  }

  function statusColor(s) {
    return { validating: 'var(--yellow)', approved: 'var(--blue)', executing: 'var(--purple)', executed: 'var(--green)', rejected: 'var(--red)', failed: 'var(--red)', cancelled: 'var(--muted2)' }[s] || 'var(--muted2)';
  }

  function renderExecutions() {
    const pend = $id('aiw-pending-body');
    const done = $id('aiw-completed-body');
    if (!pend || !done) return;
    const pending = intents.filter(function (i) { return ['validating', 'approved', 'executing'].indexOf(i.status) !== -1; });
    const completed = intents.filter(function (i) { return ['executed', 'rejected', 'failed', 'cancelled'].indexOf(i.status) !== -1; });
    function row(it, withActions) {
      let checksHtml = '';
      if (it.checks && it.checks.length) {
        const failed = it.checks.filter(function (c) { return !c.passed; });
        checksHtml = '<div style="font-size:8px;color:var(--muted2);margin-top:2px">' +
          it.checks.filter(function (c) { return c.passed; }).length + '/' + it.checks.length + ' validations passed' +
          (failed.length ? ' · <span style="color:var(--red)">' + esc(failed.map(function (c) { return c.name; }).join(', ')) + '</span>' : '') + '</div>';
      }
      let actions = '';
      if (withActions) {
        if (it.status === 'approved') actions += '<button class="btn primary" style="font-size:8.5px;padding:2px 8px" onclick="AIWallet.executeIntent(\'' + esc(it.id) + '\')">Execute</button>';
        if (it.status !== 'executing') actions += '<button class="btn" style="font-size:8.5px;padding:2px 8px" onclick="AIWallet.cancelIntent(\'' + esc(it.id) + '\')">Cancel</button>';
        else actions += '<button class="btn" style="font-size:8.5px;padding:2px 8px" onclick="AIWallet.cancelIntent(\'' + esc(it.id) + '\')">Halt</button>';
      }
      return '<div style="background:rgba(0,0,0,.18);border:1px solid var(--border);border-radius:6px;padding:8px;margin-bottom:6px">' +
        '<div style="display:flex;align-items:center;gap:6px">' +
        '<span style="font-size:9px;font-weight:700;color:' + statusColor(it.status) + ';text-transform:uppercase">' + esc(it.status) + '</span>' +
        '<span style="font-size:9.5px;color:var(--text);font-weight:600">' + esc(it.op) + ' · ' + esc(String(it.amount)) + ' ' + esc(it.token) + '</span>' +
        (it.riskLevel ? '<span style="font-size:8px;color:var(--muted2)">risk ' + esc(it.riskLevel) + '</span>' : '') +
        '<span style="margin-left:auto;display:flex;gap:4px">' + actions + '</span></div>' +
        '<div style="font-size:8.5px;color:var(--muted2);margin-top:3px">' + esc(it.id) + ' · src: ' + esc(it.source) + ' · nonce #' + it.nonce +
        (it.to ? ' · to ' + esc(short(it.to)) : '') + (it.recipients && it.recipients.length > 1 ? ' · ' + it.recipients.length + ' recipients' : '') + '</div>' +
        (it.reason ? '<div style="font-size:8px;color:var(--red);margin-top:2px">' + esc(it.reason) + '</div>' : '') +
        checksHtml + timelineHtml(it) + '</div>';
    }
    pend.innerHTML = pending.length ? pending.map(function (i) { return row(i, true); }).join('') : '<div style="font-size:9.5px;color:var(--muted2)">No pending executions.</div>';
    done.innerHTML = completed.length ? completed.slice(0, 12).map(function (i) { return row(i, false); }).join('') : '<div style="font-size:9.5px;color:var(--muted2)">Nothing completed yet.</div>';
    updatePendingBadge();
  }

  function renderScheduled() {
    const box = $id('aiw-scheduled-body');
    if (!box) return;
    let all = [];
    try { if (typeof ScheduleEngine !== 'undefined') all = ScheduleEngine.getAll(); } catch (_e) { /* ignore */ }
    if (!all.length) { box.innerHTML = '<div style="font-size:9.5px;color:var(--muted2)">No scheduled tasks.</div>'; return; }
    box.innerHTML = all.slice(0, 15).map(function (s) {
      const mine = s.createdBy === 'aiwallet';
      const src = mine ? 'AI Smart Wallet' : (s.createdBy === 'user' ? 'Schedule page' : esc(s.createdBy || 'user'));
      let actions = '';
      if (mine) {
        if (s.status === 'Active') actions += '<button class="btn" style="font-size:8px;padding:2px 7px" onclick="AIWallet.pauseSchedule(\'' + esc(s.id) + '\')">Pause</button>';
        if (s.status === 'Paused') actions += '<button class="btn" style="font-size:8px;padding:2px 7px" onclick="AIWallet.resumeSchedule(\'' + esc(s.id) + '\')">Resume</button>';
        actions += '<button class="btn" style="font-size:8px;padding:2px 7px" onclick="AIWallet.deleteSchedule(\'' + esc(s.id) + '\')">Delete</button>';
      }
      return '<div style="display:flex;align-items:center;gap:7px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;margin-bottom:5px;background:rgba(0,0,0,.15)">' +
        '<span style="width:7px;height:7px;border-radius:50%;flex-shrink:0;background:' + (s.status === 'Active' ? 'var(--green)' : s.status === 'Paused' ? 'var(--yellow)' : 'var(--muted)') + '"></span>' +
        '<div style="flex:1;min-width:0"><div style="font-size:9.5px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(s.name || s.type) + '</div>' +
        '<div style="font-size:8px;color:var(--muted2)">' + esc(s.type) + ' · ' + esc(String(s.amount)) + ' ' + esc(s.token) + ' · ' + esc(s.freq) + ' · next ' + (s.nextRun ? esc(new Date(s.nextRun).toLocaleString()) : '—') + ' · by ' + src + ' · runs ' + (s.execCount || 0) + '</div></div>' +
        '<span style="display:flex;gap:4px">' + actions + '</span></div>';
    }).join('') + '<div style="font-size:8px;color:var(--muted2)">Tasks created elsewhere are shown read-only. Executor: existing Agent Wallet scheduler.</div>';
  }

  function renderPermissions() {
    const box = $id('aiw-permissions-body');
    if (!box) return;
    if (typeof AgentAuthorization === 'undefined') {
      box.innerHTML = '<div style="font-size:9.5px;color:var(--muted2)">AgentAuthorization engine unavailable.</div>';
      return;
    }
    try {
      const sum = AgentAuthorization.getAuthSummary();
      const active = AgentAuthorization.getActive();
      let html = '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px">' +
        '<div><div class="st-lbl">Active Grants</div><div class="st-val" style="font-size:15px">' + active.length + '</div></div>' +
        '<div><div class="st-lbl">Total Spend Cap</div><div class="st-val" style="font-size:15px">' + fmtUsd(sum.totalSpendingLimit) + '</div></div>' +
        '<div><div class="st-lbl">Daily Cap</div><div class="st-val" style="font-size:15px">' + fmtUsd(sum.totalDailyLimit) + '</div></div></div>';
      if (!active.length) {
        html += '<div style="font-size:9px;color:var(--muted2)">No active authorizations. Grant permissions via Autonoma permission cards — this panel reuses the same engine (no duplicates).</div>';
      } else {
        active.forEach(function (a) {
          html += '<div style="border:1px solid var(--border);border-radius:6px;padding:7px 9px;margin-bottom:5px;background:rgba(0,0,0,.15)">' +
            '<div style="display:flex;align-items:center;gap:6px"><span style="font-size:9.5px;font-weight:600;color:var(--text)">' + esc(a.id) + '</span>' +
            '<span style="font-size:8px;color:var(--muted2)">expires ' + esc(AgentAuthorization.fmtTimeLeft(a.expiresAt)) + '</span>' +
            '<button class="btn" style="margin-left:auto;font-size:8px;padding:2px 7px" onclick="AIWallet.revokeAuth(\'' + esc(a.id) + '\')">Revoke</button></div>' +
            '<div style="font-size:8.5px;color:var(--muted2);margin-top:3px">Ops: ' + esc(AgentAuthorization.fmtAllowedOps(a)) +
            ' · Max ' + fmtUsd(a.maxSpending || 0) + ' · Daily ' + fmtUsd(a.dailyLimit || 0) + ' (used ' + fmtUsd(a.dailyUsed || 0) + ')</div></div>';
        });
      }
      box.innerHTML = html;
    } catch (e) {
      box.innerHTML = '<div style="font-size:9.5px;color:var(--red)">Permission engine error: ' + esc(e.message || e) + '</div>';
    }
  }

  function renderLimits() {
    const ids = { 'aiw-lim-perop': limits.perOpUsd, 'aiw-lim-daily': limits.dailyUsd, 'aiw-lim-monthly': limits.monthlyUsd, 'aiw-lim-hstart': limits.hourStart, 'aiw-lim-hend': limits.hourEnd };
    Object.keys(ids).forEach(function (id) { const el = $id(id); if (el) el.value = ids[id]; });
    const spent = $id('aiw-lim-spent');
    if (spent) spent.innerHTML = 'Spent via AI Smart Wallet: <b style="color:var(--text)">' + fmtUsd(spentUsdSince(86400000)) + '</b> today · <b style="color:var(--text)">' + fmtUsd(spentUsdSince(2592000000)) + '</b> this month';
    document.querySelectorAll('[data-aiw-op]').forEach(function (el) {
      el.classList.toggle('on', limits.allowedOps.indexOf(el.getAttribute('data-aiw-op')) !== -1);
    });
    document.querySelectorAll('[data-aiw-token]').forEach(function (el) {
      el.classList.toggle('on', limits.allowedTokens.indexOf(el.getAttribute('data-aiw-token')) !== -1);
    });
  }

  function renderPolicies() {
    const box = $id('aiw-policies-body');
    if (!box) return;
    if (typeof PolicyEngine === 'undefined') { box.innerHTML = '<div style="font-size:9.5px;color:var(--muted2)">PolicyEngine unavailable.</div>'; return; }
    try {
      const d = PolicyEngine.getDefaults();
      box.innerHTML =
        '<div class="stg-row" style="display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10px;padding:5px 0"><span style="color:var(--muted2)">Max daily operations</span><input class="cinput" style="width:80px" type="number" id="aiw-pol-maxops" value="' + Number(d.maxDailyOps || 50) + '"/></div>' +
        '<div class="stg-row" style="display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10px;padding:5px 0"><span style="color:var(--muted2)">Max gas per op (USD)</span><input class="cinput" style="width:80px" type="number" id="aiw-pol-maxgas" value="' + Number(d.maxGasUsd || 5) + '"/></div>' +
        '<div class="stg-row" style="display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10px;padding:5px 0"><span style="color:var(--muted2)">Require risk check</span><span class="stg-toggle ' + (d.requireRiskCheck ? 'on' : '') + '" style="min-width:44px" id="aiw-pol-risk" onclick="AIWallet.togglePolicy(\'requireRiskCheck\',this)"></span></div>' +
        '<div class="stg-row" style="display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10px;padding:5px 0"><span style="color:var(--muted2)">Require authorization</span><span class="stg-toggle ' + (d.requireAuthorization ? 'on' : '') + '" style="min-width:44px" id="aiw-pol-auth" onclick="AIWallet.togglePolicy(\'requireAuthorization\',this)"></span></div>' +
        '<button class="btn primary" style="font-size:9px;margin-top:6px" onclick="AIWallet.savePolicies()">Save Policies</button>' +
        '<div style="font-size:8px;color:var(--muted2);margin-top:5px">Stored in the shared PolicyEngine — the same rules govern Autonoma executions.</div>';
    } catch (e) {
      box.innerHTML = '<div style="font-size:9.5px;color:var(--red)">Policy engine error: ' + esc(e.message || e) + '</div>';
    }
  }

  function renderAgentInfo() {
    const box = $id('aiw-agent-body');
    if (!box) return;
    if (typeof AgentWalletManager === 'undefined') { box.innerHTML = '<div style="font-size:9.5px;color:var(--muted2)">AgentWalletManager unavailable.</div>'; return; }
    try {
      const addr = agentAddr();
      const paused = AgentWalletManager.isPaused && AgentWalletManager.isPaused();
      const rep = AgentWalletManager.getReputationScore ? AgentWalletManager.getReputationScore() : '—';
      const chains = AgentWalletManager.getSupportedChains ? AgentWalletManager.getSupportedChains() : [];
      box.innerHTML =
        '<div style="font-size:9.5px;display:flex;flex-direction:column;gap:5px">' +
        '<div style="display:flex;justify-content:space-between"><span style="color:var(--muted2)">Address</span><span style="color:var(--text);font-family:monospace">' + (addr ? esc(short(addr)) : 'not created') + '</span></div>' +
        '<div style="display:flex;justify-content:space-between"><span style="color:var(--muted2)">Status</span><span style="color:' + (paused ? 'var(--yellow)' : 'var(--green)') + '">' + (paused ? 'Paused' : 'Active') + '</span></div>' +
        '<div style="display:flex;justify-content:space-between"><span style="color:var(--muted2)">Reputation</span><span style="color:var(--text)">' + esc(String(rep)) + '</span></div>' +
        '<div style="display:flex;justify-content:space-between"><span style="color:var(--muted2)">Execution chain</span><span style="color:var(--text)">Arc Testnet · 5042002</span></div>' +
        '<div style="display:flex;justify-content:space-between"><span style="color:var(--muted2)">Supported chains</span><span style="color:var(--text)">' + (chains.length || 1) + '</span></div>' +
        '</div><div style="font-size:8px;color:var(--muted2);margin-top:7px">Managed by the existing AgentWalletManager. The AI Smart Wallet never stores or exports keys.</div>';
    } catch (e) {
      box.innerHTML = '<div style="font-size:9.5px;color:var(--red)">Agent info error: ' + esc(e.message || e) + '</div>';
    }
  }

  function renderHistory() {
    const box = $id('aiw-history-body');
    if (!box) return;
    let audit = [];
    try { if (typeof AgentAudit !== 'undefined' && AgentAudit.getRecords) audit = AgentAudit.getRecords(10) || []; } catch (_e) { /* ignore */ }
    let html = '';
    history.slice(0, 25).forEach(function (h) {
      const col = h.status === 'executed' || h.status === 'approved' || h.status === 'confirmed' ? 'var(--green)' : (h.status === 'rejected' || h.status === 'failed' || h.status === 'aborted' ? 'var(--red)' : 'var(--muted2)');
      const txLink = (h.txHash && /^0x[0-9a-fA-F]{64}$/.test(h.txHash))
        ? ' <a href="' + explorerTx(h.txHash) + '" target="_blank" rel="noopener" style="color:var(--blue);text-decoration:none">' + esc(short(h.txHash)) + '</a>'
        : '';
      html += '<div style="display:flex;gap:6px;font-size:8.5px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.03)">' +
        '<span style="color:var(--muted2);flex-shrink:0">' + new Date(h.at).toLocaleTimeString() + '</span>' +
        '<span style="color:' + col + ';text-transform:uppercase;flex-shrink:0">' + esc(h.kind + ':' + h.status) + '</span>' +
        '<span style="color:var(--muted2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc((h.intentId || h.schedId || h.op || '') + (h.op && h.intentId ? ' · ' + h.op : '') + (h.amount ? ' · ' + h.amount + ' ' + (h.token || '') : '') + (h.reason ? ' · ' + h.reason : '')) + txLink + '</span></div>';
    });
    if (!html) html = '<div style="font-size:9.5px;color:var(--muted2)">No AI wallet activity yet.</div>';
    if (audit.length) {
      html += '<div class="st-lbl" style="margin-top:8px">Agent Audit Trail (shared engine)</div>';
      audit.forEach(function (r) {
        html += '<div style="display:flex;gap:6px;font-size:8.5px;padding:3px 0;color:var(--muted2)">' +
          '<span>' + esc(r.timestamp ? new Date(r.timestamp).toLocaleTimeString() : '') + '</span>' +
          '<span style="color:' + (r.result === 'success' ? 'var(--green)' : 'var(--red)') + '">' + esc(r.result || '') + '</span>' +
          '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc((r.operation || '') + ' · ' + (r.amount || '') + ' ' + (r.asset || '') + (r.transactionHash ? ' · ' + short(r.transactionHash) : '')) + '</span></div>';
      });
    }
    box.innerHTML = html;
  }

  function renderSecurity() {
    const auto = $id('aiw-sec-autoexec');
    if (auto) auto.classList.toggle('on', !!settings.autoExecute);
    const risk = $id('aiw-sec-maxrisk');
    if (risk && risk.value !== settings.maxRisk) risk.value = settings.maxRisk;
    const est = $id('aiw-estop-toggle');
    if (est) est.classList.toggle('on', emergencyStop);
    const lbl = $id('aiw-estop-label');
    if (lbl) {
      lbl.textContent = emergencyStop ? 'EMERGENCY STOP ACTIVE — AI executions disabled' : 'Emergency Stop (AI Smart Wallet scope only)';
      lbl.style.color = emergencyStop ? 'var(--red)' : 'var(--muted2)';
    }
  }

  function renderAll() {
    renderStatus(); renderExecutions(); renderScheduled(); renderPermissions();
    renderLimits(); renderPolicies(); renderAgentInfo(); renderHistory(); renderSecurity();
    renderWalletManager(); renderReceive(); renderGrantOps(); renderSecurityCenter(); renderHistoryStats();
    renderVaultPanel(); renderPortfolioIntelligence(); renderSchedDash(); renderAutoStats();
    renderMission(); renderApprovals(); renderProfiles(); renderTimeline();
    renderAssistant(); renderWorkflows(); renderWfDraft(); renderRecommendations(); renderReports();
    renderPortfolio();
  }

  /* ══════════════════════════════════════════════════════════════════
     UI ACTIONS (exposed)
     ══════════════════════════════════════════════════════════════════ */
  function setMode(m) {
    if (['personal', 'ai', 'hybrid'].indexOf(m) === -1) return;
    mode = m; lsSave(K.mode, mode);
    pushHistory({ kind: 'settings', status: 'mode_' + m });
    notify('Wallet mode: ' + m.toUpperCase() + (m === 'personal' ? ' — autonomous execution off' : ''), 'info');
    renderStatus(); renderHistory();
  }

  function saveLimits() {
    const num = function (id, def) { const el = $id(id); const v = parseFloat(el && el.value); return isFinite(v) && v >= 0 ? v : def; };
    limits.perOpUsd = num('aiw-lim-perop', limits.perOpUsd);
    limits.dailyUsd = num('aiw-lim-daily', limits.dailyUsd);
    limits.monthlyUsd = num('aiw-lim-monthly', limits.monthlyUsd);
    limits.hourStart = Math.min(23, Math.max(0, num('aiw-lim-hstart', limits.hourStart)));
    limits.hourEnd = Math.min(24, Math.max(1, num('aiw-lim-hend', limits.hourEnd)));
    lsSave(K.limits, limits);
    pushHistory({ kind: 'settings', status: 'limits_updated' });
    notify('Spending limits saved', 'success');
    renderLimits(); renderHistory();
  }

  function toggleOp(el) {
    const op = el.getAttribute('data-aiw-op');
    const i = limits.allowedOps.indexOf(op);
    if (i === -1) limits.allowedOps.push(op); else limits.allowedOps.splice(i, 1);
    lsSave(K.limits, limits); renderLimits();
  }
  function toggleToken(el) {
    const tk = el.getAttribute('data-aiw-token');
    const i = limits.allowedTokens.indexOf(tk);
    if (i === -1) limits.allowedTokens.push(tk); else limits.allowedTokens.splice(i, 1);
    lsSave(K.limits, limits); renderLimits();
  }

  function toggleAutoExec() {
    settings.autoExecute = !settings.autoExecute;
    lsSave(K.settings, settings);
    pushHistory({ kind: 'settings', status: settings.autoExecute ? 'autoexec_on' : 'autoexec_off' });
    renderSecurity(); renderHistory();
  }
  function setMaxRisk(v) {
    if (['LOW', 'MEDIUM', 'HIGH'].indexOf(v) === -1) return;
    settings.maxRisk = v; lsSave(K.settings, settings);
    renderSecurity();
  }

  const pendingPolicy = {};
  function togglePolicy(key, el) {
    if (typeof PolicyEngine === 'undefined') return;
    const cur = key in pendingPolicy ? pendingPolicy[key] : !!PolicyEngine.getDefaults()[key];
    pendingPolicy[key] = !cur;
    if (el) el.classList.toggle('on', !cur);
  }
  function savePolicies() {
    if (typeof PolicyEngine === 'undefined') return;
    try {
      const ops = parseFloat(($id('aiw-pol-maxops') || {}).value);
      const gas = parseFloat(($id('aiw-pol-maxgas') || {}).value);
      if (isFinite(ops) && ops > 0) PolicyEngine.setDefault('maxDailyOps', ops);
      if (isFinite(gas) && gas > 0) PolicyEngine.setDefault('maxGasUsd', gas);
      Object.keys(pendingPolicy).forEach(function (k) { PolicyEngine.setDefault(k, pendingPolicy[k]); });
      pushHistory({ kind: 'settings', status: 'policies_updated' });
      notify('Policies saved to shared PolicyEngine', 'success');
    } catch (e) { notify('Policy save failed: ' + (e.message || e), 'error'); }
    renderPolicies(); renderHistory();
  }

  function revokeAuth(id) {
    if (typeof AgentAuthorization === 'undefined') return;
    try {
      AgentAuthorization.revokeAuthorization(id);
      pushHistory({ kind: 'security', status: 'auth_revoked', reason: id });
      notify('Authorization ' + id + ' revoked', 'success');
    } catch (e) { notify('Revoke failed: ' + (e.message || e), 'error'); }
    renderPermissions(); renderHistory();
  }

  function pauseSchedule(id) {
    try { const s = ScheduleEngine.getById(id); if (s && s.createdBy === 'aiwallet') ScheduleEngine.update(id, { status: 'Paused' }); } catch (_e) { /* ignore */ }
    renderScheduled();
  }
  function resumeSchedule(id) {
    if (emergencyStop) { notify('Emergency Stop active — cannot resume', 'error'); return; }
    try { const s = ScheduleEngine.getById(id); if (s && s.createdBy === 'aiwallet') ScheduleEngine.update(id, { status: 'Active' }); } catch (_e) { /* ignore */ }
    renderScheduled();
  }
  function deleteSchedule(id) {
    try { const s = ScheduleEngine.getById(id); if (s && s.createdBy === 'aiwallet') ScheduleEngine.remove(id); } catch (_e) { /* ignore */ }
    renderScheduled();
  }

  function parseStartAt(v) {
    if (!v) return null;
    try {
      if (typeof parseDateTimeAsUTC === 'function') {
        const d = parseDateTimeAsUTC(v);
        if (d && isFinite(d.getTime())) return d.getTime();
      }
    } catch (_e) { /* fall through */ }
    const t = new Date(v).getTime();
    return isFinite(t) ? t : null;
  }

  /* Automation Center form */
  function createAutomation() {
    const val = function (id) { const el = $id(id); return el ? el.value : ''; };
    const op = val('aiw-auto-type') || 'payment';
    const amount = parseFloat(val('aiw-auto-amount'));
    if (!isFinite(amount) || amount <= 0) { notify('Enter a valid amount', 'error'); return; }
    const to = (val('aiw-auto-to') || '').trim();
    const needsAddr = ['payment', 'transfer', 'recurring', 'payroll', 'multisend', 'treasury'].indexOf(op) !== -1;
    if (needsAddr && !/^0x[a-fA-F0-9]{40}$/.test(to)) { notify('Enter a valid recipient address (0x…)', 'error'); return; }
    const raw = {
      op: op,
      name: (val('aiw-auto-name') || (op + ' automation')).trim(),
      amount: amount,
      token: val('aiw-auto-token') || 'USDC',
      to: to,
      network: 'Arc_Testnet',
      toNetwork: val('aiw-auto-tonet') || 'Base_Sepolia',
      swapToToken: op === 'swap' ? (val('aiw-auto-swapto') || 'EURC') : undefined,
      freq: val('aiw-auto-freq') || 'once',
      startAt: parseStartAt(val('aiw-auto-start')),
      source: 'automation-center'
    };
    const id = submitIntent(raw);
    if (id) { notify('Automation submitted — intent ' + id + ' entering validation', 'info'); showTab('executions'); }
  }

  function onAutoTypeChange() {
    const op = ($id('aiw-auto-type') || {}).value || 'payment';
    const showTo = ['payment', 'transfer', 'recurring', 'payroll', 'multisend', 'treasury'].indexOf(op) !== -1;
    const toWrap = $id('aiw-auto-to-wrap'); if (toWrap) toWrap.style.display = showTo ? '' : 'none';
    const swapWrap = $id('aiw-auto-swap-wrap'); if (swapWrap) swapWrap.style.display = op === 'swap' ? '' : 'none';
    const netWrap = $id('aiw-auto-tonet-wrap'); if (netWrap) netWrap.style.display = (op === 'bridge' || op === 'crosschain') ? '' : 'none';
  }

  function exportHistory() {
    try {
      const blob = new Blob([JSON.stringify({ version: VERSION, exportedAt: new Date().toISOString(), history: history, intents: intents }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'ai-smart-wallet-history.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    } catch (e) { notify('Export failed: ' + (e.message || e), 'error'); }
  }

  function onShow() {
    showTab(settings.lastTab || 'mission');
    renderAll();
    refreshPortfolio(false);
  }

  /* ── Init (passive — waits for DOM, never touches other modules) ─── */
  function init() {
    const page = $id('page-aiwallet');
    if (!page) return;
    try {
      const obs = new MutationObserver(function () {
        if (page.classList.contains('active')) onShow();
      });
      obs.observe(page, { attributes: true, attributeFilter: ['class'] });
    } catch (_e) { /* ignore */ }
    document.addEventListener('SCHEDULE_UPDATED', function (e) {
      onScheduleUpdated(e.detail);
      try { if (e.detail && e.detail.changes && e.detail.changes.execCount !== undefined) onScheduleExecutedForWorkflows(e.detail); } catch (_e) { /* ignore */ }
    });
    document.addEventListener('SCHEDULE_CREATED', function (e) { onScheduleCreated(e.detail); });
    document.addEventListener('SCHEDULE_DELETED', function () { renderScheduled(); });
    onAutoTypeChange();
    onFundFlowChange();
    if (!monitorTimer) {
      monitorTimer = setInterval(function () {
        var pg = $id('page-aiwallet');
        // [M6 FIX] Only run when the page is active
        if (!pg || !pg.classList.contains('active')) return;
        checkAutoTopup();
        checkWorkflows();
        renderExecutions(); renderScheduled(); renderStatus(); renderSchedDash();
        // Sync workflow & recommendation data to FinancialContext bridge
        try {
          if (typeof FinancialContext !== 'undefined') {
            if (FinancialContext.updateWorkflowsList) FinancialContext.updateWorkflowsList(workflows);
            if (FinancialContext.updateRecommendations) FinancialContext.updateRecommendations(buildRecommendations());
          }
        } catch (_e) {}
      }, 60000);
    }
    if (page.classList.contains('active')) onShow();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  /* ── Public API ───────────────────────────────────────────────────── */
  window.AIWallet = {
    VERSION: VERSION,
    /* intent engine */
    submitIntent: submitIntent,
    executeIntent: executeIntent,
    cancelIntent: cancelIntent,
    validateIntent: validateIntent,
    /* modes & security */
    setMode: setMode,
    setEmergencyStop: setEmergencyStop,
    toggleEmergencyStop: function () { setEmergencyStop(!emergencyStop); },
    isEmergencyStopped: function () { return emergencyStop; },
    getMode: function () { return mode; },
    toggleAutoExec: toggleAutoExec,
    setMaxRisk: setMaxRisk,
    /* limits & policies & permissions */
    saveLimits: saveLimits,
    toggleOp: toggleOp,
    toggleToken: toggleToken,
    togglePolicy: togglePolicy,
    savePolicies: savePolicies,
    revokeAuth: revokeAuth,
    /* schedules */
    pauseSchedule: pauseSchedule,
    resumeSchedule: resumeSchedule,
    deleteSchedule: deleteSchedule,
    /* automation center */
    createAutomation: createAutomation,
    onAutoTypeChange: onAutoTypeChange,
    /* internal menu */
    showTab: showTab,
    /* funding (real on-chain) */
    fundingSubmit: fundingSubmit,
    onFundFlowChange: onFundFlowChange,
    copyAgentAddress: copyAgentAddress,
    /* permission grants (existing engine) */
    toggleGrantOp: toggleGrantOp,
    grantPermission: grantPermission,
    revokeAllPerms: revokeAllPerms,
    /* security center */
    togglePauseAgent: togglePauseAgent,
    /* vault & gas (phase 3) */
    setVaultAlloc: setVaultAlloc,
    saveGasCfg: saveGasCfg,
    toggleTopup: toggleTopup,
    topupNow: topupNow,
    renderVaultPanel: renderVaultPanel,
    /* fund wizard */
    wizOpen: wizOpen,
    wizClose: wizClose,
    wizNext: wizNext,
    wizBack: wizBack,
    wizApprove: wizApprove,
    /* phase 4 — approval center, simulation, profiles, timeline */
    approveRequest: approveRequest,
    rejectRequest: rejectRequest,
    runSimulation: runSimulation,
    simToIntent: simToIntent,
    onSimOpChange: onSimOpChange,
    applyProfile: applyProfile,
    /* phase 5 — assistant, workflows, insights, reports */
    assistantSend: assistantSend,
    asstQuick: asstQuick,
    wfAddCondition: wfAddCondition,
    wfAddAction: wfAddAction,
    wfRemoveCond: wfRemoveCond,
    wfRemoveAct: wfRemoveAct,
    wfOnActTypeChange: wfOnActTypeChange,
    wfCreate: wfCreate,
    wfToggle: wfToggle,
    wfDelete: wfDelete,
    generateReport: generateReport,
    exportReport: exportReport,
    /* autonoma bridge (opt-in, additive) */
    receiveAutonomaIntent: function(intent) {
      return submitIntent(intent);
    },
    /* portfolio & misc */
    refreshPortfolio: function () { return refreshPortfolio(true); },
    exportHistory: exportHistory,
    onShow: onShow,
    /* [M6 FIX] Stop monitoring on page unload / navigation */
    stopMonitor: function() { if(monitorTimer){ clearInterval(monitorTimer); monitorTimer = null; } },
    getIntents: function () { return intents.slice(); },
    getHistory: function () { return history.slice(); },
    getWorkflows: function () { return workflows.slice(); },
    getRecommendations: function () { return buildRecommendations(); },
    /* context bridge (read-only for FinancialContext & Autonoma) */
    _portfolioData: function() {
      var total = 0; var wals = [];
      portfolioCache.rows.forEach(function(r) { total += r.totalUsd; wals.push(r); });
      return { totalUsd: total, wallets: wals, cacheAge: Date.now() - portfolioCache.at };
    },
    _vaultView: function(token) { return vaultView(token || 'USDC'); },
    _getGasCfg: function() { return gasCfg; },
    _getGasStatus: function() { return gasStatus(false); },
    _getGasLog: function() { return gasLog.slice(); },
    _getLimits: function() { return Object.assign({}, limits); },
    _getSpendingCapacity: function() {
      var spent = spentUsdSince(86400000);
      var vv = vaultView('USDC');
      return {
        dailyLimit: limits.dailyUsd,
        spentToday: spent,
        remaining: Math.max(0, limits.dailyUsd - spent),
        perOpMax: limits.perOpUsd,
        monthlyLimit: limits.monthlyUsd,
        spentMonth: spentUsdSince(2592000000),
        operationalUSDC: vv.operational,
        gasBalance: nativeCache.bal
      };
    }
  };
})();
