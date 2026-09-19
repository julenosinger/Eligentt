/**
 * AUTONOMA AGENT BRAIN — orchestration layer tests
 * ═══════════════════════════════════════════════════════════════════════════
 * Verifies the canonical lifecycle (UNDERSTAND → CONTEXT → PLAN → POLICY →
 * EXECUTE → VERIFY → REMEMBER → RESPOND) reusing existing modules, without
 * performing real network calls. The real production module is executed here
 * against stubbed window modules + an injected runtime (the existing router).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'public', 'shared', 'autonomaAgentBrain.js'), 'utf8');

function makeLocalStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

function makeRenderer() {
  return {
    intro: (s) => '<intro>' + s + '</intro>',
    card: (h, b, a) => '<card>' + h + b + (a || '') + '</card>',
    head: (i, t, b) => '<head>' + t + '</head>',
    row: (l, v, c) => '<row>' + l + '=' + v + '</row>',
    actions: (...a) => '<actions>' + a.length + '</actions>',
  };
}

/**
 * Boot the Brain module in an isolated window-like scope.
 * @param {object} opts
 * @param {object} opts.modules  window module stubs (AgentAuthorization, etc.)
 * @param {object} opts.runtime  injected runtime hooks (classify, executeIntent, render)
 */
function boot(opts = {}) {
  const ls = makeLocalStorage();
  const win = {
    localStorage: ls,
    performance: { now: () => 0 },
  };

  // Default module stubs (all safe no-ops unless overridden)
  const defaults = {
    AgentAuthorization: {
      hasOperationAuth: () => true,
      validateExecution: () => ({ valid: true }),
      getAuthSummary: () => ({ count: 1, hasAuthorization: true }),
    },
    PolicyEngine: { quickCheck: () => ({ valid: true }), getDefaults: () => ({}) },
    RiskEngine: { analyze: () => ({ level: 'LOW' }) },
    AgentAudit: { getRecords: () => [] },
    AgentSession: {
      addConversationContext: () => {},
      getConversationContext: () => [],
      getSessionSummary: () => ({}),
    },
    AgentWalletManager: { getAgentAddress: () => '0x' + 'aa'.repeat(20) },
    FinancialContext: { getSnapshot: () => ({}) },
    AutonomaNLU: {
      decompose: () => ({ intent_type: null, entities: {}, missing: [], clarifications: null }),
    },
    AutonomaCore: {
      extractParams: () => ({}),
      getWorldState: () => ({}),
      addToHistory: () => {},
    },
    ExecutionPlanner: null,
  };
  Object.assign(win, defaults, opts.modules || {});

  const runtime = Object.assign(
    {
      classify: (msg) => ({ intent: 'QUERY_BALANCE', confidence: 0.9, params: {} }),
      executeIntent: async () => '<div>executed</div>',
      extractParams: () => ({}),
      render: makeRenderer(),
      msg: 'test message',
      rememberEntity: () => {},
    },
    opts.runtime || {}
  );

  const exWin = {};
  new Function('window', 'localStorage', 'performance', src)(win, ls, win.performance);
  const brain = win.AutonomaAgentBrain;

  return { brain, runtime, win, ls };
}

beforeEach(() => {
  // reset flag
});

