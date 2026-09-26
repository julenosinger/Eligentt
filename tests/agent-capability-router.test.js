/**
 * Agent → Capability → Approval → Execution Flow Tests
 * ======================================================
 * Tests the new agent-first pipeline:
 *   Intent → Plan → Dynamic Surface → Approval → Execution → Result
 *
 * Tests verify:
 *  1. createSurface produces the correct proposal card HTML per capability
 *  2. approve() calls the execution engine (never auto-executes)
 *  3. cancel() clears the proposal (no execution)
 *  4. No financial operation executes without explicit approval
 *  5. Dynamic surfaces exist for Send, Swap, Bridge, Schedule, Batch, CrossChain
 *  6. Result cards are generated post-execution
 *  7. AutonomaAgentBrain flag is enabled
 *  8. Balance surface returns correct structure
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const routerSrc = fs.readFileSync(
  path.join(root, 'public', 'shared', 'agentCapabilityRouter.js'),
  'utf8'
);

// ── Minimal window / DOM shim ──────────────────────────────────────────────
function makeWindow() {
  const appendedMessages = [];
  const localStorage = (() => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    };
  })();

  return {
    localStorage,
    appendedMessages,
    // Minimal DOM shim (AgentCapabilityRouter uses querySelectorAll on aut-messages)
    document: {
      getElementById: (id) => {
        if (id === 'aut-messages') {
          return {
            querySelectorAll: () => [],
            appendChild: (d) => appendedMessages.push(d),
            scrollTop: 0,
            scrollHeight: 0,
          };
        }
        return null;
      },
      createElement: (tag) => ({
        className: '',
        innerHTML: '',
        firstElementChild: null,
        querySelector: () => null,
        querySelectorAll: () => [],
      }),
      querySelectorAll: () => [],
    },
    navigator: { clipboard: { writeText: () => {} } },
    autUI: null,
    showPage: null,
    walletAddress: '0xUserWallet000000000000000000000000000001',
    activeChainId: 5042,
    // Modules
    AutonomaCore: null,
    FinancialContext: null,
    AutonomaAgentBrain: null,
    AgentCapabilityRouter: undefined,
    // Capability router is loaded below
    performance: { now: () => Date.now() },
    // Node globals needed by the router IIFE
    setTimeout: (fn, ms) => { /* no-op in tests */ return 0; },
    clearTimeout: () => {},
  };
}

function loadRouter(win) {
  // vm.createContext makes win the global, but IIFE code uses 'window' as a name.
  // Assign window = the context object so self-references work.
  win.window = win;
  const ctx = vm.createContext(win);
  vm.runInContext(routerSrc, ctx);
  return win.AgentCapabilityRouter;
}

