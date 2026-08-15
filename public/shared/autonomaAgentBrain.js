/**
 * AutonomaAgentBrain — Agent orchestration layer (Phase 1)
 * =============================================================
 * Orchestrates the EXISTING Autonoma components through one controlled
 * lifecycle instead of replacing them:
 *
 *   UNDERSTAND → CONTEXT → PLAN → POLICY → EXECUTE → VERIFY → REMEMBER → RESPOND
 *
 * It reuses (never duplicates) the existing modules:
 *   - AutonomaNLU / AutonomaCore / AutonomaLLM    (understand)
 *   - FinancialContext / AgentWalletManager / AgentSession / AgentAuthorization (context)
 *   - ExecutionPlanner (plan)
 *   - AgentAuthorization / PolicyEngine / RiskEngine (policy)
 *   - the existing intent router (execute, injected as runtime.executeIntent)
 *   - AgentAudit / ExecutionHistory (verify)
 *   - AgentSession / AutonomaCore memory / RecipientResolver (remember)
 *
 * Gated by the feature flag `AUTONOMA_AGENT_BRAIN_ENABLED` (default OFF) so the
 * existing behaviour is unchanged until the flag is turned on.
 *
 * Attached to: window.AutonomaAgentBrain
 */
(function () {
  'use strict';

  var VERSION = '1.0.0';
  var FLAG = 'AUTONOMA_AGENT_BRAIN_ENABLED';
  var PENDING_KEY = 'elligentt_agent_brain_pending_v1';
  var EXECUTED_KEY = 'elligentt_agent_brain_executed_v1';
  var _lastPending = null; // in-memory reference to the last plan awaiting confirmation

  /* ── tiny safe helpers ─────────────────────────────────────── */
  function mod(name) {
    try { return (typeof window !== 'undefined' && window[name] != null) ? window[name] : null; } catch (e) { return null; }
  }
  function isEnabled() {
    try { return !!(typeof window !== 'undefined' && window[FLAG] === true); } catch (e) { return false; }
  }
  function now() {
    try { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); } catch (e) { return Date.now(); }
  }
  function uid(prefix) {
    return (prefix || 'run') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }
  function localGet(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
  }
  function localSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  /* ── intent classification (read vs write) ─────────────────── */
  var READ_INTENTS = {
    query_balance: 1, query_history: 1, query_treasury: 1, query_liquidity: 1,
    query_profile: 1, perm_query: 1, perm_audit: 1, perm_session_wallet: 1,
    agent_identity: 1, agent_wallet: 1, agent_auth: 1, agent_reputation: 1,
    execution_history: 1, execution_plan: 1, execution_queue: 1,
    scheduled_permits: 1, show_contacts: 1, contract_info: 1,
    help: 1, greeting: 1, default: 1
  };

  /* Existing uppercase intent names → canonical lowercase operation. */
  var CANONICAL = {
    SEND_PAYMENT: 'send_payment',
    SWAP_EXECUTE: 'swap_execute',
    SWAP_GUIDE: 'swap_guide',
    BRIDGE: 'bridge',
    CROSS_CHAIN: 'cross_chain',
    CREATE_SCHEDULE: 'create_schedule',
    CREATE_PAYMENT_LINK: 'create_payment_link',
    CREATE_INVOICE: 'create_invoice',
    MULTISEND: 'multisend',
    MASS_PAYMENT: 'mass_payment',
    BATCH_SWAP: 'batch_swap',
    CROSSCHAIN_PAYROLL: 'crosschain_payroll',
    ADD_LIQUIDITY: 'add_liquidity',
    REMOVE_LIQUIDITY: 'remove_liquidity',
    EXECUTE_SCHEDULES: 'execute_schedules',
    MULTI_STEP_WORKFLOW: 'multi_step_workflow',
    QUERY_BALANCE: 'query_balance',
    QUERY_HISTORY: 'query_history',
    QUERY_TREASURY: 'query_treasury',
    QUERY_LIQUIDITY: 'query_liquidity',
    QUERY_PROFILE: 'query_profile',
    CONTRACT_INFO: 'contract_info',
    PERM_QUERY: 'perm_query',
    PERM_REVOKE: 'perm_revoke',
    PERM_INCREASE: 'perm_increase',
    PERM_CANCEL_ALL: 'perm_cancel_all',
    PERM_AUDIT: 'perm_audit',
    PERM_SESSION_WALLET: 'perm_session_wallet',
    EXECUTION_PLAN: 'execution_plan',
    EXECUTION_HISTORY: 'execution_history',
    EXECUTION_QUEUE: 'execution_queue',
    SCHEDULED_PERMITS: 'scheduled_permits',
    AGENT_IDENTITY: 'agent_identity',
    AGENT_WALLET: 'agent_wallet',
    AGENT_AUTH: 'agent_auth',
    AGENT_PAUSE: 'agent_pause',
    AGENT_RESUME: 'agent_resume',
    AGENT_REVOKE: 'agent_revoke',
    AGENT_REPUTATION: 'agent_reputation',
    SHOW_CONTACTS: 'show_contacts',
    HELP: 'help',
    GREETING: 'greeting',
    DEFAULT: 'default'
  };

  /* canonical op → AgentAuthorization operation key (reuses existing mapping). */
  var OP_TO_AUTH = {
    send_payment: 'payment', multisend: 'payment', mass_payment: 'payment',
    swap_execute: 'swap', swap_guide: 'swap', add_liquidity: 'swap', remove_liquidity: 'swap',
    bridge: 'bridge', cross_chain: 'crosschain', crosschain_payroll: 'crosschain',
    create_schedule: 'scheduled', execute_schedules: 'scheduled',
    treasury: 'treasury'
  };

  function canonical(intent) {
    return CANONICAL[intent] || String(intent || 'default').toLowerCase();
  }
  function isRead(canonical) { return !!READ_INTENTS[canonical]; }

  /* ══════════════════════════════════════════════════════════════
     STAGE 1 — UNDERSTAND
     Combines the existing regex classifier + AutonomaNLU + (optionally)
     the LLM. Outputs a normalized structured understanding.
     ══════════════════════════════════════════════════════════════ */
  function understand(msg, runtime) {
    runtime = runtime || {};
    var NLU = mod('AutonomaNLU');
    var Core = mod('AutonomaCore');

    // Primary: existing classifier (regex, injected).
    var classified = { intent: 'DEFAULT', confidence: 0, params: {} };
    if (typeof runtime.classify === 'function') {
      try { classified = runtime.classify(msg) || classified; } catch (e) {}
    }

    // Augment entities via the NLU decomposition (additive).
    var entities = Object.assign({}, classified.params);
    var missing = [];
    var decomposed = null;
    if (NLU && typeof NLU.decompose === 'function') {
      try {
        decomposed = NLU.decompose(msg);
        if (decomposed && decomposed.entities) {
          var e = decomposed.entities;
          if (e.amount != null && entities.amount == null) entities.amount = e.amount;
          if (e.token && !entities.token) entities.token = e.token;
          if (e.address && !entities.address) entities.address = e.address;
        }
        if (decomposed && decomposed.missing) {
          missing = decomposed.missing.map(function (m) { return m.field || m.label; });
        }
      } catch (e) {}
    }

    // Extract params from AutonomaCore as a secondary source.
    if (Core && typeof Core.extractParams === 'function') {
      try {
        var cp = Core.extractParams(msg, classified.intent);
        Object.keys(cp || {}).forEach(function (k) {
          if (entities[k] == null && cp[k] != null) entities[k] = cp[k];
        });
      } catch (e) {}
    }

    var c = canonical(classified.intent);
    var write = !isRead(c);

    // Missing-information detection for writes.
    if (write && !missing.length) {
      if ((c === 'send_payment' || c === 'cross_chain' || c === 'mass_payment' || c === 'multisend') && !entities.address && !entities.recipientCount && !(entities.addresses && entities.addresses.length)) {
        missing.push('recipient_address');
      }
      if ((c === 'send_payment' || c === 'swap_execute' || c === 'bridge' || c === 'cross_chain' || c === 'create_schedule') && entities.amount == null) {
        missing.push('amount');
      }
    }

    return {
      intent: classified.intent,
      canonical: c,
      isWrite: write,
      goal: c,
      entities: entities,
      params: entities,
      constraints: [],
      references: detectReferences(msg),
      confidence: classified.confidence || 0,
      missing: missing,
      needsClarification: missing.length > 0,
      decomposed: decomposed
    };
  }

  function detectReferences(msg) {
    var refs = [];
    var low = String(msg || '').toLowerCase();
    if (/\b(it|him|her|them|that wallet|the previous|the last|the same|again|cancel that|make it)\b/i.test(low)) refs.push('contextual');
    if (/\b(half|the remainder|the rest)\b/i.test(low)) refs.push('relative_amount');
    if (/\b(tomorrow|yesterday|today|next week|next month)\b/i.test(low)) refs.push('relative_time');
    return refs;
  }

  /* ══════════════════════════════════════════════════════════════
     STAGE 2 — CONTEXT
     Assembles a compact AgentContext from the existing context providers.
     ══════════════════════════════════════════════════════════════ */
  function buildContext(understanding, runtime) {
    runtime = runtime || {};
    var FC = mod('FinancialContext');
    var AWM = mod('AgentWalletManager');
    var AA = mod('AgentAuthorization');
    var AS = mod('AgentSession');
    var Core = mod('AutonomaCore');

    var ctx = {
      conversation: null,
      user: null,
      wallet: null,
      agentWallet: null,
      financialState: null,
      permissions: null,
      schedules: null,
      recentActivity: null,
      relevantMemory: null,
      network: null,
      currentState: null
    };

    // user wallet
    try {
      if (typeof window !== 'undefined' && window.walletAddress) ctx.user = { address: window.walletAddress };
      if (typeof window !== 'undefined' && window.activeChainId) ctx.network = { chainId: window.activeChainId };
    } catch (e) {}

    // agent wallet
    if (AWM) {
      try { if (typeof AWM.getAgentAddress === 'function') ctx.agentWallet = { address: AWM.getAgentAddress() }; } catch (e) {}
    }

    // financial state / world state
    if (FC && typeof FC.getSnapshot === 'function') {
      try { ctx.financialState = FC.getSnapshot(); } catch (e) {}
    }
    if (Core && typeof Core.getWorldState === 'function') {
      try { ctx.currentState = Core.getWorldState(); } catch (e) {}
    }

    // permissions
    if (AA && typeof AA.getAuthSummary === 'function') {
      try { ctx.permissions = AA.getAuthSummary(); } catch (e) {}
    }

    // conversation / session memory
    if (AS) {
      try {
        if (typeof AS.getConversationContext === 'function') ctx.recentActivity = AS.getConversationContext(5);
        if (typeof AS.getSessionSummary === 'function') ctx.conversation = AS.getSessionSummary();
      } catch (e) {}
    }

    // schedules (only when relevant)
    if (understanding.canonical === 'create_schedule' || understanding.canonical === 'execute_schedules' || understanding.canonical === 'scheduled_permits') {
      try {
        if (typeof window !== 'undefined' && window.ScheduleEngine && typeof window.ScheduleEngine.getAll === 'function') {
          ctx.schedules = window.ScheduleEngine.getAll();
        }
      } catch (e) {}
    }

    return ctx;
  }

  /* ══════════════════════════════════════════════════════════════
     STAGE 3 — PLAN
     Builds a structured, inspectable plan (reusing ExecutionPlanner when
     present). Read intents produce a single read step; write intents produce
     a resolve → balance → execute → verify chain.
     ══════════════════════════════════════════════════════════════ */
  function plan(understanding, context, runtime) {
    runtime = runtime || {};
    var EP = mod('ExecutionPlanner');
    var c = understanding.canonical;
    var e = understanding.entities || {};

    var steps = [];
    if (isRead(c)) {
      steps.push({ id: 'read', tool: 'router.' + c, type: 'read', requiresConfirmation: false });
    } else {
      // Resolve recipient first when a contact name (not address) is present.
      if (e.recipientName || (c === 'send_payment' && !e.address)) {
        steps.push({ id: 'resolve_recipient', tool: 'contacts.resolve', type: 'read', requiresConfirmation: false });
      }
      steps.push({ id: 'check_balance', tool: 'wallet.getBalance', type: 'read', requiresConfirmation: false });
      steps.push({ id: 'check_policy', tool: 'policy.evaluate', type: 'read', requiresConfirmation: false });
      steps.push({ id: 'execute', tool: 'router.' + c, type: 'write', requiresConfirmation: true });
      steps.push({ id: 'verify', tool: 'verify.receipt', type: 'read', requiresConfirmation: false });
    }

    // Risk from the existing RiskEngine (reused, not duplicated).
    var riskLevel = 'LOW';
    try {
      var RE = mod('RiskEngine');
      if (RE && typeof RE.analyze === 'function') {
        var risk = RE.analyze({
          operation: OP_TO_AUTH[c] || c,
          amount: Number(e.amount) || 0,
          asset: e.token || 'USDC',
          network: e.chain || 'Arc Testnet',
          purpose: ''
        });
        if (risk && risk.level) riskLevel = risk.level;
      } else if (!isRead(c) && (Number(e.amount) || 0) > 1000) {
        riskLevel = 'HIGH';
      } else if (!isRead(c) && (Number(e.amount) || 0) > 100) {
        riskLevel = 'MEDIUM';
      }
    } catch (e) {}

    return {
      id: 'plan_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
      goal: c,
      steps: steps,
      riskLevel: riskLevel,
      requiresConfirmation: !isRead(c),
      createdAt: Date.now(),
      source: EP ? 'execution_planner' : 'agent_brain'
    };
  }

  /* ══════════════════════════════════════════════════════════════
     STAGE 4 — POLICY
     Reuses AgentAuthorization + PolicyEngine + RiskEngine. Never bypasses.
     ══════════════════════════════════════════════════════════════ */
  function evaluatePolicy(plan, understanding, context, runtime) {
    var c = understanding.canonical;
    var e = understanding.entities || {};

    if (isRead(c)) {
      return { allowed: true, riskLevel: plan.riskLevel, requiresConfirmation: false, reasons: [] };
    }

    var reasons = [];
    var AA = mod('AgentAuthorization');
    var PE = mod('PolicyEngine');

    // 1. Authorization (existing engine).
    var op = OP_TO_AUTH[c] || c;
    if (AA) {
      try {
        var authorized = (typeof AA.hasOperationAuth === 'function') ? AA.hasOperationAuth(op) : false;
        if (!authorized) {
          return { allowed: false, riskLevel: plan.riskLevel, requiresConfirmation: false, reasons: ['No active agent authorization for "' + op + '"'], needsAuthorization: true };
        }
        if (typeof AA.validateExecution === 'function') {
          var v = AA.validateExecution({ operation: op, amount: Number(e.amount) || 0, asset: e.token || 'USDC', network: e.chain || 'Arc Testnet', destination: e.address || '' });
          if (v && !v.valid) {
            return { allowed: false, riskLevel: plan.riskLevel, requiresConfirmation: false, reasons: [v.reason || 'Authorization scope denied'] };
          }
        }
      } catch (e) {}
    } else {
      reasons.push('AgentAuthorization unavailable (fallback to manual confirmation)');
    }

    // 2. Policy engine (existing).
    if (PE) {
      try {
        if (typeof PE.quickCheck === 'function') {
          var pc = PE.quickCheck(op, Number(e.amount) || 0, e.token || 'USDC', e.chain || 'Arc Testnet');
          if (pc && pc.valid === false) {
            var failed = (pc.failedRules || []).map(function (r) { return r.rule + (r.reason ? ': ' + r.reason : ''); });
            return { allowed: false, riskLevel: plan.riskLevel, requiresConfirmation: false, reasons: failed.length ? failed : ['Policy check failed'] };
          }
        }
      } catch (e) {}
    }

    // 3. Risk gate.
    var order = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
    var maxRisk = 'MEDIUM';
    try {
      if (AA && typeof AA.getAuthSummary === 'function') {
        // conservative default; existing maxRiskLevel is per-authorization
      }
    } catch (e) {}
    if (order[plan.riskLevel] > order[maxRisk]) {
      return { allowed: false, riskLevel: plan.riskLevel, requiresConfirmation: false, reasons: ['Risk ' + plan.riskLevel + ' exceeds accepted maximum ' + maxRisk] };
    }

    // High risk writes always need explicit confirmation unless autonomous.
    var requiresConfirmation = plan.riskLevel === 'HIGH' || plan.riskLevel === 'CRITICAL' || plan.requiresConfirmation;

    return { allowed: true, riskLevel: plan.riskLevel, requiresConfirmation: requiresConfirmation, reasons: reasons };
  }

  /* ══════════════════════════════════════════════════════════════
     STAGE 5 — EXECUTE
     Routes through the existing intent router (runtime.executeIntent).
     Wrapped in idempotency: the same planId+stepId is only executed once.
     ══════════════════════════════════════════════════════════════ */
  function isStepExecuted(planId, stepId) {
    var done = localGet(EXECUTED_KEY) || {};
    return !!done[planId + '::' + stepId];
  }
  function markStepExecuted(planId, stepId) {
    var done = localGet(EXECUTED_KEY) || {};
    done[planId + '::' + stepId] = Date.now();
    // prune old entries
    var keys = Object.keys(done);
    if (keys.length > 200) {
      keys.sort(function (a, b) { return done[a] - done[b]; });
      for (var i = 0; i < keys.length - 200; i++) delete done[keys[i]];
    }
    localSet(EXECUTED_KEY, done);
  }

  async function execute(plan, understanding, context, runtime) {
    runtime = runtime || {};
    var execId = uid('exec');
    var writeStep = null;
    for (var i = 0; i < plan.steps.length; i++) {
      if (plan.steps[i].type === 'write') { writeStep = plan.steps[i]; break; }
    }

    var out = { executionId: execId, planId: plan.id, stepId: writeStep ? writeStep.id : 'read', ok: false, html: null, deduplicated: false };

    if (writeStep && isStepExecuted(plan.id, writeStep.id)) {
      out.deduplicated = true;
      out.ok = true;
      out.status = 'duplicate_blocked';
      return out;
    }

    if (typeof runtime.executeIntent !== 'function') {
      out.status = 'no_router';
      return out;
    }

    try {
      var html = await runtime.executeIntent(understanding.intent, understanding.params, runtime.msg || '');
      out.html = html;
      out.ok = html != null;
      out.status = out.ok ? 'executed' : 'failed';
      if (writeStep) markStepExecuted(plan.id, writeStep.id);
    } catch (e) {
      out.ok = false;
      out.status = 'error';
      out.error = classifyError(e);
    }
    return out;
  }

  function classifyError(err) {
    var m = (err && (err.shortMessage || err.message)) ? String(err.shortMessage || err.message) : String(err || '');
    if (/insufficient|funds|balance/i.test(m)) return { type: 'insufficient_funds', retry: false, message: m };
    if (/user rejected|denied|reject/i.test(m)) return { type: 'user_rejected', retry: false, message: m };
    if (/nonce|already known|replacement/i.test(m)) return { type: 'nonce_conflict', retry: false, message: m };
    if (/timeout|timed out|network|fetch|ENOTFOUND|ECONN/i.test(m)) return { type: 'network', retry: true, message: m };
    if (/revert|execution reverted|INVALID_ARGUMENT|unknown function/i.test(m)) return { type: 'contract', retry: false, message: m };
    if (/unauthorized|not authorized|permission|forbidden/i.test(m)) return { type: 'authorization', retry: false, message: m };
    return { type: 'unknown', retry: false, message: m };
  }

  /* ══════════════════════════════════════════════════════════════
     STAGE 6 — VERIFY
     For writes, inspects the latest audit/execution record to determine the
     REAL on-chain status (never converts pending → confirmed).
     ══════════════════════════════════════════════════════════════ */
  function verify(execution, understanding, runtime) {
    var c = understanding.canonical;

    if (isRead(c)) {
      return { status: 'confirmed', transactionHash: null, effects: null, note: 'read_only' };
    }

    if (execution.deduplicated) {
      return { status: 'unknown', transactionHash: null, effects: null, note: 'duplicate_blocked' };
    }

    if (!execution.ok) {
      var err = execution.error || {};
      return { status: 'failed', transactionHash: null, effects: null, note: err.message || 'Execution failed', classification: err.type };
    }

    // Look at the latest record from the existing audit trail.
    var AA = mod('AgentAudit');
    var rec = null;
    if (AA && typeof AA.getRecords === 'function') {
      try { rec = (AA.getRecords(1) || [])[0] || null; } catch (e) {}
    }
    if (!rec && typeof window !== 'undefined' && window.ExecutionHistory && typeof window.ExecutionHistory.getRecords === 'function') {
      try { rec = (window.ExecutionHistory.getRecords(1) || [])[0] || null; } catch (e) {}
    }

    if (rec) {
      var tx = rec.transactionHash || rec.txHash || null;
      var result = rec.result || '';
      if (result === 'success') return { status: 'confirmed', transactionHash: tx, chainId: 5042002, effects: effects(understanding) };
      if (result === 'failed' || result === 'reverted') return { status: 'failed', transactionHash: tx, chainId: 5042002, effects: effects(understanding) };
      if (result === 'pre_validated' || result === 'submitted') return { status: 'pending', transactionHash: tx, chainId: 5042002, effects: effects(understanding) };
      return { status: 'pending', transactionHash: tx, chainId: 5042002, effects: effects(understanding) };
    }

    // No record → the router may have only routed (not broadcast). Treat as pending.
    return { status: 'pending', transactionHash: null, effects: effects(understanding) };
  }

  function effects(understanding) {
    var e = understanding.entities || {};
    return {
      token: e.token || 'USDC',
      amount: e.amount != null ? String(e.amount) : null,
      recipient: e.address || null
    };
  }

  /* ══════════════════════════════════════════════════════════════
     STAGE 7 — REMEMBER
     Persists useful information via existing memory (never secrets).
     ══════════════════════════════════════════════════════════════ */
  function remember(understanding, verification, runtime) {
    var AS = mod('AgentSession');
    var Core = mod('AutonomaCore');

    // 1. Conversation context (existing session memory).
    if (AS && typeof AS.addConversationContext === 'function') {
      try { AS.addConversationContext(understanding.canonical + (verification.transactionHash ? ' :: ' + verification.transactionHash : '')); } catch (e) {}
    }
    if (Core && typeof Core.addToHistory === 'function') {
      try { Core.addToHistory(understanding.canonical); } catch (e) {}
    }

    // 2. Entity memory: name → address (via existing RecipientResolver).
    var e = understanding.entities || {};
    if (e.address && e.recipientName && typeof runtime.rememberEntity === 'function') {
      try {
        runtime.rememberEntity(e.recipientName, e.address);
      } catch (err) {}
    }
  }

  /* ══════════════════════════════════════════════════════════════
     STAGE 8 — RESPOND
     ══════════════════════════════════════════════════════════════ */
  function respond(verification, understanding, execution, runtime) {
    runtime = runtime || {};
    var render = runtime.render || null;
    var e = understanding.entities || {};

    if (execution && execution.html != null && verification.status === 'confirmed') {
      return execution.html;
    }

    // For writes, produce an honest status message reflecting real state.
    if (understanding.isWrite) {
      var statusText = {
        confirmed: 'confirmed on Arc Testnet',
        pending: 'submitted and pending confirmation',
        failed: 'failed',
        reverted: 'reverted on-chain',
        unknown: 'not confirmed'
      }[verification.status] || verification.status;

      var body = '<strong>' + (e.amount != null ? e.amount + ' ' : '') + (e.token || 'USDC') + '</strong> ' +
        (e.address ? 'to <code>' + String(e.address).slice(0, 8) + '...</code> ' : '') +
        '— ' + statusText + '.';
      if (verification.transactionHash) {
        body += '<br>Tx: <code>' + String(verification.transactionHash).slice(0, 14) + '...</code>';
      }
      if (verification.note && verification.status === 'failed') body += '<br>' + escapeHtml(verification.note);

      if (render && typeof render.intro === 'function') {
        return render.intro(body);
      }
      return body;
    }

    // Read intents fall through to the router HTML (execution.html).
    return execution && execution.html != null ? execution.html : '';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ══════════════════════════════════════════════════════════════
     MAIN ORCHESTRATION — the canonical agent loop
     ══════════════════════════════════════════════════════════════ */
  async function run(msg, runtime) {
    runtime = runtime || {};
    var runId = uid('brain');
    var stages = [];
    function stage(name, fn) {
      var t0 = now();
      var ok = false, result = null, err = null;
      try { result = fn(); ok = true; } catch (e) { err = e; }
      stages.push({ stage: name, durationMs: Math.round(now() - t0), success: ok, error: err ? String(err.message || err) : null });
      if (!ok) throw err;
      return result;
    }
    function log() {
      try {
        if (typeof runtime.log === 'function') runtime.log(runId, stages);
        else if (typeof console !== 'undefined' && console.log) console.log('[AgentBrain]', runId, JSON.stringify(stages));
      } catch (e) {}
    }

    try {
      // 1. UNDERSTAND
      var understanding = stage('understand', function () { return understand(msg, runtime); });

      // 2. CONTEXT
      var context = stage('context', function () { return buildContext(understanding, runtime); });

      // 3. PLAN
      var planObj = stage('plan', function () { return plan(understanding, context, runtime); });

      // Contextual reference update: "make it 75" updates the pending confirmation
      // amount instead of creating an unrelated operation.
      if (understanding.references.indexOf('contextual') !== -1 && _lastPending && _lastPending.understanding && _lastPending.understanding.isWrite) {
        var _newAmt = understanding.entities && understanding.entities.amount;
        if (_newAmt != null) {
          _lastPending.understanding.entities.amount = _newAmt;
          _lastPending.understanding.params.amount = _newAmt;
          var _ctx2 = buildContext(_lastPending.understanding, _lastPending.runtime);
          var _pol2 = evaluatePolicy(_lastPending.plan, _lastPending.understanding, _ctx2, _lastPending.runtime);
          _lastPending.plan.policy = _pol2;
          var _conf2 = buildConfirmation(_lastPending.plan, _lastPending.understanding, _pol2, _lastPending.runtime);
          log();
          return { handled: true, type: 'confirmation_required', updated: true, understanding: _lastPending.understanding, plan: _lastPending.plan, policy: _pol2, confirmation: _conf2, html: _conf2.html };
        }
      }

      // Clarification gate (missing info before any action).
      if (understanding.needsClarification) {
        log();
        return { handled: true, type: 'clarification', understanding: understanding, plan: planObj, missing: understanding.missing, html: buildClarification(understanding, runtime) };
      }

      // 4. POLICY
      var policy = stage('policy', function () { return evaluatePolicy(planObj, understanding, context, runtime); });
      planObj.policy = policy;
      if (!policy.allowed) {
        log();
        return { handled: true, type: 'blocked', understanding: understanding, plan: planObj, policy: policy, html: buildBlocked(policy, understanding, runtime) };
      }

      // 5. EXECUTE (or confirmation gate for high-risk writes)
      if (understanding.isWrite && policy.requiresConfirmation && runtime.autoConfirm !== true) {
        var confirmation = buildConfirmation(planObj, understanding, policy, runtime);
        log();
        return { handled: true, type: 'confirmation_required', understanding: understanding, plan: planObj, policy: policy, confirmation: confirmation, html: confirmation.html };
      }

      var execution = await stage('execute', function () { return execute(planObj, understanding, context, runtime); });

      // No tool router available → the Brain cannot orchestrate execution.
      // Fall through so the existing pipeline handles the request.
      if (execution && execution.status === 'no_router') {
        log();
        return { handled: false, reason: 'no_router' };
      }

      // 6. VERIFY
      var verification = stage('verify', function () { return verify(execution, understanding, runtime); });

      // 7. REMEMBER
      stage('remember', function () { return remember(understanding, verification, runtime); });

      // 8. RESPOND
      var html = stage('respond', function () { return respond(verification, understanding, execution, runtime); });

      log();
      return { handled: true, type: 'response', understanding: understanding, plan: planObj, policy: policy, execution: execution, verification: verification, html: html };
    } catch (e) {
      log();
      return { handled: false, error: e };
    }
  }

  /* ── Confirmation / clarification builders ─────────────────── */
  function buildClarification(understanding, runtime) {
    var render = runtime.render || null;
    var missing = understanding.missing || [];
    var label = understanding.canonical.replace(/_/g, ' ');
    if (render && typeof render.intro === 'function') {
      var html = render.intro('I understood you want to <strong>' + escapeHtml(label) + '</strong>, but I need a bit more info.');
      if (render.card) {
        html += render.card(
          render.head('question', 'Missing Information', { text: missing.length + ' needed', cls: 'pending' }),
          missing.map(function (m) { return render.row(m, 'Please provide the ' + escapeHtml(m), 'yellow'); }).join('')
        );
      }
      return html;
    }
    return 'Please provide: ' + missing.join(', ');
  }

  function buildBlocked(policy, understanding, runtime) {
    var render = runtime.render || null;
    var reason = (policy.reasons && policy.reasons[0]) || 'Policy blocked this action';
    if (render && typeof render.intro === 'function') {
      return render.intro('I cannot do that: <strong style="color:#ef4444">' + escapeHtml(reason) + '</strong>.');
    }
    return reason;
  }

  function buildConfirmation(planObj, understanding, policy, runtime) {
    var render = runtime.render || null;
    var e = understanding.entities || {};
    var confirmation = {
      type: 'confirmation_required',
      action: understanding.canonical,
      summary: {
        amount: (e.amount != null ? e.amount + ' ' : '') + (e.token || 'USDC'),
        recipient: e.address || '(resolved)',
        network: e.chain || 'Arc Testnet'
      },
      riskLevel: planObj.riskLevel,
      expiresAt: Date.now() + 5 * 60 * 1000
    };

    // Persist pending plan for the confirm() path.
    var pending = localGet(PENDING_KEY) || {};
    pending[planObj.id] = { plan: planObj, understanding: understanding, runtime: runtime, msg: runtime.msg, createdAt: Date.now() };
    localSet(PENDING_KEY, pending);
    _lastPending = pending[planObj.id];

    var html = '';
    if (render && typeof render.intro === 'function') {
      html = render.intro('Ready to <strong>' + escapeHtml(understanding.canonical.replace(/_/g, ' ')) + '</strong> ' +
        escapeHtml(confirmation.summary.amount) + (e.address ? ' to <code>' + escapeHtml(String(e.address).slice(0, 8) + '...') + '</code>' : '') + ' on ' + escapeHtml(confirmation.summary.network) + '.') +
        (render.actions
          ? render.actions(
              { icon: 'check', label: 'Confirm', cls: 'primary', action: "AutonomaAgentBrain.confirm('" + planObj.id + "')" },
              { icon: 'x', label: 'Cancel', cls: 'danger', action: "AutonomaAgentBrain.cancel('" + planObj.id + "')" }
            )
          : '');
    } else {
      html = 'Confirm ' + understanding.canonical + '? amount=' + confirmation.summary.amount + ' recipient=' + confirmation.summary.recipient;
    }
    confirmation.html = html;
    return confirmation;
  }

  /* ── Confirmation resolution (public) ──────────────────────── */
  async function confirm(planId) {
    var pending = localGet(PENDING_KEY) || {};
    var entry = pending[planId];
    if (!entry) return { ok: false, reason: 'plan_not_found' };
    delete pending[planId];
    localSet(PENDING_KEY, pending);
    try {
      var res = await execute(entry.plan, entry.understanding, {}, entry.runtime);
      var verification = verify(res, entry.understanding, entry.runtime);
      remember(entry.understanding, verification, entry.runtime);
      return { ok: true, execution: res, verification: verification, html: respond(verification, entry.understanding, res, entry.runtime) };
    } catch (e) {
      return { ok: false, error: e };
    }
  }

  function cancel(planId) {
    var pending = localGet(PENDING_KEY) || {};
    delete pending[planId];
    localSet(PENDING_KEY, pending);
    return true;
  }

  /* ══════════════════════════════════════════════════════════════
     PUBLIC API
     ══════════════════════════════════════════════════════════════ */
  window.AutonomaAgentBrain = {
    VERSION: VERSION,
    isEnabled: isEnabled,
    run: run,
    confirm: confirm,
    cancel: cancel,
    // Individual stages (exposed for testing / incremental integration)
    understand: understand,
    buildContext: buildContext,
    plan: plan,
    evaluatePolicy: evaluatePolicy,
    execute: execute,
    verify: verify,
    remember: remember,
    respond: respond,
    // classification helpers
    canonical: canonical,
    isRead: isRead,
    READ_INTENTS: READ_INTENTS,
    OP_TO_AUTH: OP_TO_AUTH
  };
})();
