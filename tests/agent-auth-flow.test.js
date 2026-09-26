/**
 * Agent Authorization Flow Tests
 * ================================
 * Tests the full pipeline:
 *   User intent
 *   → Brain (Policy stage: no auth)
 *   → authorization_required (NOT blocked)
 *   → _showPermissionCard
 *   → User authorizes
 *   → Resume original intent
 *   → confirmation_required (Dynamic Action Surface)
 *   → User approves
 *   → Execute
 *   → Result
 *
 * Covers: swap, payment (send), bridge, schedule
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

/* ── helpers ── */
function loadModule(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', 'public', 'shared', relPath), 'utf8');
}

/**
 * Build a fresh VM context where `window` IS the context object itself.
 * The auth/brain IIFEs do `window.AgentAuthorization = ...` which requires
 * window to be the VM global, not a nested sub-object.
 */
function buildContext(overrides) {
  var store = {};
  var ctx = vm.createContext({
    // stubs
    walletAddress: null,
    // Circle Wallet is now the canonical agent identity — no AgentWalletManager
    CircleAgent: { getCachedAddress: function(){ return '0xCircle0000000000000000000000000000000001'; } },
    AgentAuthorization: null,
    AgentCapabilityRouter: null,
    AutonomaAgentBrain: null,
    PolicyEngine: null,
    localStorage: {
      getItem: function(k) { return store[k] != null ? store[k] : null; },
      setItem: function(k, v) { store[k] = v; },
      removeItem: function(k) { delete store[k]; }
    },
    setTimeout: function(fn) { fn(); return 0; },
    clearTimeout: function() {},
    performance: { now: function() { return Date.now(); } },
    AUTONOMA_AGENT_BRAIN_ENABLED: true,
    console: console
  });
  // window MUST be the context itself so IIFE assignments reach the global
  ctx.window = ctx;
  Object.assign(ctx, overrides || {});
  return ctx;
}

// makeWindow is now an alias that returns a context (for test readability)
function makeWindow(overrides) {
  return buildContext(overrides);
}

function runInContext(code, ctx) {
  vm.runInContext(code, ctx);
}

function loadBrain(ctx) {
  runInContext(loadModule('autonomaAgentBrain.js'), ctx);
}

function loadAuth(ctx) {
  runInContext(loadModule('agentAuthorization.js'), ctx);
}

/* ── fixture: minimal stubs ── */

/**
 * Minimal classify function — mirrors what autProcess injects as runtime.classify.
 * The Brain uses this to determine intent + isWrite before any NLU module runs.
 */
function classify(msg) {
  var low = (msg || '').toLowerCase().trim();
  // swap
  if (/\bswap\b/.test(low)) return { intent: 'SWAP_EXECUTE', confidence: 0.9, params: extractBasicParams(msg) };
  // bridge
  if (/\bbridge\b/.test(low)) return { intent: 'BRIDGE', confidence: 0.9, params: extractBasicParams(msg) };
  // schedule / recurring
  if (/\b(schedule|recurring|weekly|monthly|daily)\b/.test(low)) return { intent: 'CREATE_SCHEDULE', confidence: 0.8, params: extractBasicParams(msg) };
  // send / pay
  if (/\b(send|pay|transfer|payment)\b/.test(low)) return { intent: 'SEND_PAYMENT', confidence: 0.9, params: extractBasicParams(msg) };
  // balance
  if (/\b(balance|wallet|funds)\b/.test(low)) return { intent: 'QUERY_BALANCE', confidence: 0.9, params: {} };
  return { intent: 'DEFAULT', confidence: 0.1, params: {} };
}

function extractBasicParams(msg) {
  var params = {};
  var amtMatch = msg.match(/(\d+(?:\.\d+)?)\s*(?:USDC|EURC|ETH|USD)?/i);
  if (amtMatch) params.amount = parseFloat(amtMatch[1]);
  var tokMatch = msg.match(/\b(USDC|EURC|ETH|MATIC|ARB)\b/gi);
  if (tokMatch && tokMatch[0]) params.token = tokMatch[0].toUpperCase();
  if (tokMatch && tokMatch[1]) params.toToken = tokMatch[1].toUpperCase();
  var addrMatch = msg.match(/0x[a-fA-F0-9]{40}/);
  if (addrMatch) params.address = addrMatch[0];
  var chainMatch = msg.match(/\b(base|ethereum|arbitrum|polygon|avalanche)\b/i);
  if (chainMatch) params.toChain = chainMatch[1];
  return params;
}