// ══════════════════════════════════════════════════════════════════════════════
describe('AgentCapabilityRouter — createSurface', () => {
  let win, router;

  beforeEach(() => {
    win = makeWindow();
    router = loadRouter(win);
  });

  it('exports the public API', () => {
    expect(router).toBeDefined();
    expect(typeof router.createSurface).toBe('function');
    expect(typeof router.approve).toBe('function');
    expect(typeof router.cancel).toBe('function');
    expect(typeof router.buildResultCard).toBe('function');
    expect(typeof router.buildBalanceSurface).toBe('function');
  });

  it('creates a SEND proposal card for SEND_PAYMENT intent', () => {
    const html = router.createSurface('SEND_PAYMENT', {
      amount: 50, token: 'USDC', address: '0xRecipient00000000000000000000000000000001', chain: 'Arc Mainnet'
    });
    expect(html).toContain('das-wrap');
    expect(html).toContain('SEND PROPOSAL');
    expect(html).toContain('50');
    expect(html).toContain('USDC');
    expect(html).toContain('Arc Mainnet');
    // Must have Approve and Cancel buttons (unescaped text inside button elements)
    expect(html).toContain('Approve & Send');
    expect(html).toContain('Cancel');
    // Must reference AgentCapabilityRouter.approve and .cancel (not auto-execute)
    expect(html).toContain('AgentCapabilityRouter.approve(');
    expect(html).toContain('AgentCapabilityRouter.cancel(');
  });

  it('creates a SWAP proposal card for SWAP_EXECUTE intent', () => {
    const html = router.createSurface('SWAP_EXECUTE', {
      amount: 100, token: 'USDC', toToken: 'EURC'
    });
    expect(html).toContain('das-wrap');
    expect(html).toContain('SWAP PROPOSAL');
    expect(html).toContain('100');
    expect(html).toContain('USDC');
    expect(html).toContain('EURC');
    expect(html).toContain('Approve & Swap');
    expect(html).toContain('AgentCapabilityRouter.approve(');
  });

  it('creates a BRIDGE proposal card for BRIDGE intent', () => {
    const html = router.createSurface('BRIDGE', {
      amount: 200, token: 'USDC', fromChain: 'Arc Mainnet', toChain: 'Base'
    });
    expect(html).toContain('das-wrap');
    expect(html).toContain('BRIDGE PROPOSAL');
    expect(html).toContain('200');
    expect(html).toContain('Base');
    expect(html).toContain('CCTP');
    expect(html).toContain('Approve & Bridge');
    expect(html).toContain('AgentCapabilityRouter.approve(');
  });

  it('creates a SCHEDULE proposal card for CREATE_SCHEDULE intent', () => {
    const html = router.createSurface('CREATE_SCHEDULE', {
      amount: 100, token: 'USDC', recurrence: 'weekly',
      address: '0xRecipient00000000000000000000000000000001', recipientName: 'João'
    });
    expect(html).toContain('das-wrap');
    expect(html).toContain('SCHEDULE PROPOSAL');
    expect(html).toContain('Weekly');
    expect(html).toContain('Approve & Schedule');
    expect(html).toContain('AgentCapabilityRouter.approve(');
  });

  it('creates a BATCH proposal card for MULTISEND intent', () => {
    const html = router.createSurface('MULTISEND', {
      amount: 5000, token: 'USDC', recipientCount: 100
    });
    expect(html).toContain('das-wrap');
    expect(html).toContain('BATCH PAYMENT PROPOSAL');
    expect(html).toContain('100');
    expect(html).toContain('5000');
    expect(html).toContain('Approve & Execute Batch');
  });

  it('creates a CROSS_CHAIN proposal card for CROSS_CHAIN intent', () => {
    const html = router.createSurface('CROSS_CHAIN', {
      amount: 75, token: 'USDC', toChain: 'Arbitrum',
      address: '0xRecipient00000000000000000000000000000001'
    });
    expect(html).toContain('das-wrap');
    expect(html).toContain('CROSS-CHAIN PROPOSAL');
    expect(html).toContain('Arbitrum');
    expect(html).toContain('Approve & Send Cross-Chain');
  });

  it('produces a generic proposal for unknown intents', () => {
    const html = router.createSurface('UNKNOWN_OP', { amount: 10, token: 'USDC' });
    expect(html).toContain('das-wrap');
    expect(html).toContain('Approve');
    expect(html).toContain('Cancel');
  });

  it('stores a proposal that can be retrieved by propId', () => {
    router.createSurface('SEND_PAYMENT', { amount: 50, token: 'USDC' });
    const propIds = Object.keys(router._proposals);
    expect(propIds.length).toBeGreaterThan(0);
    expect(propIds[0]).toMatch(/^prop_/);
  });

  it('proposal IDs are unique across multiple calls', () => {
    router.createSurface('SEND_PAYMENT', { amount: 10, token: 'USDC' });
    router.createSurface('SWAP_EXECUTE', { amount: 20, token: 'USDC' });
    router.createSurface('BRIDGE', { amount: 30, token: 'USDC' });
    const ids = Object.keys(router._proposals);
    const unique = new Set(ids);
    expect(unique.size).toBe(3);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('AgentCapabilityRouter — cancel (no execution)', () => {
  let win, router;
  const executionLog = [];

  beforeEach(() => {
    win = makeWindow();
    win.__autExecuteIntent = async (intent, params) => {
      executionLog.push({ intent, params });
      return '<div>executed</div>';
    };
    router = loadRouter(win);
    executionLog.length = 0;
  });

  it('cancel() removes the proposal without executing', () => {
    const html = router.createSurface('SEND_PAYMENT', { amount: 50, token: 'USDC' });
    const propId = Object.keys(router._proposals)[0];

    router.cancel(propId);

    // Proposal is removed
    expect(router._proposals[propId]).toBeUndefined();
    // Execution was never called
    expect(executionLog.length).toBe(0);
  });

  it('cancel() on a non-existent proposal is a no-op', () => {
    expect(() => router.cancel('prop_nonexistent_123')).not.toThrow();
    expect(executionLog.length).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('AgentCapabilityRouter — approve (routes to execution engine)', () => {
  let win, router;
  const executionLog = [];

  beforeEach(() => {
    win = makeWindow();
    executionLog.length = 0;
    router = loadRouter(win);
    // Wire up execution engine via runtime in proposal
    win.__autExecuteIntent = async (intent, params, msg) => {
      executionLog.push({ intent, params, msg });
      return '<div class="aut-rc">executed</div>';
    };
  });

  it('approve() calls the stored runtime.executeIntent (not auto-execute)', async () => {
    // Create surface with runtime.executeIntent wired
    const propId = (() => {
      router.createSurface('SEND_PAYMENT', { amount: 50, token: 'USDC' }, {
        executeIntent: win.__autExecuteIntent,
        msg: 'send 50 USDC'
      });
      return Object.keys(router._proposals)[0];
    })();

    await router.approve(propId);

    expect(executionLog.length).toBe(1);
    expect(executionLog[0].intent).toBe('SEND_PAYMENT');
    expect(executionLog[0].params.amount).toBe(50);
  });

  it('approve() removes the proposal from _proposals (no double-execution)', async () => {
    router.createSurface('SWAP_EXECUTE', { amount: 100, token: 'USDC', toToken: 'EURC' }, {
      executeIntent: win.__autExecuteIntent,
      msg: 'swap 100 USDC to EURC'
    });
    const propId = Object.keys(router._proposals)[0];

    await router.approve(propId);

    // Proposal is removed
    expect(router._proposals[propId]).toBeUndefined();

    // Approving the same propId again does not execute again
    await router.approve(propId);
    expect(executionLog.length).toBe(1); // still only 1 execution
  });

  it('approve() on expired/non-existent proposal does not call executeIntent', async () => {
    win.__autExecuteIntent = async (intent) => {
      executionLog.push(intent);
      return '';
    };
    await router.approve('prop_nonexistent_999');
    expect(executionLog.length).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('AgentCapabilityRouter — security: no auto-execution', () => {
  it('createSurface() does NOT call executeIntent', () => {
    const executed = [];
    const win = makeWindow();
    win.__autExecuteIntent = async (intent) => { executed.push(intent); return ''; };
    const router = loadRouter(win);

    // Creating surfaces for all capability types
    const capabilities = [
      ['SEND_PAYMENT',    { amount: 50,   token: 'USDC', address: '0x' + '1'.repeat(40) }],
      ['SWAP_EXECUTE',    { amount: 100,  token: 'USDC', toToken: 'EURC' }],
      ['BRIDGE',          { amount: 200,  token: 'USDC', fromChain: 'Arc', toChain: 'Base' }],
      ['CREATE_SCHEDULE', { amount: 100,  token: 'USDC', recurrence: 'weekly' }],
      ['MULTISEND',       { amount: 5000, token: 'USDC', recipientCount: 100 }],
      ['CROSS_CHAIN',     { amount: 75,   token: 'USDC', toChain: 'Arbitrum' }],
    ];

    for (const [intent, params] of capabilities) {
      router.createSurface(intent, params, { executeIntent: win.__autExecuteIntent });
    }

    // Zero executions — user MUST explicitly call approve()
    expect(executed.length).toBe(0);
  });

  it('HTML proposal card contains approve/cancel buttons but no inline execution call', () => {
    const win = makeWindow();
    const router = loadRouter(win);
    const html = router.createSurface('SEND_PAYMENT', { amount: 50, token: 'USDC' });

    // Must reference AgentCapabilityRouter.approve (user-triggered)
    expect(html).toContain('AgentCapabilityRouter.approve(');
    // Must NOT directly call executeIntent or showPage
    expect(html).not.toContain('_executeIntent(');
    expect(html).not.toContain('showPage(');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('AgentCapabilityRouter — buildResultCard', () => {
  let win, router;

  beforeEach(() => {
    win = makeWindow();
    router = loadRouter(win);
  });

  it('shows confirmed status with green color', () => {
    const html = router.buildResultCard('SEND_PAYMENT', { amount: 50, token: 'USDC' }, '0xabc123', 'confirmed');
    expect(html).toContain('das-result');
    expect(html).toContain('Completed');
    expect(html).toContain('var(--green)');
  });

  it('shows failed status with red color', () => {
    const html = router.buildResultCard('SWAP_EXECUTE', { amount: 100, token: 'USDC' }, null, 'failed');
    expect(html).toContain('Failed');
    expect(html).toContain('var(--red)');
  });

  it('shows pending status with yellow color', () => {
    const html = router.buildResultCard('BRIDGE', { amount: 200, token: 'USDC' }, '0xdef456', 'pending');
    expect(html).toContain('Pending');
    expect(html).toContain('var(--yellow)');
  });

  it('includes tx hash link when hash provided', () => {
    const hash = '0x' + 'a'.repeat(64);
    const html = router.buildResultCard('SEND_PAYMENT', { amount: 50, token: 'USDC' }, hash, 'confirmed');
    expect(html).toContain('explorer.arc.io/tx/');
    expect(html).toContain('das-result-tx');
  });

  it('no explorer link when hash is null', () => {
    const html = router.buildResultCard('SEND_PAYMENT', { amount: 50, token: 'USDC' }, null, 'confirmed');
    expect(html).not.toContain('explorer.arc.io');
  });

  it('shows swap summary with toToken', () => {
    const html = router.buildResultCard('SWAP_EXECUTE', { amount: 100, token: 'USDC', toToken: 'EURC' }, null, 'confirmed');
    expect(html).toContain('USDC');
    expect(html).toContain('EURC');
    expect(html).toContain('→');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('AgentCapabilityRouter — buildBalanceSurface', () => {
  // buildBalanceSurface is now async (queries CircleAgent first).
  // Tests await the Promise and check the resolved HTML string.

  it('returns a balance card even without connected wallet', async () => {
    const win = makeWindow();
    win.walletAddress = null;
    win.CircleAgent = null; // no Circle wallet configured
    const router = loadRouter(win);
    const html = await router.buildBalanceSurface();
    // Should return some HTML — either EOA section or fallback
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(0);
    // Fallback card or EOA card both contain 'wallet' (case-insensitive)
    expect(html.toLowerCase()).toContain('wallet');
  });

  it('shows USDC balance when CircleAgent has balances', async () => {
    const win = makeWindow();
    win.CircleAgent = {
      getStatus: async () => ({ walletAddress: '0xCA', wallet: { state: 'LIVE' } }),
      getBalance: async () => ({ tokenBalances: [
        { token: { symbol: 'USDC' }, amount: '1234.56' },
        { token: { symbol: 'EURC' }, amount: '500.00' }
      ]}),
      formatBalance: function(data) {
        const r = {};
        if (data && data.tokenBalances) data.tokenBalances.forEach(tb => { r[tb.token.symbol] = tb.amount; });
        return r;
      },
      getCachedAddress: () => '0xCA'
    };
    win.walletAddress = '0xUser000000000000000000000000000000000001';
    const router = loadRouter(win);
    const html = await router.buildBalanceSurface();
    expect(html).toContain('USDC');
    expect(html).toContain('EURC');
    // fmtUSDC formats 1234.56 as "1,234.56" — check for either format
    expect(html.includes('1234') || html.includes('1,234')).toBe(true);
    expect(html).toContain('Circle Agent Wallet');
    expect(html).toContain('CANONICAL');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('Agent Brain flag', () => {
  it('AUTONOMA_AGENT_BRAIN_ENABLED is set to true in index.html', () => {
    const htmlPath = path.join(root, 'public', 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    expect(html).toContain('window.AUTONOMA_AGENT_BRAIN_ENABLED = true');
  });

  it('agentCapabilityRouter.js script tag is present in index.html', () => {
    const htmlPath = path.join(root, 'public', 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    expect(html).toContain('agentCapabilityRouter.js');
  });

  it('Dynamic Action Surface CSS is present in index.html', () => {
    const htmlPath = path.join(root, 'public', 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    expect(html).toContain('.das-wrap');
    expect(html).toContain('.das-actions');
    expect(html).toContain('.das-btn.review');
    expect(html).toContain('.das-result');
  });

  it('Autonoma agent-first UI elements are present in index.html', () => {
    const htmlPath = path.join(root, 'public', 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    expect(html).toContain('aut-workspace-bar');
    expect(html).toContain('aut-agent-status');
    expect(html).toContain('aut-cap-chips');
    expect(html).toContain('Circle Agent');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('Intent → Plan → Surface pipeline (integration)', () => {
  it('SEND_PAYMENT with full params produces an approvable proposal', () => {
    const win = makeWindow();
    const router = loadRouter(win);
    const params = {
      amount: 100,
      token: 'USDC',
      address: '0x' + 'a'.repeat(40),
      chain: 'Arc Mainnet'
    };
    const html = router.createSurface('SEND_PAYMENT', params);
    // Proposal is stored
    expect(Object.keys(router._proposals).length).toBe(1);
    // HTML contains approve button
    expect(html).toContain('AgentCapabilityRouter.approve(');
    // Risk is LOW for 100 USDC
    expect(html).toContain('LOW RISK');
  });

  it('SEND_PAYMENT with high amount shows HIGH RISK badge', () => {
    const win = makeWindow();
    const router = loadRouter(win);
    const html = router.createSurface('SEND_PAYMENT', { amount: 50000, token: 'USDC' });
    expect(html).toContain('HIGH RISK');
  });

  it('BRIDGE proposal contains CCTP branding', () => {
    const win = makeWindow();
    const router = loadRouter(win);
    const html = router.createSurface('BRIDGE', {
      amount: 500, token: 'USDC', fromChain: 'Arc Mainnet', toChain: 'Ethereum'
    });
    expect(html).toContain('CCTP');
    expect(html).toContain('Ethereum');
  });

  it('SCHEDULE with weekly recurrence shows correct frequency label', () => {
    const win = makeWindow();
    const router = loadRouter(win);
    const html = router.createSurface('CREATE_SCHEDULE', {
      amount: 200, token: 'USDC', recurrence: 'weekly',
      recipientName: 'João'
    });
    expect(html).toContain('Weekly');
    expect(html).toContain('João');
  });

  it('approve() fallback opens capability page when executeIntent not available', async () => {
    const pagesOpened = [];
    const win = makeWindow();
    win.showPage = (page) => pagesOpened.push(page);
    win.__autExecuteIntent = undefined; // no executor
    const router = loadRouter(win);

    router.createSurface('SEND_PAYMENT', { amount: 50, token: 'USDC' }, {
      // No executeIntent — fallback path
    });
    const propId = Object.keys(router._proposals)[0];
    await router.approve(propId);

    // Fallback: page opened
    expect(pagesOpened).toContain('send');
  });
});
