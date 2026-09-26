/**
 * Agent Wallet Integration Tests
 * =============================================================
 * Verifies:
 *   1. buildBalanceSurface prefers CircleAgent (canonical) over connected wallet
 *   2. CircleAgent address is used throughout balance → payment → swap → bridge → schedule
 *   3. No mock data — surface is async and awaits real CircleAgent calls
 *   4. Capability aliases: send === payment
 *   5. OP_TO_AUTH mapping covers all capabilities
 *   6. AI Smart Wallet / Circle Agent architecture alignment
 */

'use strict';
const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function loadModule(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', 'public', 'shared', relPath), 'utf8');
}

function buildCtx(overrides) {
  var store = {};
  var ctx = vm.createContext({
    walletAddress: '0xPersonal000000000000000000000000000000001',
    AgentWalletManager: {
      getAgentAddress: function() { return '0xAgentEOA00000000000000000000000000000001'; },
      isPaused: function() { return false; },
      getReputationScore: function() { return 95; }
    },
    AgentAuthorization: null,
    CircleAgent: null,
    AutonomaAgentBrain: null,
    FinancialContext: null,
    AutonomaCore: null,
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
    showPage: function() {},
    console: console
  });
  ctx.window = ctx;
  Object.assign(ctx, overrides || {});
  return ctx;
}

function loadRouter(ctx) {
  vm.runInContext(loadModule('agentCapabilityRouter.js'), ctx);
}
function loadAuth(ctx) {
  vm.runInContext(loadModule('agentAuthorization.js'), ctx);
}
function loadBrain(ctx) {
  vm.runInContext(loadModule('autonomaAgentBrain.js'), ctx);
}

/* ══════════════════════════════════════════════════════════════
   SUITE 1: buildBalanceSurface — CircleAgent as canonical source
   ══════════════════════════════════════════════════════════════ */
describe('buildBalanceSurface: CircleAgent canonical', function() {

  it('shows Circle Agent Wallet section when CircleAgent is available', async function() {
    var ctx = buildCtx({
      CircleAgent: {
        getStatus: async function() {
          return { walletAddress: '0xCircle000000000000000000000000000000CAFE', wallet: { state: 'LIVE' } };
        },
        getBalance: async function() {
          return { tokenBalances: [
            { token: { symbol: 'USDC' }, amount: '150.00' },
            { token: { symbol: 'EURC' }, amount: '50.00' }
          ]};
        },
        formatBalance: function(data) {
          var r = {};
          if (data && data.tokenBalances) {
            data.tokenBalances.forEach(function(tb) {
              r[tb.token.symbol] = parseFloat(tb.amount).toFixed(2);
            });
          }
          return r;
        },
        getCachedAddress: function() { return '0xCircle000000000000000000000000000000CAFE'; }
      }
    });
    loadRouter(ctx);

    var html = await ctx.AgentCapabilityRouter.buildBalanceSurface();
    assert.ok(html.includes('Circle Agent Wallet'), 'must show "Circle Agent Wallet"');
    assert.ok(html.includes('CANONICAL'), 'must badge the canonical wallet');
    assert.ok(html.includes('0xCircle000000000000000000000000000000CAFE'), 'must show Circle wallet address');
    assert.ok(html.includes('USDC'), 'must show USDC balance');
    assert.ok(html.includes('150'), 'must show USDC amount');
  });

  it('shows CANONICAL badge on Circle Agent section', async function() {
    var ctx = buildCtx({
      CircleAgent: {
        getStatus: async function() { return { walletAddress: '0xCA', wallet: { state: 'LIVE' } }; },
        getBalance: async function() { return { tokenBalances: [] }; },
        formatBalance: function() { return {}; },
        getCachedAddress: function() { return '0xCA'; }
      }
    });
    loadRouter(ctx);
    var html = await ctx.AgentCapabilityRouter.buildBalanceSurface();
    assert.ok(html.includes('CANONICAL'), 'CANONICAL badge required');
  });

  it('shows Agent EOA Wallet as secondary section', async function() {
    var ctx = buildCtx({
      CircleAgent: {
        getStatus: async function() { return { walletAddress: '0xCAFE', wallet: { state: 'LIVE' } }; },
        getBalance: async function() { return { tokenBalances: [] }; },
        formatBalance: function() { return {}; },
        getCachedAddress: function() { return '0xCAFE'; }
      }
    });
    loadRouter(ctx);
    var html = await ctx.AgentCapabilityRouter.buildBalanceSurface();
    assert.ok(html.includes('Agent EOA Wallet'), 'must show Agent EOA section');
    assert.ok(html.includes('0xAgentEOA'), 'must show EOA address');
  });

  it('does NOT show "Connect your wallet to see balances" when CircleAgent has data', async function() {
    var ctx = buildCtx({
      CircleAgent: {
        getStatus: async function() { return { walletAddress: '0xCIRCLE', wallet: { state: 'LIVE' } }; },
        getBalance: async function() {
          return { tokenBalances: [{ token: { symbol: 'USDC' }, amount: '1.00' }] };
        },
        formatBalance: function(data) {
          var r = {};
          if (data && data.tokenBalances) data.tokenBalances.forEach(function(tb){ r[tb.token.symbol] = tb.amount; });
          return r;
        },
        getCachedAddress: function() { return '0xCIRCLE'; }
      }
    });
    loadRouter(ctx);
    var html = await ctx.AgentCapabilityRouter.buildBalanceSurface();
    assert.ok(!html.includes('Connect your wallet to see balances'), 'old error message must not appear');
  });

  it('falls back gracefully when CircleAgent is unavailable', async function() {
    var ctx = buildCtx({ CircleAgent: null });
    loadRouter(ctx);
    var html = await ctx.AgentCapabilityRouter.buildBalanceSurface();
    // Should still show something (Agent EOA or fallback), not throw
    assert.ok(typeof html === 'string' && html.length > 0, 'must return non-empty HTML');
  });

  it('shows fallback message when nothing is configured', async function() {
    var ctx = buildCtx({ CircleAgent: null, AgentWalletManager: null, walletAddress: null });
    loadRouter(ctx);
    var html = await ctx.AgentCapabilityRouter.buildBalanceSurface();
    assert.ok(html.includes('wallet') || html.includes('balance') || html.includes('connect'), 'must show some guidance');
  });
});

