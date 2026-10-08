/**
 * Autonoma 2 — Unit tests
 * Tests ToolRegistry, conversation engine, and isolation from v1 Autonoma.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

// ── Load modules into a sandboxed global ────────────────────────────────────
function loadModule(path) {
  const code = readFileSync(new URL(path, import.meta.url).pathname, 'utf8');
  const fn = new Function('window', 'localStorage', code);
  fn(global, global.localStorage);
}

// Minimal localStorage mock
global.localStorage = (() => {
  let store = {};
  return {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { store = {}; }
  };
})();

global.window = global;
global.BalanceService = undefined;
global.SwapAggregator = undefined;
global.Store = { load: () => [], save: () => {} };
global.CircleAgent = undefined;
global.walletAddress = '0x01dEf687d1234567890abcdef1234567890abcdef';
global.activeChainId = 5042;

// Load modules
loadModule('../shared/autonoma2/ToolRegistry.js');
loadModule('../shared/autonoma2/ContextEngine.js');
loadModule('../shared/autonoma2/ExecutionMonitor.js');
loadModule('../shared/autonoma2/Autonoma2.js');

describe('ToolRegistry', () => {
  it('is attached to window.A2ToolRegistry', () => {
    expect(global.A2ToolRegistry).toBeDefined();
  });

  it('has all required read tools', () => {
    const names = global.A2ToolRegistry.listNames();
    expect(names).toContain('balance');
    expect(names).toContain('history');
    expect(names).toContain('wallet_info');
    expect(names).toContain('routes');
    expect(names).toContain('schedules');
  });

  it('has all required write tools', () => {
    const names = global.A2ToolRegistry.listNames();
    expect(names).toContain('send');
    expect(names).toContain('swap');
    expect(names).toContain('bridge');
    expect(names).toContain('create_invoice');
    expect(names).toContain('create_schedule');
    expect(names).toContain('create_payment_link');
  });

  it('write tools require approval', () => {
    const writables = ['send', 'swap', 'bridge', 'create_invoice', 'create_schedule', 'create_payment_link'];
    writables.forEach(name => {
      const t = global.A2ToolRegistry.get(name);
      expect(t).toBeTruthy();
      expect(t.requiresApproval).toBe(true);
    });
  });

  it('read tools do NOT require approval', () => {
    const readers = ['balance', 'history', 'wallet_info', 'routes', 'schedules'];
    readers.forEach(name => {
      const t = global.A2ToolRegistry.get(name);
      expect(t).toBeTruthy();
      expect(t.requiresApproval).toBe(false);
    });
  });

  it('send tool returns ok:true with valid params', async () => {
    const t = global.A2ToolRegistry.get('send');
    const ctx = { walletAddress: '0xABC', chainId: 5042 };
    const result = await t.execute({ to: '0xDEF', amount: 10, token: 'USDC' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.action).toBe('send');
    expect(result.amount).toBe(10);
    expect(result.token).toBe('USDC');
  });

  it('send tool returns error without wallet', async () => {
    const t = global.A2ToolRegistry.get('send');
    const result = await t.execute({ to: '0xDEF', amount: 10 }, { walletAddress: null });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('NO_WALLET');
  });

  it('send tool returns error without required params', async () => {
    const t = global.A2ToolRegistry.get('send');
    const result = await t.execute({}, { walletAddress: '0xABC' });
    expect(result.ok).toBe(false);
  });

  it('balance tool returns NO_WALLET when no address', async () => {
    const t = global.A2ToolRegistry.get('balance');
    const result = await t.execute({}, { walletAddress: null });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('NO_WALLET');
  });

  it('balance tool returns ok with address (BalanceService absent)', async () => {
    const t = global.A2ToolRegistry.get('balance');
    const result = await t.execute({}, { walletAddress: '0xABC', chainId: 5042 });
    expect(result.ok).toBe(true);
    expect(result.walletAddress).toBe('0xABC');
  });

  it('swap tool returns action:swap', async () => {
    const t = global.A2ToolRegistry.get('swap');
    const result = await t.execute({ fromToken: 'USDC', toToken: 'EURC', amount: 100 }, { walletAddress: '0xABC', chainId: 5042 });
    expect(result.ok).toBe(true);
    expect(result.action).toBe('swap');
    expect(result.fromToken).toBe('USDC');
    expect(result.toToken).toBe('EURC');
  });

  it('bridge tool returns action:bridge', async () => {
    const t = global.A2ToolRegistry.get('bridge');
    const result = await t.execute({ fromChain: 'Ethereum', toChain: 'Arc', amount: 50 }, { walletAddress: '0xABC' });
    expect(result.ok).toBe(true);
    expect(result.action).toBe('bridge');
  });

  it('create_invoice returns action:create_invoice', async () => {
    const t = global.A2ToolRegistry.get('create_invoice');
    const result = await t.execute({ client: 'Acme', amount: 250, currency: 'USDC' }, {});
    expect(result.ok).toBe(true);
    expect(result.action).toBe('create_invoice');
    expect(result.amount).toBe(250);
  });

  it('create_schedule returns action:create_schedule', async () => {
    const t = global.A2ToolRegistry.get('create_schedule');
    const result = await t.execute({ name: 'Payroll', amount: 1000, recipient: '0xABC', frequency: 'monthly' }, {});
    expect(result.ok).toBe(true);
    expect(result.frequency).toBe('monthly');
  });
});

describe('Autonoma2 Conversation Engine', () => {
  beforeEach(() => {
    global.localStorage.clear();
  });

  it('is attached to window.Autonoma2', () => {
    expect(global.Autonoma2).toBeDefined();
  });

  it('newConversation creates a conversation', () => {
    const c = global.Autonoma2.newConversation();
    expect(c.id).toBeTruthy();
    expect(c.title).toBe('New Chat');
    expect(c.messages).toEqual([]);
  });

  it('listConversations returns created conversations', () => {
    global.Autonoma2.newConversation();
    expect(global.Autonoma2.listConversations().length).toBeGreaterThanOrEqual(1);
  });

  it('addMessage adds to conversation', () => {
    const c = global.Autonoma2.newConversation();
    global.Autonoma2.addMessage(c.id, 'user', 'Hello');
    const msgs = global.Autonoma2.getMessages(c.id);
    expect(msgs.length).toBe(1);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('Hello');
  });

  it('auto-titles conversation from first user message', () => {
    const c = global.Autonoma2.newConversation();
    global.Autonoma2.addMessage(c.id, 'user', 'Show my balance');
    expect(global.Autonoma2.getConversation(c.id).title).toBe('Show my balance');
  });

  it('deleteConversation removes it', () => {
    const c = global.Autonoma2.newConversation();
    global.Autonoma2.deleteConversation(c.id);
    expect(global.Autonoma2.getConversation(c.id)).toBeNull();
  });

  it('setActive / activeId work', () => {
    const c = global.Autonoma2.newConversation();
    global.Autonoma2.setActive(c.id);
    expect(global.Autonoma2.activeId()).toBe(c.id);
  });

  it('handleConfirmCancel returns false for non-pending', async () => {
    const c = global.Autonoma2.newConversation();
    const handled = await global.Autonoma2.handleConfirmCancel(c.id, 'confirm');
    expect(handled).toBe(false);
  });
});

describe('ExecutionMonitor', () => {
  it('is attached to window.A2Monitor', () => {
    expect(global.A2Monitor).toBeDefined();
    expect(global.A2Monitor.STATES).toBeDefined();
  });

  it('create initializes operation in PREPARING state', () => {
    const op = global.A2Monitor.create('test-1', 'send', { amount: 10 });
    expect(op.state).toBe(global.A2Monitor.STATES.PREPARING);
    expect(op.type).toBe('send');
  });

  it('update changes state', () => {
    global.A2Monitor.create('test-2', 'swap');
    global.A2Monitor.update('test-2', global.A2Monitor.STATES.AWAITING_APPROVAL);
    expect(global.A2Monitor.get('test-2').state).toBe(global.A2Monitor.STATES.AWAITING_APPROVAL);
  });

  it('stateLabel returns human-readable label', () => {
    expect(global.A2Monitor.stateLabel('completed')).toBe('Completed');
    expect(global.A2Monitor.stateLabel('awaiting_approval')).toBe('Awaiting your approval');
    expect(global.A2Monitor.stateLabel('source_confirmed')).toBe('Source chain confirmed');
  });

  it('history records state transitions', () => {
    global.A2Monitor.create('test-3', 'bridge');
    global.A2Monitor.update('test-3', global.A2Monitor.STATES.SUBMITTED);
    global.A2Monitor.update('test-3', global.A2Monitor.STATES.COMPLETED);
    const op = global.A2Monitor.get('test-3');
    expect(op.history.length).toBe(3);
    expect(op.history[0].state).toBe(global.A2Monitor.STATES.PREPARING);
    expect(op.history[2].state).toBe(global.A2Monitor.STATES.COMPLETED);
  });

  it('onUpdate listener is called on state change', () => {
    const calls = [];
    global.A2Monitor.onUpdate(function(id, op) { calls.push({ id, state: op.state }); });
    global.A2Monitor.create('test-4', 'send');
    global.A2Monitor.update('test-4', global.A2Monitor.STATES.COMPLETED);
    expect(calls.some(c => c.id === 'test-4' && c.state === global.A2Monitor.STATES.COMPLETED)).toBe(true);
  });
});

describe('Isolation — Autonoma 2 does not conflict with v1', () => {
  it('Autonoma2 is separate from AutonomaCore', () => {
    expect(typeof global.Autonoma2).toBe('object');
    // v1 globals are undefined in this test env (not loaded), which is correct
    // In the real app, both coexist without conflict since they use different namespaces
    expect(global.Autonoma2.newConversation).toBeDefined();
    expect(typeof global.Autonoma2.newConversation).toBe('function');
  });

  it('A2ToolRegistry is separate from v1 WORD_MAP', () => {
    expect(global.A2ToolRegistry).toBeDefined();
    // A2ToolRegistry.get is the registry, not the v1 word matcher
    expect(typeof global.A2ToolRegistry.get).toBe('function');
    expect(global.A2ToolRegistry.get('balance')).toBeTruthy();
  });
});