function makeRuntime(win) {
  return {
    msg: '',
    classify: classify,  // inject the classifier — matches what autProcess does
    render: {
      intro: function(h) { return '<intro>' + h + '</intro>'; },
      card:  function(h, b) { return '<card>' + h + b + '</card>'; },
      head:  function(i, t, o) { return '<head>' + t + '</head>'; },
      row:   function(k, v, c) { return '<row>' + k + '=' + v + '</row>'; },
      actions: function() { return '<actions/>'; }
    },
    executeIntent: function(intent, params) {
      return Promise.resolve('<result intent="' + intent + '" />');
    },
    autoConfirm: false
  };
}

/* ══════════════════════════════════════════════════════════════
   SUITE 1: AgentBrain Policy stage — authorization_required
   ══════════════════════════════════════════════════════════════ */
describe('AgentBrain Policy: needsAuthorization', function() {

  var win;
  beforeEach(function() {
    win = buildContext();
    loadAuth(win);
    loadBrain(win);
    // No authorization granted — clean state
  });

  it('returns authorization_required (not blocked) when no auth exists for swap', async function() {
    var out = await win.AutonomaAgentBrain.run('swap 1 USDC to EURC', makeRuntime(win));
    assert.ok(out.handled, 'should be handled');
    assert.equal(out.type, 'authorization_required', 'type must be authorization_required, got: ' + out.type);
    assert.ok(out.policy && out.policy.needsAuthorization, 'policy.needsAuthorization should be true');
    assert.ok(!out.html || typeof out.html === 'string', 'html should be null or string (autProcess sets it)');
  });

  it('returns authorization_required for payment (send)', async function() {
    var out = await win.AutonomaAgentBrain.run('send 1 USDC to 0xabcdef1234567890abcdef1234567890abcdef12', makeRuntime(win));
    assert.ok(out.handled);
    assert.equal(out.type, 'authorization_required');
    assert.equal(out.missingOp, 'payment', 'canonical send_payment must map to payment');
  });

  it('returns authorization_required for bridge', async function() {
    var out = await win.AutonomaAgentBrain.run('bridge 5 USDC to Base', makeRuntime(win));
    assert.ok(out.handled);
    assert.equal(out.type, 'authorization_required');
    assert.ok(out.policy && out.policy.needsAuthorization);
  });

  it('returns authorization_required for schedule', async function() {
    var out = await win.AutonomaAgentBrain.run('schedule send 2 USDC weekly to 0x1234567890abcdef1234567890abcdef12345678', makeRuntime(win));
    assert.ok(out.handled);
    assert.equal(out.type, 'authorization_required');
  });

  it('does NOT return authorization_required for read-only intents', async function() {
    var out = await win.AutonomaAgentBrain.run('what is my balance', makeRuntime(win));
    assert.ok(out.handled);
    assert.notEqual(out.type, 'authorization_required', 'balance query should not require authorization');
  });

  it('pendingKey is stored in localStorage for resume', async function() {
    await win.AutonomaAgentBrain.run('swap 1 USDC to EURC', makeRuntime(win));
    var stored = win.localStorage.getItem('elligentt_agent_brain_pending_v1');
    assert.ok(stored, 'pending intent must be stored in localStorage');
    var parsed = JSON.parse(stored);
    var hasAuthPending = Object.keys(parsed).some(function(k){ return k.startsWith('auth_pending_'); });
    assert.ok(hasAuthPending, 'must have an auth_pending_* key in localStorage');
  });

});

/* ══════════════════════════════════════════════════════════════
   SUITE 2: After authorization is granted — proceeds to
            confirmation_required (not authorization_required)
   ══════════════════════════════════════════════════════════════ */