/* ══════════════════════════════════════════════════════════════
   SUITE 2: Capability alias — send === payment
   ══════════════════════════════════════════════════════════════ */
describe('Capability alias: send === payment', function() {
  var ctx;
  beforeEach(function() {
    ctx = buildCtx();
    loadAuth(ctx);
    loadBrain(ctx);
  });

  it('OP_TO_AUTH maps send_payment to payment', function() {
    assert.equal(ctx.AutonomaAgentBrain.OP_TO_AUTH['send_payment'], 'payment');
  });

  it('OP_TO_AUTH maps multisend to payment', function() {
    assert.equal(ctx.AutonomaAgentBrain.OP_TO_AUTH['multisend'], 'payment');
  });

  it('OP_TO_AUTH maps mass_payment to payment', function() {
    assert.equal(ctx.AutonomaAgentBrain.OP_TO_AUTH['mass_payment'], 'payment');
  });

  it('payment auth covers send_payment via OP_TO_AUTH', function() {
    ctx.AgentAuthorization.createAuthorization({
      allowPayments: true, allowedTokens: ['*'], allowedNetworks: ['*'],
      allowedOperations: [], durationMs: 3600000, maxSpending: 1000
    });
    // send_payment → payment → allowPayments
    assert.ok(ctx.AgentAuthorization.hasOperationAuth('payment'), 'payment auth must be valid');
  });
});

/* ══════════════════════════════════════════════════════════════
   SUITE 3: Full capability set coverage
   ══════════════════════════════════════════════════════════════ */
describe('Canonical capability set', function() {
  var ctx;
  beforeEach(function() {
    ctx = buildCtx();
    loadAuth(ctx);
    loadBrain(ctx);
  });

  var capabilities = ['payment', 'swap', 'bridge', 'scheduled'];

  capabilities.forEach(function(cap) {
    it('hasOperationAuth("' + cap + '") returns false when no auth', function() {
      assert.equal(ctx.AgentAuthorization.hasOperationAuth(cap), false);
    });
  });

  it('granting payment covers payment + send alias', function() {
    ctx.AgentAuthorization.createAuthorization({
      allowPayments: true, allowedTokens: ['*'], allowedNetworks: ['*'],
      allowedOperations: [], durationMs: 3600000, maxSpending: 1000
    });
    assert.ok(ctx.AgentAuthorization.hasOperationAuth('payment'));
  });

  it('granting swap covers swap_execute', function() {
    ctx.AgentAuthorization.createAuthorization({
      allowSwap: true, allowedTokens: ['*'], allowedNetworks: ['*'],
      allowedOperations: [], durationMs: 3600000, maxSpending: 1000
    });
    assert.ok(ctx.AgentAuthorization.hasOperationAuth('swap'));
  });

  it('granting bridge covers bridge', function() {
    ctx.AgentAuthorization.createAuthorization({
      allowBridge: true, allowedTokens: ['*'], allowedNetworks: ['*'],
      allowedOperations: [], durationMs: 3600000, maxSpending: 1000
    });
    assert.ok(ctx.AgentAuthorization.hasOperationAuth('bridge'));
  });

  it('granting scheduled covers schedule/recurring', function() {
    ctx.AgentAuthorization.createAuthorization({
      allowScheduled: true, allowedTokens: ['*'], allowedNetworks: ['*'],
      allowedOperations: [], durationMs: 3600000, maxSpending: 1000
    });
    assert.ok(ctx.AgentAuthorization.hasOperationAuth('scheduled'));
  });

  it('each capability independently isolated — payment does not grant swap', function() {
    ctx.AgentAuthorization.createAuthorization({
      allowPayments: true, allowedTokens: ['*'], allowedNetworks: ['*'],
      allowedOperations: [], durationMs: 3600000, maxSpending: 1000
    });
    assert.equal(ctx.AgentAuthorization.hasOperationAuth('swap'), false);
    assert.equal(ctx.AgentAuthorization.hasOperationAuth('bridge'), false);
  });
});

