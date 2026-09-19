/**
 * Autonoma Financial Planner V2 — Phase 1
 * ───────────────────────────────────────
 * ADDITIVE module. Adds financial planning intelligence to Autonoma.
 * Reuses FinancialContext, AgentWalletManager, ScheduleEngine, TreasuryVault.
 * NEVER executes automatically — always requires user approval.
 *
 * Attached to window.AutonomaFinancialPlanner
 */
(function () {
  'use strict';

  var plans = {};
  var STORAGE_KEY = 'elligentt_finplans_v1';

  function load() { try { var r = localStorage.getItem(STORAGE_KEY); if (r) plans = JSON.parse(r); } catch (_) { plans = {}; } }
  function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(plans)); } catch (_) {} }

  var PLAN_TYPES = {
    ALLOCATION: 'allocation',
    PAYROLL: 'payroll',
    RESERVE: 'reserve',
    SCHEDULE: 'schedule',
    BRIDGE: 'bridge',
    SWAP: 'swap',
    WORKFLOW: 'workflow',
    TREASURY: 'treasury'
  };

  var _nextId = function () { return 'FP-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6); };

  /* ── Natural Language Understanding ───────────────────────────────── */
  function understand(msg) {
    var lower = (msg || '').toLowerCase();
    var result = { type: null, params: {}, explanation: '', confidence: 0 };

    // Allocation patterns
    var alloc = lower.match(/(?:separate|reserve|allocate|set aside|save|keep|separe|reserve|alocar|guardar|mantenha?)\s+(\d+(?:\.\d+)?)\s*(usdc|eurc|cirbtc|eth)?/i);
    if (alloc) {
      result.type = PLAN_TYPES.ALLOCATION;
      result.params.amount = parseFloat(alloc[1]);
      result.params.token = (alloc[2] || 'USDC').toUpperCase();
      result.explanation = 'Allocate ' + result.params.amount + ' ' + result.params.token;
      result.confidence = 85;
    }

    // Payroll patterns
    var payroll = lower.match(/(?:payroll|folha|pay\s+(?:my\s+)?team|pay\s+employees|pagar?\s+(?:minha\s+)?equipe|pagar?\s+funcion[a-z]+)/i);
    if (payroll) {
      result.type = PLAN_TYPES.PAYROLL;
      result.explanation = 'Create payroll plan';
      result.confidence = 80;
    }

    // Reserve/minimum patterns
    var reserve = lower.match(/(?:never\s+allow|don't\s+let|keep\s+(?:at\s+least|minimum)|n[uã]o\s+deixe|mantenha?\s+(?:pelo\s+menos|m[ií]nimo))\s+.*?(\d+(?:\.\d+)?)\s*(usdc|eurc|cirbtc)?/i);
    if (reserve) {
      result.type = PLAN_TYPES.RESERVE;
      result.params.amount = parseFloat(reserve[1]);
      result.params.token = (reserve[2] || 'USDC').toUpperCase();
      result.explanation = 'Maintain minimum balance of ' + result.params.amount + ' ' + result.params.token;
      result.confidence = 82;
    }

    // Percentage allocation
    var pct = lower.match(/(?:separate|reserve|allocate|separe|reserve|alocar)\s+(\d+)\s*%\s*(?:of\s+(?:every|each|all)\s+)?(?:payment|receiv|income|pagamento|receb|renda)/i);
    if (pct) {
      result.type = PLAN_TYPES.ALLOCATION;
      result.params.percentage = parseInt(pct[1]);
      result.params.target = 'treasury';
      result.explanation = 'Allocate ' + result.params.percentage + '% of all payments to Treasury';
      result.confidence = 88;
    }

    // Treasury movement
    var treasury = lower.match(/(?:move|send|transfer|bridge|enviar|mover|transferir)\s+(?:excess|idle|extra|excedente|parado)\s+(?:funds|balance|money)?\s*(?:to|for|para)\s*(?:treasury|vault)/i);
    if (treasury) {
      result.type = PLAN_TYPES.TREASURY;
      result.params.action = 'move_excess';
      result.explanation = 'Move excess funds to Treasury Vault';
      result.confidence = 75;
    }

    return result;
  }

  /* ── Plan Builder ─────────────────────────────────────────────────── */
  function buildPlan(msg) {
    var understanding = understand(msg);
    if (!understanding.type) return null;

    var plan = {
      id: _nextId(),
      type: understanding.type,
      status: 'draft',
      understanding: msg,
      explanation: understanding.explanation,
      params: understanding.params,
      confidence: understanding.confidence,
      estimatedCost: estimateCost(understanding),
      executionSteps: buildSteps(understanding),
      approvalsRequired: ['user'],
      createdAt: Date.now(),
      executedAt: null
    };

    plans[plan.id] = plan;
    save();
    return plan;
  }

  function estimateCost(u) {
    var est = { gas: '~0.001 USDC', fee: '0', total: '~0.001' };
    if (u.type === PLAN_TYPES.BRIDGE) est = { gas: '~0.002 USDC', fee: '0.1%', total: '~0.002 + fee' };
    if (u.type === PLAN_TYPES.SWAP) est = { gas: '~0.001 USDC', fee: '0.1%', total: '~0.001 + 0.1%' };
    return est;
  }

  function buildSteps(u) {
    switch (u.type) {
      case PLAN_TYPES.ALLOCATION:
        return [
          { step: 1, label: 'Check current balance', action: 'check_balance' },
          { step: 2, label: 'Calculate allocation amount', action: 'calculate' },
          { step: 3, label: 'Transfer to Treasury Vault', action: 'transfer', requiresApproval: true },
          { step: 4, label: 'Log allocation in ledger', action: 'log' }
        ];
      case PLAN_TYPES.PAYROLL:
        return [
          { step: 1, label: 'Review recipients', action: 'review' },
          { step: 2, label: 'Verify sufficient balance', action: 'check_balance' },
          { step: 3, label: 'Create schedule', action: 'schedule' },
          { step: 4, label: 'Set execution date', action: 'set_date' },
          { step: 5, label: 'Approve payroll', action: 'approve', requiresApproval: true }
        ];
      case PLAN_TYPES.RESERVE:
        return [
          { step: 1, label: 'Set minimum balance threshold', action: 'set_threshold' },
          { step: 2, label: 'Enable balance monitoring', action: 'monitor' },
          { step: 3, label: 'Configure auto-alert on breach', action: 'alert' }
        ];
      case PLAN_TYPES.TREASURY:
        return [
          { step: 1, label: 'Detect idle funds', action: 'detect' },
          { step: 2, label: 'Calculate optimal transfer', action: 'calculate' },
          { step: 3, label: 'Bridge to Arc if needed', action: 'bridge' },
          { step: 4, label: 'Deposit to Treasury Vault', action: 'deposit', requiresApproval: true }
        ];
      default:
        return [{ step: 1, label: 'Review plan', action: 'review' }];
    }
  }

  /* ── Plan to Schedule Conversion ───────────────────────────────────── */
  function convertToSchedule(planId) {
    var plan = plans[planId];
    if (!plan) return null;

    var scheduleOpts = {
      name: plan.explanation,
      type: mapPlanToScheduleType(plan.type),
      amount: plan.params.amount || 0,
      token: plan.params.token || 'USDC',
      chain: 'Arc_Testnet',
      recurrence: null,
      firstExecution: null,
      metadata: { planId: plan.id }
    };

    if (typeof ScheduleEngine !== 'undefined') {
      var sched = ScheduleEngine.create(scheduleOpts);
      plan.scheduleId = sched.id;
      plan.status = 'scheduled';
      save();
      return sched;
    }
    return scheduleOpts;
  }

  function mapPlanToScheduleType(type) {
    var map = {};
    map[PLAN_TYPES.ALLOCATION] = 'payment';
    map[PLAN_TYPES.PAYROLL] = 'payment';
    map[PLAN_TYPES.SCHEDULE] = 'payment';
    map[PLAN_TYPES.TREASURY] = 'bridge';
    return map[type] || 'payment';
  }

  /* ── Approval Card Generator ───────────────────────────────────────── */
  function getApprovalCard(plan, R) {
    if (!R || typeof R.card !== 'function') return '<div>' + plan.explanation + '</div>';
    var o = '';
    o += R.section('Financial Plan', 'ti ti-calculator');
    o += R.row('Type', plan.explanation);
    o += R.row('Confidence', plan.confidence + '%');
    if (plan.params.amount) o += R.row('Amount', plan.params.amount + ' ' + (plan.params.token || 'USDC'));
    if (plan.params.percentage) o += R.row('Allocation', plan.params.percentage + '% to Treasury');
    o += R.section('Estimated Cost');
    o += R.row('Gas', plan.estimatedCost.gas);
    o += R.row('Fee', plan.estimatedCost.fee);
    o += R.section('Execution Steps');
    (plan.executionSteps || []).forEach(function (s) {
      o += R.row('Step ' + s.step, s.label + (s.requiresApproval ? ' (requires approval)' : ''));
    });
    o += R.section('Approvals Required');
    o += R.row('Status', 'Awaiting your confirmation');
    o += R.actions([
      { label: 'Approve Plan', cls: 'primary', onclick: 'AutonomaFinancialPlanner.approve(\'' + plan.id + '\')' },
      { label: 'Modify', cls: '', onclick: 'AutonomaFinancialPlanner.showModify(\'' + plan.id + '\')' },
      { label: 'Cancel', cls: '', onclick: 'AutonomaFinancialPlanner.cancel(\'' + plan.id + '\')' }
    ]);
    return R.card(o, 'Financial Plan', 'teal');
  }

  /* ── Plan Lifecycle ────────────────────────────────────────────────── */
  function approve(planId) {
    var plan = plans[planId];
    if (!plan) return;
    plan.status = 'approved';
    save();
    convertToSchedule(planId);
    try {
      if (typeof toast === 'function') toast('Plan approved: ' + plan.explanation, 'success');
      if (typeof FinancialContext !== 'undefined' && FinancialContext.record) {
        FinancialContext.record('planner', 'approved', { id: planId, type: plan.type });
      }
    } catch (_) {}
  }

  function cancel(planId) {
    var plan = plans[planId];
    if (!plan) return;
    plan.status = 'cancelled';
    save();
    try { if (typeof toast === 'function') toast('Plan cancelled', 'info'); } catch (_) {}
  }

  function showModify(planId) {
    try { if (typeof toast === 'function') toast('Describe how you want to modify this plan', 'info'); } catch (_) {}
  }

  function getDrafts() {
    return Object.values(plans).filter(function (p) { return p.status === 'draft'; });
  }

  function getActive() {
    return Object.values(plans).filter(function (p) { return p.status === 'approved' || p.status === 'scheduled'; });
  }

  /* ── Financial OS Integration ──────────────────────────────────────── */
  function getFinancialContext() {
    var ctx = { allocations: [], reserves: [], payrolls: [], warnings: [] };
    try {
      if (typeof FinancialContext !== 'undefined') {
        var fc = FinancialContext.getSnapshot ? FinancialContext.getSnapshot() : {};
        ctx.portfolio = fc.portfolio;
        ctx.schedules = fc.schedules;
      }
    } catch (_) {}
    var active = getActive();
    active.forEach(function (p) {
      if (p.type === PLAN_TYPES.ALLOCATION) ctx.allocations.push(p);
      if (p.type === PLAN_TYPES.RESERVE) ctx.reserves.push(p);
      if (p.type === PLAN_TYPES.PAYROLL) ctx.payrolls.push(p);
    });
    return ctx;
  }

  load();

  window.AutonomaFinancialPlanner = {
    understand: understand,
    buildPlan: buildPlan,
    approve: approve,
    cancel: cancel,
    showModify: showModify,
    convertToSchedule: convertToSchedule,
    getApprovalCard: getApprovalCard,
    getDrafts: getDrafts,
    getActive: getActive,
    getFinancialContext: getFinancialContext,
    PLAN_TYPES: PLAN_TYPES,
    estimateCost: estimateCost,
    plans: plans
  };

  console.log('[AutonomaFinancialPlanner] Initialized — Financial Planning Layer active.');
})();