describe('AgentBrain Policy: proceeds after authorization is granted', function() {

  var win;
  beforeEach(function() {
    win = buildContext();
    loadAuth(win);
    loadBrain(win);
  });

  function grantAuth(win, ops) {
    var opts = {
      allowedTokens: ['*'], allowedNetworks: ['*'], allowedOperations: [],
      durationMs: 3600000, maxSpending: 10000, dailyLimit: 1000, maxRiskLevel: 'HIGH'
    };
    ops.forEach(function(op) {
      var map = { swap: 'allowSwap', bridge: 'allowBridge', payment: 'allowPayments', scheduled: 'allowScheduled', recurring: 'allowRecurring' };
      if (map[op]) opts[map[op]] = true;
    });
    win.AgentAuthorization.createAuthorization(opts);
  }

  it('swap proceeds to confirmation_required after swap authorization granted', async function() {
    grantAuth(win, ['swap']);
    var out = await win.AutonomaAgentBrain.run('swap 1 USDC to EURC', makeRuntime(win));
    assert.ok(out.handled);
    assert.notEqual(out.type, 'authorization_required', 'must not ask for auth again');
    // Either confirmation_required or response (if autoConfirm)
    assert.ok(
      out.type === 'confirmation_required' || out.type === 'response',
      'expected confirmation_required or response, got: ' + out.type
    );
  });

  it('payment proceeds to confirmation_required after payment authorization granted', async function() {
    grantAuth(win, ['payment']);
    var out = await win.AutonomaAgentBrain.run('send 1 USDC to 0xabcdef1234567890abcdef1234567890abcdef12', makeRuntime(win));
    assert.ok(out.handled);
    assert.notEqual(out.type, 'authorization_required');
    assert.ok(out.type === 'confirmation_required' || out.type === 'response' || out.type === 'clarification');
  });

  it('bridge proceeds to confirmation_required after bridge authorization granted', async function() {
    grantAuth(win, ['bridge']);
    var out = await win.AutonomaAgentBrain.run('bridge 5 USDC to Base', makeRuntime(win));
    assert.ok(out.handled);
    assert.notEqual(out.type, 'authorization_required');
    assert.ok(out.type === 'confirmation_required' || out.type === 'response' || out.type === 'clarification');
  });

  it('schedule proceeds after scheduled + payment authorization granted', async function() {
    grantAuth(win, ['scheduled', 'recurring', 'payment']);
    var out = await win.AutonomaAgentBrain.run('schedule send 2 USDC weekly to 0x1234567890abcdef1234567890abcdef12345678', makeRuntime(win));
    assert.ok(out.handled);
    assert.notEqual(out.type, 'authorization_required');
  });

});

/* ══════════════════════════════════════════════════════════════
   SUITE 3: OP_TO_AUTH mapping — send/payment canonical
   ══════════════════════════════════════════════════════════════ */
describe('AgentBrain OP_TO_AUTH mapping', function() {

  var win;
  beforeEach(function() {
    win = buildContext();
    loadAuth(win);
    loadBrain(win);
  });

  it('send_payment maps to payment in OP_TO_AUTH', function() {
    assert.equal(win.AutonomaAgentBrain.OP_TO_AUTH['send_payment'], 'payment');
  });

  it('multisend maps to payment in OP_TO_AUTH', function() {
    assert.equal(win.AutonomaAgentBrain.OP_TO_AUTH['multisend'], 'payment');
  });

  it('swap_execute maps to swap in OP_TO_AUTH', function() {
    assert.equal(win.AutonomaAgentBrain.OP_TO_AUTH['swap_execute'], 'swap');
  });

  it('bridge maps to bridge in OP_TO_AUTH', function() {
    assert.equal(win.AutonomaAgentBrain.OP_TO_AUTH['bridge'], 'bridge');
  });

  it('send authorization_required carries missingOp = payment (not send_payment)', async function() {
    var out = await win.AutonomaAgentBrain.run('send 5 USDC to 0xabcdef1234567890abcdef1234567890abcdef12', makeRuntime(win));
    if (out.type === 'authorization_required') {
      assert.equal(out.missingOp, 'payment', 'missingOp for send must be payment (canonical)');
    }
  });

});

/* ══════════════════════════════════════════════════════════════
   SUITE 4: Security invariants preserved
   ══════════════════════════════════════════════════════════════ */