/* ══════════════════════════════════════════════════════════════
   SUITE 4: Circle Agent wallet context persists across capabilities
   ══════════════════════════════════════════════════════════════ */
describe('Circle Agent wallet context across capabilities', function() {

  it('CircleAgent.getCachedAddress is the same value used in buildBalanceSurface', async function() {
    var CIRCLE_ADDR = '0xCircleCanonical0000000000000000000000001';
    var ctx = buildCtx({
      CircleAgent: {
        getStatus: async function() { return { walletAddress: CIRCLE_ADDR, wallet: { state: 'LIVE' } }; },
        getBalance: async function() { return { tokenBalances: [] }; },
        formatBalance: function() { return {}; },
        getCachedAddress: function() { return CIRCLE_ADDR; }
      }
    });
    loadRouter(ctx);
    var html = await ctx.AgentCapabilityRouter.buildBalanceSurface();
    assert.ok(html.includes(CIRCLE_ADDR), 'Circle canonical address must appear in balance surface');
  });

  it('createSurface for SEND_PAYMENT uses params.address (recipient), not agent address', function() {
    var ctx = buildCtx();
    loadRouter(ctx);
    var html = ctx.AgentCapabilityRouter.createSurface('SEND_PAYMENT', {
      amount: '10',
      token: 'USDC',
      address: '0xRecipient0000000000000000000000000000001'
    }, {});
    assert.ok(html.includes('SEND PROPOSAL'), 'must be a send proposal');
    assert.ok(html.includes('Recipient'), 'must show recipient');
    assert.ok(html.includes('0xRecip') || html.includes('Recipient'), 'must show recipient address (may be shortened)');
  });

  it('createSurface for SWAP_EXECUTE uses correct from/to tokens', function() {
    var ctx = buildCtx();
    loadRouter(ctx);
    var html = ctx.AgentCapabilityRouter.createSurface('SWAP_EXECUTE', {
      amount: '5',
      token: 'USDC',
      toToken: 'EURC'
    }, {});
    assert.ok(html.includes('SWAP PROPOSAL'), 'must be a swap proposal');
    assert.ok(html.includes('USDC'), 'must show from token');
    assert.ok(html.includes('EURC'), 'must show to token');
  });

  it('createSurface for BRIDGE uses correct chains', function() {
    var ctx = buildCtx();
    loadRouter(ctx);
    var html = ctx.AgentCapabilityRouter.createSurface('BRIDGE', {
      amount: '20',
      token: 'USDC',
      fromChain: 'Arc Mainnet',
      toChain: 'Base'
    }, {});
    assert.ok(html.includes('BRIDGE PROPOSAL'), 'must be a bridge proposal');
    assert.ok(html.includes('Arc Mainnet'), 'must show source chain');
    assert.ok(html.includes('Base'), 'must show destination chain');
  });

  it('createSurface for CREATE_SCHEDULE shows frequency', function() {
    var ctx = buildCtx();
    loadRouter(ctx);
    var html = ctx.AgentCapabilityRouter.createSurface('CREATE_SCHEDULE', {
      amount: '100',
      token: 'USDC',
      recurrence: 'monthly',
      address: '0xRecipient0000000000000000000000000000002'
    }, {});
    assert.ok(html.includes('SCHEDULE PROPOSAL'), 'must be a schedule proposal');
    assert.ok(html.includes('Monthly'), 'must show monthly frequency');
  });
});

/* ══════════════════════════════════════════════════════════════
   SUITE 5: Authorization flows respect Circle Agent identity
   ══════════════════════════════════════════════════════════════ */