describe('AgentBrain — lifecycle stages (unit)', () => {
  it('classifies read vs write intents', () => {
    const { brain } = boot();
    expect(brain.isRead(brain.canonical('QUERY_BALANCE'))).toBe(true);
    expect(brain.isRead(brain.canonical('SEND_PAYMENT'))).toBe(false);
    expect(brain.canonical('SWAP_EXECUTE')).toBe('swap_execute');
  });

  it('understand() combines the classifier + NLU into a structured object', () => {
    const { brain } = boot({
      runtime: {
        classify: () => ({ intent: 'SEND_PAYMENT', confidence: 0.9, params: { amount: 50, token: 'USDC', address: '0x' + '11'.repeat(20) } }),
      },
      modules: {
        AutonomaNLU: {
          decompose: () => ({ intent_type: 'payment', entities: { amount: 50, token: 'USDC', address: '0x' + '11'.repeat(20) }, missing: [] }),
        },
      },
    });
    const u = brain.understand('Send 50 USDC to 0x...', { classify: () => ({ intent: 'SEND_PAYMENT', confidence: 0.9, params: { amount: 50, token: 'USDC', address: '0x' + '11'.repeat(20) } }) });
    expect(u.intent).toBe('SEND_PAYMENT');
    expect(u.canonical).toBe('send_payment');
    expect(u.isWrite).toBe(true);
    expect(u.entities.amount).toBe(50);
    expect(u.entities.token).toBe('USDC');
  });

  it('plan() produces a read step for read intents and a resolve/balance/execute/verify chain for writes', () => {
    const { brain } = boot();
    const readPlan = brain.plan({ canonical: 'query_balance', entities: {} }, {}, {});
    expect(readPlan.steps.length).toBe(1);
    expect(readPlan.steps[0].type).toBe('read');

    const writePlan = brain.plan({ canonical: 'send_payment', entities: { address: '0xabc' } }, {}, {});
    const tools = writePlan.steps.map((s) => s.tool);
    expect(tools).toContain('wallet.getBalance');
    expect(tools).toContain('router.send_payment');
    expect(writePlan.steps.find((s) => s.type === 'write').requiresConfirmation).toBe(true);
  });

  it('evaluatePolicy() allows reads, gates writes on authorization, and blocks when denied', () => {
    const { brain } = boot();
    const readPol = brain.evaluatePolicy({ riskLevel: 'LOW' }, { canonical: 'query_balance', entities: {} }, {}, {});
    expect(readPol.allowed).toBe(true);
    expect(readPol.requiresConfirmation).toBe(false);

    const denied = boot({
      modules: { AgentAuthorization: { hasOperationAuth: () => false, validateExecution: () => ({ valid: true }) } },
    });
    const pol = denied.brain.evaluatePolicy({ riskLevel: 'LOW', requiresConfirmation: true }, { canonical: 'send_payment', entities: { amount: 50 } }, {}, {});
    expect(pol.allowed).toBe(false);
    expect(pol.reasons.join(' ')).toMatch(/authorization/i);
  });

  it('verify() reflects real audit state (pending is never converted to confirmed)', () => {
    const { brain } = boot();
    const pending = brain.verify({ ok: true, status: 'executed', deduplicated: false }, { canonical: 'send_payment', entities: { amount: 50, token: 'USDC', address: '0xabc' } }, {});
    expect(pending.status).toBe('pending'); // no audit record yet

    const confirmed = boot({
      modules: { AgentAudit: { getRecords: () => [{ result: 'success', transactionHash: '0x' + 'ab'.repeat(32) }] } },
    });
    const v = confirmed.brain.verify({ ok: true, status: 'executed', deduplicated: false }, { canonical: 'send_payment', entities: { amount: 50 } }, {});
    expect(v.status).toBe('confirmed');
    expect(v.transactionHash).toBe('0x' + 'ab'.repeat(32));

    const failed = boot({
      modules: { AgentAudit: { getRecords: () => [{ result: 'failed', transactionHash: null }] } },
    });
    const vf = failed.brain.verify({ ok: true, status: 'executed', deduplicated: false }, { canonical: 'send_payment', entities: { amount: 50 } }, {});
    expect(vf.status).toBe('failed');
  });
});

