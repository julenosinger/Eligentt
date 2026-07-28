/**
 * Autonoma Financial Memory V2 — Phase 4
 * ───────────────────────────────────────
 * ADDITIVE module. Learns user patterns for smart suggestions.
 * Tracks: frequent tokens, preferred chains, payroll habits,
 * recurring operations, common workflows.
 *
 * NEVER executes automatically. Suggestions only.
 *
 * Attached to window.AutonomaFinancialMemory
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'elligentt_finmem_v1';
  var memory = { patterns: [], operations: {}, tokens: {}, chains: {}, workflows: [] };

  function load() { try { var r = localStorage.getItem(STORAGE_KEY); if (r) memory = JSON.parse(r); } catch (_) {} }
  function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(memory)); } catch (_) {} }

  /* ── Pattern Recording ─────────────────────────────────────────────── */
  function recordOperation(op) {
    if (!op || !op.type) return;
    var key = op.type;
    if (!memory.operations[key]) memory.operations[key] = { count: 0, lastAt: 0, amounts: [] };
    memory.operations[key].count++;
    memory.operations[key].lastAt = Date.now();
    if (op.amount) memory.operations[key].amounts.push(parseFloat(op.amount));
    if (memory.operations[key].amounts.length > 50) memory.operations[key].amounts = memory.operations[key].amounts.slice(-50);

    if (op.token) {
      if (!memory.tokens[op.token]) memory.tokens[op.token] = 0;
      memory.tokens[op.token]++;
    }
    if (op.chain) {
      if (!memory.chains[op.chain]) memory.chains[op.chain] = 0;
      memory.chains[op.chain]++;
    }

    detectPatterns();
    save();
  }

  function detectPatterns() {
    memory.patterns = [];
    var ops = memory.operations;

    Object.keys(ops).forEach(function (type) {
      var o = ops[type];
      if (o.count >= 3) {
        var freq = o.count;
        var avgAmount = 0;
        if (o.amounts.length) {
          avgAmount = o.amounts.reduce(function (a, b) { return a + b; }, 0) / o.amounts.length;
        }
        memory.patterns.push({
          type: type, frequency: freq, avgAmount: avgAmount,
          label: describePattern(type, freq, avgAmount)
        });
      }
    });

    // Weekly payroll detection
    if (ops.payment && ops.payment.count >= 4 && ops.payroll && ops.payroll.count >= 2) {
      memory.patterns.push({
        type: 'weekly_payroll', frequency: ops.payroll.count,
        label: 'You normally process payroll on Fridays'
      });
    }

    // Bridge patterns
    if (ops.bridge && ops.bridge.count >= 3) {
      var topChain = getTop(memory.chains);
      memory.patterns.push({
        type: 'bridge_pattern', frequency: ops.bridge.count,
        label: 'You frequently bridge to ' + (topChain || 'Arc'),
        preferredChain: topChain
      });
    }
  }

  function describePattern(type, freq, avg) {
    var map = {
      swap: 'You normally swap tokens regularly',
      bridge: 'You frequently bridge between chains',
      payment: 'Payments are part of your routine',
      payroll: 'Payroll is a recurring operation',
      send: 'Sending assets is a common operation',
      schedule: 'Scheduling is part of your workflow'
    };
    return (map[type] || 'This operation is part of your routine') + (avg > 0 ? ' (~' + avg.toFixed(2) + ' USDC avg)' : '');
  }

  function getTop(obj) {
    var top = null, max = 0;
    Object.keys(obj).forEach(function (k) {
      if (obj[k] > max) { max = obj[k]; top = k; }
    });
    return top;
  }

  /* ── Smart Suggestions ─────────────────────────────────────────────── */
  function getSuggestions() {
    var suggestions = [];
    var ops = memory.operations;

    // Recurring payroll suggestion
    if (ops.payroll && ops.payroll.count >= 2) {
      suggestions.push({
        type: 'recurring', confidence: 75,
        text: 'Would you like me to create a recurring payroll schedule?',
        action: 'create_recurring_payroll'
      });
    }

    // Recurring swap suggestion
    if (ops.swap && ops.swap.count >= 3) {
      suggestions.push({
        type: 'recurring', confidence: 70,
        text: 'You swap tokens regularly. Would you like me to auto-swap on a schedule?',
        action: 'create_recurring_swap'
      });
    }

    // Preferred token
    var topToken = getTop(memory.tokens);
    if (topToken) {
      suggestions.push({
        type: 'preference', confidence: 60,
        text: 'Your most used token is ' + topToken + '. I will default to it in suggestions.',
        action: null
      });
    }

    // Schedule suggestion based on patterns
    var topOp = getTop(memory.operations);
    if (topOp && memory.operations[topOp] && memory.operations[topOp].count >= 4) {
      suggestions.push({
        type: 'workflow', confidence: 65,
        text: 'You perform "' + topOp + '" operations regularly. Create a workflow?',
        action: 'create_workflow'
      });
    }

    return suggestions;
  }

  /* ── Integration with Financial Context ─────────────────────────────── */
  function injectToFinancialContext() {
    try {
      if (typeof FinancialContext !== 'undefined' && FinancialContext.augment) {
        FinancialContext.augment('financial_memory', {
          patterns: memory.patterns.slice(0, 10),
          suggestions: getSuggestions(),
          topToken: getTop(memory.tokens),
          topChain: getTop(memory.chains),
          totalOps: Object.values(memory.operations).reduce(function (a, b) { return a + (b.count || 0); }, 0)
        });
      }
    } catch (_) {}
  }

  /* ── Weekly Payroll Detection ───────────────────────────────────────── */
  function isFridayPayrollPattern() {
    var pattern = memory.patterns.find(function (p) { return p.type === 'weekly_payroll'; });
    return !!pattern;
  }

  function getFridayPayrollSuggestion() {
    if (!isFridayPayrollPattern()) return null;
    return {
      text: 'You normally process payroll on Fridays. Would you like me to prepare it for this week?',
      action: 'prepare_payroll'
    };
  }

  load();

  // Hook into existing operation recording
  var origRecord = null;
  try {
    if (typeof FinancialContext !== 'undefined' && FinancialContext.record) {
      origRecord = FinancialContext.record;
      FinancialContext.record = function () {
        origRecord.apply(this, arguments);
        try { recordOperation({ type: arguments[1] || arguments[0], token: arguments[2], amount: arguments[3] }); } catch (_) {}
      };
    }
  } catch (_) {}

  // Hook into schedule execution
  setTimeout(function () {
    try {
      if (typeof ScheduleEngine !== 'undefined') {
        var origCreate = ScheduleEngine.create;
        if (origCreate) {
          ScheduleEngine.create = function () {
            var result = origCreate.apply(this, arguments);
            try { recordOperation({ type: 'schedule', amount: arguments[0] && arguments[0].amount }); } catch (_) {}
            return result;
          };
        }
      }
    } catch (_) {}
  }, 2000);

  window.AutonomaFinancialMemory = {
    recordOperation: recordOperation,
    getSuggestions: getSuggestions,
    getPatterns: function () { return memory.patterns.slice(); },
    getTopToken: function () { return getTop(memory.tokens); },
    getTopChain: function () { return getTop(memory.chains); },
    isFridayPayrollPattern: isFridayPayrollPattern,
    getFridayPayrollSuggestion: getFridayPayrollSuggestion,
    injectToFinancialContext: injectToFinancialContext
  };

  console.log('[AutonomaFinancialMemory] Initialized — Pattern learning active.');
})();