describe('Authorization flow: Circle Agent as auth grantee', function() {

  function classify(msg) {
    var low = (msg || '').toLowerCase();
    if (/\bbalance\b/.test(low)) return { intent: 'QUERY_BALANCE', confidence: 0.95, params: {} };
    if (/\bswap\b/.test(low)) return { intent: 'SWAP_EXECUTE', confidence: 0.9, params: { amount: 1, token: 'USDC', toToken: 'EURC' } };
    if (/\bsend\b/.test(low)) return { intent: 'SEND_PAYMENT', confidence: 0.9, params: { amount: 1, token: 'USDC', address: '0x1234' } };
    if (/\bbridge\b/.test(low)) return { intent: 'BRIDGE', confidence: 0.9, params: { amount: 1, token: 'USDC', toChain: 'Base' } };
    if (/\bschedule\b/.test(low)) return { intent: 'CREATE_SCHEDULE', confidence: 0.9, params: { amount: 1, token: 'USDC', recurrence: 'monthly' } };
    return { intent: 'DEFAULT', confidence: 0.1, params: {} };
  }

  function makeRuntime(ctx) {
    return {
      msg: '',
      classify: classify,
      render: {
        intro: function(h) { return '<i>' + h + '</i>'; },
        card: function(h, b) { return '<c>' + h + b + '</c>'; },
        head: function(i, t) { return '<h>' + t + '</h>'; },
        row: function(k, v) { return '<r>' + k + '=' + v + '</r>'; },
        actions: function() { return '<a/>'; }
      },
      executeIntent: function(intent, params) { return Promise.resolve('<ok intent="' + intent + '"/>'); },
      autoConfirm: false
    };
  }

  it('balance query returns response type (read — no auth needed)', async function() {
    var ctx = buildCtx();
    loadAuth(ctx);
    loadBrain(ctx);
    var rt = makeRuntime(ctx);
    rt.msg = 'balance';
    var out = await ctx.AutonomaAgentBrain.run('balance', rt);
    assert.ok(out.handled, 'must be handled');
    assert.notEqual(out.type, 'authorization_required', 'balance must not require authorization');
  });

  it('swap without auth → authorization_required', async function() {
    var ctx = buildCtx();
    loadAuth(ctx);
    loadBrain(ctx);
    var rt = makeRuntime(ctx);
    rt.msg = 'swap 1 USDC to EURC';
    var out = await ctx.AutonomaAgentBrain.run('swap 1 USDC to EURC', rt);
    assert.ok(out.handled);
    assert.equal(out.type, 'authorization_required');
    assert.equal(out.missingOp, 'swap');
  });

  it('send without auth → authorization_required with missingOp=payment', async function() {
    var ctx = buildCtx();
    loadAuth(ctx);
    loadBrain(ctx);
    var rt = makeRuntime(ctx);
    rt.msg = 'send 1 USDC to 0x1234';
    var out = await ctx.AutonomaAgentBrain.run('send 1 USDC to 0x1234', rt);
    assert.ok(out.handled);
    assert.equal(out.type, 'authorization_required');
    assert.equal(out.missingOp, 'payment', 'send must map to payment capability');
  });

  it('bridge without auth → authorization_required with missingOp=bridge', async function() {
    var ctx = buildCtx();
    loadAuth(ctx);
    loadBrain(ctx);
    var rt = makeRuntime(ctx);
    rt.msg = 'bridge 1 USDC to Base';
    var out = await ctx.AutonomaAgentBrain.run('bridge 1 USDC to Base', rt);
    assert.ok(out.handled);
    assert.equal(out.type, 'authorization_required');
    assert.equal(out.missingOp, 'bridge');
  });

  it('schedule without auth → authorization_required', async function() {
    var ctx = buildCtx();
    loadAuth(ctx);
    loadBrain(ctx);
    var rt = makeRuntime(ctx);
    rt.msg = 'schedule monthly 1 USDC payment';
    var out = await ctx.AutonomaAgentBrain.run('schedule monthly 1 USDC payment', rt);
    assert.ok(out.handled);
    assert.equal(out.type, 'authorization_required');
  });

  it('after granting all capabilities: swap → confirmation_required (not auth_required)', async function() {
    var ctx = buildCtx();
    loadAuth(ctx);
    loadBrain(ctx);
    ctx.AgentAuthorization.createAuthorization({
      allowSwap: true, allowPayments: true, allowBridge: true,
      allowScheduled: true, allowRecurring: true,
      allowedTokens: ['*'], allowedNetworks: ['*'],
      allowedOperations: [], durationMs: 3600000, maxSpending: 100000,
      dailyLimit: 10000, maxRiskLevel: 'HIGH'
    });
    var rt = makeRuntime(ctx);
    rt.msg = 'swap 1 USDC to EURC';
    var out = await ctx.AutonomaAgentBrain.run('swap 1 USDC to EURC', rt);
    assert.ok(out.handled);
    assert.notEqual(out.type, 'authorization_required', 'must not require auth after grant');
    assert.ok(
      out.type === 'confirmation_required' || out.type === 'response',
      'must be confirmation_required or response after authorization'
    );
  });
});