describe('AgentBrain — full orchestration (run)', () => {
  it('TEST 1 — simple read: balance query runs without confirmation', async () => {
    const calls = [];
    const { brain } = boot({
      runtime: {
        classify: () => ({ intent: 'QUERY_BALANCE', confidence: 0.9, params: {} }),
        executeIntent: async () => { calls.push('balance'); return '<div>500 USDC</div>'; },
      },
    });
    const res = await brain.run('What is my USDC balance?', {
      classify: () => ({ intent: 'QUERY_BALANCE', confidence: 0.9, params: {} }),
      executeIntent: async () => { calls.push('balance'); return '<div>500 USDC</div>'; },
      render: makeRenderer(),
      msg: 'What is my USDC balance?',
    });
    expect(res.handled).toBe(true);
    expect(res.type).toBe('response');
    expect(res.policy.requiresConfirmation).toBe(false);
    expect(res.verification.status).toBe('confirmed');
    expect(calls).toEqual(['balance']);
  });

  it('TEST 2 — missing information produces clarification, no transaction', async () => {
    const executed = [];
    const { brain } = boot();
    const res = await brain.run('Send money.', {
      classify: () => ({ intent: 'SEND_PAYMENT', confidence: 0.5, params: {} }),
      executeIntent: async () => { executed.push(1); return '<div>sent</div>'; },
      render: makeRenderer(),
      msg: 'Send money.',
    });
    expect(res.type).toBe('clarification');
    expect(res.missing.length).toBeGreaterThan(0);
    expect(executed.length).toBe(0);
  });

  it('TEST 3 — payment goes through policy + execute + verify + remember + respond', async () => {
    const executed = [];
    const remembered = [];
    const { brain } = boot({
      modules: {
        AgentAudit: { getRecords: () => [{ result: 'success', transactionHash: '0x' + 'cd'.repeat(32) }] },
        AgentSession: {
          addConversationContext: (s) => remembered.push(s),
          getConversationContext: () => [],
          getSessionSummary: () => ({}),
        },
      },
    });
    const res = await brain.run('Send 50 USDC to 0x' + '11'.repeat(20), {
      classify: () => ({ intent: 'SEND_PAYMENT', confidence: 0.9, params: { amount: 50, token: 'USDC', address: '0x' + '11'.repeat(20) } }),
      executeIntent: async () => { executed.push(1); return '<div>sent</div>'; },
      render: makeRenderer(),
      msg: 'Send 50 USDC',
      autoConfirm: true,
    });
    expect(res.handled).toBe(true);
    expect(executed.length).toBe(1);
    expect(res.verification.status).toBe('confirmed');
    expect(remembered.length).toBeGreaterThan(0);
  });

  it('TEST 4 — insufficient balance is blocked before any transaction', async () => {
    const executed = [];
    const { brain } = boot({
      modules: {
        AgentAuthorization: {
          hasOperationAuth: () => true,
          validateExecution: () => ({ valid: false, reason: 'Insufficient balance' }),
        },
      },
    });
    const res = await brain.run('Send 50 USDC', {
      classify: () => ({ intent: 'SEND_PAYMENT', confidence: 0.9, params: { amount: 50, token: 'USDC', address: '0xabc' } }),
      executeIntent: async () => { executed.push(1); return 'sent'; },
      render: makeRenderer(),
      msg: 'Send 50 USDC',
      autoConfirm: true,
    });
    expect(res.type).toBe('blocked');
    expect(executed.length).toBe(0);
  });

  it('TEST 5 — contextual reference updates the pending amount instead of creating a new op', async () => {
    const { brain } = boot();
    const first = await brain.run('Send 50 USDC to Alice', {
      classify: () => ({ intent: 'SEND_PAYMENT', confidence: 0.9, params: { amount: 50, token: 'USDC', recipientName: 'Alice', address: '0x' + '22'.repeat(20) } }),
      executeIntent: async () => '<div>sent</div>',
      render: makeRenderer(),
      msg: 'Send 50 USDC to Alice',
    });
    expect(first.type).toBe('confirmation_required');

    const second = await brain.run('Make it 75', {
      classify: () => ({ intent: 'DEFAULT', confidence: 0, params: { amount: 75 } }),
      executeIntent: async () => '<div>sent</div>',
      render: makeRenderer(),
      msg: 'Make it 75',
    });
    expect(second.type).toBe('confirmation_required');
    expect(second.updated).toBe(true);
    expect(second.understanding.entities.amount).toBe(75);
    expect(second.plan.id).toBe(first.plan.id); // same pending plan updated
  });

  it('TEST 6 — memory/contact resolution flows through the classifier into entities', async () => {
    const { brain } = boot();
    const resolved = '0x' + '33'.repeat(20);
    const u = brain.understand('Send 20 USDC to Alice', {
      classify: () => ({ intent: 'SEND_PAYMENT', confidence: 0.9, params: { amount: 20, token: 'USDC', address: resolved, recipientName: 'Alice' } }),
    });
    expect(u.entities.address).toBe(resolved);
    expect(u.entities.recipientName).toBe('Alice');
  });

  it('TEST 7 — write plan chains resolve → balance → policy → execute → verify', () => {
    const { brain } = boot();
    const p = brain.plan({ canonical: 'create_schedule', entities: { amount: 100, token: 'USDC', address: '0xabc', recipientName: 'Alice' } }, {}, {});
    const tools = p.steps.map((s) => s.tool);
    expect(tools).toContain('contacts.resolve');
    expect(tools).toContain('wallet.getBalance');
    expect(tools).toContain('router.create_schedule');
    expect(tools).toContain('verify.receipt');
  });

  it('TEST 8 — write verification reports pending (not confirmed) without a success receipt', async () => {
    const { brain } = boot();
    const res = await brain.run('Send 50 USDC', {
      classify: () => ({ intent: 'SEND_PAYMENT', confidence: 0.9, params: { amount: 50, token: 'USDC', address: '0xabc' } }),
      executeIntent: async () => '<div>submitted</div>',
      render: makeRenderer(),
      msg: 'Send 50 USDC',
      autoConfirm: true,
    });
    expect(res.verification.status).toBe('pending');
    expect(res.verification.status).not.toBe('confirmed');
  });

  it('TEST 9 — failed receipt is reported as failure, not success', async () => {
    const { brain } = boot({
      modules: { AgentAudit: { getRecords: () => [{ result: 'failed', transactionHash: '0x' + 'ef'.repeat(32) }] } },
    });
    const res = await brain.run('Send 50 USDC', {
      classify: () => ({ intent: 'SEND_PAYMENT', confidence: 0.9, params: { amount: 50, token: 'USDC', address: '0xabc' } }),
      executeIntent: async () => '<div>sent</div>',
      render: makeRenderer(),
      msg: 'Send 50 USDC',
      autoConfirm: true,
    });
    expect(res.verification.status).toBe('failed');
  });

  it('TEST 10 — duplicate execution (same planId + stepId) is blocked', async () => {
    const { brain } = boot();
    const planObj = { id: 'plan_dup', steps: [{ id: 'execute', type: 'write', requiresConfirmation: true }] };
    const understanding = { canonical: 'send_payment', entities: { amount: 5 } };
    const runtime = { executeIntent: async () => '<div>sent</div>', msg: 'x' };

    const r1 = await brain.execute(planObj, understanding, {}, runtime);
    expect(r1.deduplicated).toBe(false);
    const r2 = await brain.execute(planObj, understanding, {}, runtime);
    expect(r2.deduplicated).toBe(true);
  });

  it('TEST 11 — policy denial blocks execution before the transaction', async () => {
    const executed = [];
    const { brain } = boot({
      modules: {
        AgentAuthorization: {
          hasOperationAuth: () => true,
          validateExecution: () => ({ valid: false, reason: 'Daily spending limit exceeded' }),
        },
      },
    });
    const res = await brain.run('Send 999 USDC', {
      classify: () => ({ intent: 'SEND_PAYMENT', confidence: 0.9, params: { amount: 999, token: 'USDC', address: '0xabc' } }),
      executeIntent: async () => { executed.push(1); return 'sent'; },
      render: makeRenderer(),
      msg: 'Send 999 USDC',
      autoConfirm: true,
    });
    expect(res.type).toBe('blocked');
    expect(res.policy.reasons.join(' ')).toMatch(/Daily spending limit/i);
    expect(executed.length).toBe(0);
  });

  it('TEST 12 — feature flag defaults to OFF and run() gracefully falls through on failure', async () => {
    const { brain } = boot();
    expect(brain.isEnabled()).toBe(false);
    // Simulate a failure inside the lifecycle → handled:false so the caller falls back.
    const res = await brain.run('test', {});
    expect(res.handled).toBe(false); // no runtime.executeIntent provided → lifecycle throws
  });
});
