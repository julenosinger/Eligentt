/**
 * Autonoma 2 — Phase 2A Tests
 * Send tool: validation, approval flow, execution monitor, error cases.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Bootstrap DOM environment ────────────────────────────────────────────
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost' });
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;

// ─── Load A2SendTool ──────────────────────────────────────────────────────
const sendToolSrc = await import('fs').then(f =>
  f.readFileSync(new URL('../shared/autonoma2/tools/send.js', import.meta.url), 'utf8')
);
// Execute in window context
new Function('window', 'document', sendToolSrc)(global.window, global.document);
const A2SendTool = global.window.A2SendTool;

// ─── Load Autonoma2 modules ──────────────────────────────────────────────
const a2Src = await import('fs').then(f =>
  f.readFileSync(new URL('../shared/autonoma2/Autonoma2.js', import.meta.url), 'utf8')
);
// Mock Auth
global.window.Auth = { getSessionToken: () => 'test-token' };
// Mock fetch for LLM
global.fetch = vi.fn().mockResolvedValue({
  ok: true,
  status: 200,
  body: { getReader: () => ({ read: async () => ({ done: true }) }) }
});
new Function('window', 'document', 'localStorage', 'fetch', a2Src)(
  global.window, global.document, global.localStorage, global.fetch
);
const Autonoma2 = global.window.Autonoma2;

// ─── Mock context ─────────────────────────────────────────────────────────
function makeCtx(overrides) {
  return Object.assign({
    walletAddress: '0x1234567890123456789012345678901234567890',
    chainId: 5042,
    chainName: 'Arc Mainnet',
    circleWalletAddress: null,
    balances: { USDC: '100.0000', EURC: '50.0000', cirBTC: '0.001' },
    contacts: [{ name: 'João', address: '0xDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEf' }]
  }, overrides || {});
}

// ─── A2SendTool.validate ──────────────────────────────────────────────────

describe('A2SendTool.validate', () => {
  it('rejects amount = 0', async () => {
    var r = await A2SendTool.validate({ amount: 0, recipient: '0xDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEf' }, makeCtx());
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/amount/i);
  });

  it('rejects negative amount', async () => {
    var r = await A2SendTool.validate({ amount: -5, recipient: '0xDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEf' }, makeCtx());
    expect(r.ok).toBe(false);
  });

  it('rejects invalid recipient', async () => {
    var r = await A2SendTool.validate({ amount: 10, recipient: 'notanaddress' }, makeCtx());
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/recipient/i);
  });

  it('accepts valid 0x address', async () => {
    var r = await A2SendTool.validate({ amount: 10, recipient: '0xDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEf' }, makeCtx());
    expect(r.ok).toBe(true);
  });

  it('resolves contact name to address', async () => {
    var r = await A2SendTool.validate({ amount: 10, recipient: 'João' }, makeCtx());
    expect(r.ok).toBe(true);
    expect(r.resolved.recipient).toBe('0xDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEf');
  });

  it('rejects when no wallet connected', async () => {
    var r = await A2SendTool.validate({ amount: 10, recipient: '0xDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEf' }, makeCtx({ walletAddress: null }));
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/wallet/i);
  });

  it('rejects when balance insufficient', async () => {
    var r = await A2SendTool.validate({ amount: 200, recipient: '0xDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEf' }, makeCtx());
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/insufficient/i);
  });

  it('includes fee in total when checking balance', async () => {
    // Amount 99.8 + 0.2% fee = 99.9996 — just under 100, should pass
    var r = await A2SendTool.validate({ amount: 99.79, recipient: '0xDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEf' }, makeCtx());
    expect(r.ok).toBe(true);
  });

  it('rejects amount slightly over balance including fee', async () => {
    // 100 USDC + 0.2% fee = 100.2 > 100 balance
    var r = await A2SendTool.validate({ amount: 100, recipient: '0xDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEf' }, makeCtx());
    expect(r.ok).toBe(false);
  });

  it('normalizes token to USDC by default', async () => {
    var r = await A2SendTool.validate({ amount: 10, recipient: '0xDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEf' }, makeCtx());
    expect(r.resolved.token).toBe('USDC');
  });

  it('normalizes token EURC correctly', async () => {
    var r = await A2SendTool.validate({ amount: 10, recipient: '0xDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEf', token: 'eurc' }, makeCtx());
    expect(r.resolved.token).toBe('EURC');
  });

  it('normalizes network arc correctly', async () => {
    var r = await A2SendTool.validate({ amount: 10, recipient: '0xDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEf', network: 'Arc Mainnet' }, makeCtx());
    expect(r.resolved.network).toBe('arc');
  });

  it('normalizes network base correctly', async () => {
    var r = await A2SendTool.validate({ amount: 10, recipient: '0xDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEf', network: 'Base' }, makeCtx());
    expect(r.resolved.network).toBe('base');
  });
});

// ─── A2SendTool.execute — engine unavailable ──────────────────────────────

describe('A2SendTool.execute — engine unavailable', () => {
  beforeEach(() => {
    // Ensure saExecuteSend is not defined
    delete global.window.saExecuteSend;
  });

  it('returns ENGINE_UNAVAILABLE when saExecuteSend not loaded', async () => {
    var r = await A2SendTool.execute(
      { amount: 10, recipient: '0xDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEf' },
      makeCtx()
    );
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('ENGINE_UNAVAILABLE');
  });

  it('returns VALIDATION_FAILED before checking engine', async () => {
    var r = await A2SendTool.execute({ amount: -1, recipient: '0xDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEf' }, makeCtx());
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('VALIDATION_FAILED');
  });
});

// ─── A2SendTool.execute — engine mock ────────────────────────────────────

describe('A2SendTool.execute — engine mock', () => {
  beforeEach(() => {
    // Mock saExecuteSend to succeed
    global.window.saRecentTxs = [{ txHash: '0xabc123def456abc123def456abc123def456abc1', hash: '0xabc123def456abc123def456abc123def456abc1', amount: 10, token: 'USDC' }];
    global.window.saCurrentAsset = 'USDC';
    global.window.saExecuteSend = vi.fn().mockResolvedValue(undefined);
  });

  it('calls saExecuteSend and returns ok with txHash', async () => {
    var progress = [];
    var r = await A2SendTool.execute(
      { amount: 10, recipient: '0xDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEf', token: 'USDC', network: 'arc' },
      makeCtx(),
      function(p) { progress.push(p); }
    );
    expect(r.ok).toBe(true);
    expect(r.stage).toBe('COMPLETED');
    expect(r.txHash).toBe('0xabc123def456abc123def456abc123def456abc1');
    expect(window.saExecuteSend).toHaveBeenCalledOnce();
  });

  it('emits PREPARING and SUBMITTED progress events', async () => {
    var stages = [];
    await A2SendTool.execute(
      { amount: 10, recipient: '0xDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEf' },
      makeCtx(),
      function(p) { stages.push(p.stage); }
    );
    expect(stages).toContain('PREPARING');
    expect(stages).toContain('SUBMITTED');
    expect(stages).toContain('COMPLETED');
  });

  it('handles saExecuteSend rejection as CANCELLED when user rejects', async () => {
    global.window.saExecuteSend = vi.fn().mockRejectedValue(Object.assign(new Error('user rejected'), { code: 4001 }));
    var stages = [];
    var r = await A2SendTool.execute(
      { amount: 10, recipient: '0xDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEf' },
      makeCtx(),
      function(p) { stages.push(p.stage); }
    );
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('CANCELLED');
  });

  it('handles saExecuteSend rejection as FAILED for generic errors', async () => {
    global.window.saExecuteSend = vi.fn().mockRejectedValue(new Error('RPC timeout'));
    var r = await A2SendTool.execute(
      { amount: 10, recipient: '0xDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEf' },
      makeCtx()
    );
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('FAILED');
    expect(r.error).toMatch(/RPC timeout/);
  });

  it('never calls saExecuteSend if validation fails', async () => {
    global.window.saExecuteSend = vi.fn();
    await A2SendTool.execute({ amount: 0, recipient: '0xDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEf' }, makeCtx());
    expect(window.saExecuteSend).not.toHaveBeenCalled();
  });
});

// ─── Autonoma2 approval flow ──────────────────────────────────────────────

describe('Autonoma2 approval flow', () => {
  it('approveAction returns NO_PENDING_APPROVAL when nothing pending', async () => {
    var r = await Autonoma2.approveAction('nonexistent-id');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('NO_PENDING_APPROVAL');
  });

  it('cancelApproval returns ok:false when nothing pending', () => {
    var r = Autonoma2.cancelApproval('nonexistent');
    expect(r.ok).toBe(false);
  });

  it('handleConfirmCancel returns false when no pending approval', async () => {
    var conv = Autonoma2.newConversation();
    Autonoma2.setActive(conv.id);
    var r = await Autonoma2.handleConfirmCancel(conv.id, 'confirm');
    expect(r).toBe(false);
  });
});

// ─── ToolRegistry send registration ──────────────────────────────────────

describe('ToolRegistry send tool', () => {
  it('A2SendTool is marked requiresApproval=true', () => {
    expect(A2SendTool.requiresApproval).toBe(true);
  });

  it('A2SendTool is NOT read-only', () => {
    expect(A2SendTool.readOnly).toBeFalsy();
  });

  it('A2SendTool has required parameters: recipient, amount', () => {
    expect(A2SendTool.parameters.recipient).toBeDefined();
    expect(A2SendTool.parameters.amount).toBeDefined();
    expect(A2SendTool.parameters.recipient.required).toBe(true);
    expect(A2SendTool.parameters.amount.required).toBe(true);
  });
});

// ─── Security: no financial execution without approval ────────────────────

describe('Security: no execution without explicit approval', () => {
  it('execute returns VALIDATION_FAILED for empty recipient', async () => {
    var r = await A2SendTool.execute({ amount: 10, recipient: '' }, makeCtx());
    expect(r.ok).toBe(false);
  });

  it('execute returns VALIDATION_FAILED for zero amount', async () => {
    var r = await A2SendTool.execute({ amount: 0, recipient: '0xDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEf' }, makeCtx());
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('VALIDATION_FAILED');
  });

  it('Autonoma2.approveAction rejects mismatched executionId', async () => {
    var r = await Autonoma2.approveAction('wrong-id-xyz');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('NO_PENDING_APPROVAL');
  });
});
