/**
 * Fase 2.9 — Gateway as UBScreen operation source
 * Tests verify that:
 * - _ubSourceWallet accepts 'gateway'
 * - execSend routes to saExecGateway when source is gateway
 * - execSwap blocks with clear message when source is gateway
 * - execBridge blocks with clear message when source is gateway
 * - _ubInjectSourceSelector renders a Circle Gateway card
 * - _ubSetSource accepts 'gateway' and routes to UBScreen drawer
 * - enterUnifiedBalanceMode routes gateway source to UBScreen (not agent panel)
 * - GATEWAY_SPEND_BLOCKED guard is preserved inside saExecGateway
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const src = readFileSync(join(__dirname, '../index.html'), 'utf8');

// Helper: extract function body (bracket-balanced)
function extractFn(s, name) {
  const idx = s.indexOf('function ' + name);
  if (idx === -1) return '';
  let depth = 0, start = -1;
  for (let i = idx; i < Math.min(idx + 60000, s.length); i++) {
    if (s[i] === '{') { if (start === -1) start = i; depth++; }
    else if (s[i] === '}') { depth--; if (depth === 0 && start !== -1) return s.slice(start, i + 1); }
  }
  return '';
}

// ── GF29-1: _ubSourceWallet accepts 'gateway' ─────────────────────────────
describe('GF29-1 — _ubSourceWallet supports gateway', () => {
  it("let _ubSourceWallet = 'evm' | 'agent' | 'gateway'", () => {
    expect(src).toContain("// 'evm' | 'agent' | 'gateway'");
  });

  it('_ubSetSource maps gateway string to gateway', () => {
    const body = extractFn(src, '_ubSetSource');
    expect(body).toContain("'gateway'");
  });
});

// ── GF29-2: execSend gateway path ─────────────────────────────────────────
describe('GF29-2 — UBScreen.execSend gateway path', () => {
  // execSend is an inner function; find it via its unique context
  function getExecSend() {
    const idx = src.indexOf('async function execSend()');
    return src.slice(idx, idx + 5000);
  }

  it('checks _ubSourceWallet === gateway', () => {
    expect(getExecSend()).toContain("_ubSourceWallet === 'gateway'");
  });

  it('calls saExecGateway when source is gateway', () => {
    expect(getExecSend()).toContain('saExecGateway()');
  });

  it('does NOT call saExecuteSend from the gateway branch', () => {
    const block = getExecSend();
    // Find the gateway branch (before the EVM branch)
    const gwEnd = block.indexOf('// ── EVM Send path');
    const gwBranch = block.slice(0, gwEnd);
    expect(gwBranch).not.toContain('saExecuteSend');
  });

  it('calls saExecuteSend from the EVM branch (default path preserved)', () => {
    expect(getExecSend()).toContain('saExecuteSend()');
  });
});

// ── GF29-3: execSwap gateway block ────────────────────────────────────────
describe('GF29-3 — UBScreen.execSwap blocks gateway with clear message', () => {
  function getExecSwap() {
    const idx = src.indexOf('async function execSwap()');
    return src.slice(idx, idx + 5000);
  }

  it('checks _ubSourceWallet === gateway', () => {
    expect(getExecSwap()).toContain("_ubSourceWallet === 'gateway'");
  });

  it('returns early for gateway without calling executeSwap', () => {
    const block = getExecSwap();
    const gwEnd = block.indexOf('// ── EVM Send path') === -1
      ? block.indexOf("if (typeof SWP === 'undefined'")
      : block.indexOf('// ── EVM Send path');
    const gwBranch = block.slice(0, gwEnd);
    // The gateway branch must NOT proceed to executeSwap
    expect(gwBranch).not.toContain('executeSwap()');
  });

  it('shows a human-readable reason why gateway swap is blocked', () => {
    expect(getExecSwap()).toContain('EVM wallet');
    expect(getExecSwap()).toContain('Gateway funds cannot be used directly');
  });
});

// ── GF29-4: execBridge gateway block ──────────────────────────────────────
describe('GF29-4 — UBScreen.execBridge blocks gateway with clear message', () => {
  function getExecBridge() {
    const idx = src.indexOf('async function execBridge()');
    return src.slice(idx, idx + 6000);
  }

  it('checks _ubSourceWallet === gateway', () => {
    expect(getExecBridge()).toContain("_ubSourceWallet === 'gateway'");
  });

  it('returns early for gateway without calling executeBridgeOrTurbo', () => {
    const block = getExecBridge();
    const gwEnd = block.indexOf("if (typeof executeBridgeOrTurbo");
    const gwBranch = block.slice(0, gwEnd);
    expect(gwBranch).not.toContain('executeBridgeOrTurbo()');
  });

  it('shows a human-readable reason why gateway bridge is blocked', () => {
    expect(getExecBridge()).toContain('EVM wallet');
    expect(getExecBridge()).toContain('Gateway funds cannot be used directly');
  });
});

// ── GF29-5: _ubInjectSourceSelector renders Gateway card ─────────────────
describe('GF29-5 — _ubInjectSourceSelector renders Circle Gateway card', () => {
  const body = extractFn(src, '_ubInjectSourceSelector');

  it('renders a Circle Gateway card', () => {
    expect(body).toContain("'Circle Gateway'");
  });

  it('calls ubGetGatewayBalance for the card balance', () => {
    expect(body).toContain('ubGetGatewayBalance');
  });

  it("card key is 'gateway'", () => {
    expect(body).toContain("card('gateway'");
  });

  it("selected state checks _ubSourceWallet === 'gateway'", () => {
    expect(body).toContain("_ubSourceWallet === 'gateway'");
  });
});

// ── GF29-6: enterUnifiedBalanceMode routes gateway to UBScreen ───────────
describe('GF29-6 — enterUnifiedBalanceMode routes gateway to UBScreen', () => {
  const body = extractFn(src, 'enterUnifiedBalanceMode');

  it("includes 'gateway' in the UBScreen branch condition", () => {
    expect(body).toContain("_ubSourceWallet === 'gateway'");
  });

  it('does NOT route gateway source to _ubOpenAgentPanel', () => {
    // The agent-panel branch must not include gateway
    const agentBranchIdx = body.indexOf('_ubOpenAgentPanel');
    const gwCheckIdx = body.lastIndexOf("_ubSourceWallet === 'gateway'");
    // The gateway check (in the UBScreen branch condition) must appear BEFORE
    // the agent panel branch (i.e., gateway is handled by the UBScreen branch).
    expect(gwCheckIdx).toBeLessThan(agentBranchIdx);
  });
});

// ── GF29-7: GATEWAY_SPEND_BLOCKED guard still present ────────────────────
describe('GF29-7 — GATEWAY_SPEND_BLOCKED guard preserved', () => {
  const body = extractFn(src, 'saExecGateway');

  it('saExecGateway still checks GATEWAY_SPEND_BLOCKED', () => {
    expect(body).toContain('GATEWAY_SPEND_BLOCKED');
  });

  it('returns early when GATEWAY_SPEND_BLOCKED is truthy', () => {
    const blockIdx = body.indexOf('GATEWAY_SPEND_BLOCKED');
    // Include chars before the match to capture the 'if (' prefix
    const snippet  = body.slice(Math.max(0, blockIdx - 10), blockIdx + 60);
    expect(snippet).toMatch(/if\s*\(\s*GATEWAY_SPEND_BLOCKED\s*\)/);
  });
});

// ── GF29-8: _ubSetSource routing for gateway ──────────────────────────────
describe('GF29-8 — _ubSetSource routing for gateway', () => {
  const body = extractFn(src, '_ubSetSource');

  it('routes gateway source to UBScreen (not agent panel)', () => {
    // The condition must be evm || gateway for the UBScreen branch
    expect(body).toMatch(/_ubSourceWallet === 'evm'\s*\|\|\s*_ubSourceWallet === 'gateway'/);
  });
});