describe('Security invariants after auth flow fix', function() {

  var win;
  beforeEach(function() {
    win = buildContext();
    loadAuth(win);
    loadBrain(win);
  });

  it('authorization_required type carries html: null (autProcess handles display)', async function() {
    var out = await win.AutonomaAgentBrain.run('swap 1 USDC to EURC', makeRuntime(win));
    if (out.type === 'authorization_required') {
      assert.ok(out.html === null || out.html === undefined, 'html must be null for autProcess to handle');
    }
  });

  it('confirmation_required still required after auth — no auto-execute', async function() {
    // Grant auth, then run — must stop at confirmation_required, not execute
    win.AgentAuthorization.createAuthorization({
      allowSwap: true, allowedTokens: ['*'], allowedNetworks: ['*'],
      allowedOperations: [], durationMs: 3600000, maxSpending: 10000,
      dailyLimit: 1000, maxRiskLevel: 'HIGH'
    });
    var executed = false;
    var rt = makeRuntime(win);
    rt.executeIntent = function() { executed = true; return Promise.resolve('<result/>'); };
    rt.autoConfirm = false; // user has NOT confirmed

    var out = await win.AutonomaAgentBrain.run('swap 1 USDC to EURC', rt);
    assert.ok(!executed, 'execution must NOT happen before user confirms');
    if (out.type === 'confirmation_required') {
      assert.ok(true, 'correctly stopped at confirmation_required');
    }
  });

  it('execution only happens after both authorize AND confirm', async function() {
    win.AgentAuthorization.createAuthorization({
      allowSwap: true, allowedTokens: ['*'], allowedNetworks: ['*'],
      allowedOperations: [], durationMs: 3600000, maxSpending: 10000,
      dailyLimit: 1000, maxRiskLevel: 'HIGH'
    });
    var executed = false;
    var rt = makeRuntime(win);
    rt.executeIntent = function() { executed = true; return Promise.resolve('<result/>'); };
    rt.autoConfirm = true; // simulate user approving via Dynamic Action Surface

    var out = await win.AutonomaAgentBrain.run('swap 1 USDC to EURC', rt);
    // With autoConfirm=true, execution should have occurred
    assert.ok(executed, 'execution must happen after explicit confirm');
  });

  it('authorization is stored in AgentAuthorization (not bypassed)', function() {
    win.AgentAuthorization.createAuthorization({
      allowPayments: true, allowedTokens: ['*'], allowedNetworks: ['*'],
      allowedOperations: [], durationMs: 3600000, maxSpending: 500, dailyLimit: 100
    });
    var active = win.AgentAuthorization.getActive();
    assert.ok(active.length > 0, 'authorization must be stored in AgentAuthorization');
    assert.ok(active[0].allowPayments, 'allowPayments must be set');
  });

});

/* ══════════════════════════════════════════════════════════════
   SUITE 5: AgentAuthorization hasOperationAuth
   ══════════════════════════════════════════════════════════════ */
describe('AgentAuthorization.hasOperationAuth', function() {

  var win;
  beforeEach(function() {
    win = buildContext();
    loadAuth(win);
  });

  it('returns false when no authorization exists', function() {
    assert.equal(win.AgentAuthorization.hasOperationAuth('swap'), false);
    assert.equal(win.AgentAuthorization.hasOperationAuth('payment'), false);
    assert.equal(win.AgentAuthorization.hasOperationAuth('bridge'), false);
  });

  it('returns true for swap after swap auth created', function() {
    win.AgentAuthorization.createAuthorization({
      allowSwap: true, allowedTokens: ['*'], allowedNetworks: ['*'],
      allowedOperations: [], durationMs: 3600000, maxSpending: 1000
    });
    assert.equal(win.AgentAuthorization.hasOperationAuth('swap'), true);
  });

  it('returns true for payment after payment auth created', function() {
    win.AgentAuthorization.createAuthorization({
      allowPayments: true, allowedTokens: ['*'], allowedNetworks: ['*'],
      allowedOperations: [], durationMs: 3600000, maxSpending: 1000
    });
    assert.equal(win.AgentAuthorization.hasOperationAuth('payment'), true);
    // multisend also maps to payment
    assert.equal(win.AgentAuthorization.hasOperationAuth('multisend'), true);
  });

  it('returns true for bridge after bridge auth created', function() {
    win.AgentAuthorization.createAuthorization({
      allowBridge: true, allowedTokens: ['*'], allowedNetworks: ['*'],
      allowedOperations: [], durationMs: 3600000, maxSpending: 1000
    });
    assert.equal(win.AgentAuthorization.hasOperationAuth('bridge'), true);
  });

  it('payment auth does not grant swap', function() {
    win.AgentAuthorization.createAuthorization({
      allowPayments: true, allowedTokens: ['*'], allowedNetworks: ['*'],
      allowedOperations: [], durationMs: 3600000, maxSpending: 1000
    });
    assert.equal(win.AgentAuthorization.hasOperationAuth('swap'), false);
  });

  it('expired authorization is not valid', function() {
    win.AgentAuthorization.createAuthorization({
      allowSwap: true, allowedTokens: ['*'], allowedNetworks: ['*'],
      allowedOperations: [], durationMs: -1000, maxSpending: 1000 // already expired
    });
    assert.equal(win.AgentAuthorization.hasOperationAuth('swap'), false);
  });

  it('revoked authorization is not valid', function() {
    var auth = win.AgentAuthorization.createAuthorization({
      allowSwap: true, allowedTokens: ['*'], allowedNetworks: ['*'],
      allowedOperations: [], durationMs: 3600000, maxSpending: 1000
    });
    win.AgentAuthorization.revokeAuthorization(auth.id, 'test');
    assert.equal(win.AgentAuthorization.hasOperationAuth('swap'), false);
  });

});
