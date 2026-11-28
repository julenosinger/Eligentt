/**
 * capital-hub-native-execution.test.js
 * ═══════════════════════════════════════════════════════════════════════════
 * Phase 1.0.1D.2 — Capital Hub native execution wiring (source-level guards).
 *
 * Verifies that the Capital Hub's Send / Cross-chain / Withdraw now execute
 * natively through the existing `saExecGateway` engine (with explicit parameters,
 * no redirect to Send Assets), while Deposit is preserved (still a launcher).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html   = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const manage = fs.readFileSync(path.join(root, 'shared/capitalHubManage.js'), 'utf8');
const ui     = fs.readFileSync(path.join(root, 'shared/capitalHubUI.js'), 'utf8');

function fnOf(src, name) {
  const i = src.indexOf(name);
  return i === -1 ? '' : src.slice(i, i + 6000);
}

describe('Capital Hub — native execution wiring (Phase 1.0.1D.2)', () => {
  it('saExecGateway accepts explicit opts via arguments[0] (no DOM dependency)', () => {
    const fn = fnOf(html, 'async function saExecGateway()');
    expect(fn).toContain('var opts = arguments[0] || {}');
    expect(fn).toContain('opts.recipient');
    expect(fn).toContain('opts.amount');
    expect(fn).toContain('opts.destChainId');
    // Preserves the legacy DOM fallback.
    expect(fn).toContain("getElementById('sa-recipient')");
  });

  it('Manage Funds exposes a native executor that calls saExecGateway with explicit params', () => {
    expect(manage).toContain('UI.qaExec = async function (k)');
    expect(manage).toContain('saExecGateway({ recipient: recipient, amount: f.amount, asset: asset, chainId: srcChainId, destChainId: destChainId })');
    expect(manage).toContain("res.status === 'pending'");
    expect(manage).toContain("res.status === 'ambiguous'");
  });

  it('native quick-actions (send/crosschain/withdraw) use data-ch-exec; deposit stays a launcher', () => {
    expect(manage).toContain("var native = (k === 'send' || k === 'crosschain' || k === 'withdraw')");
    expect(manage).toContain('data-ch-exec="\' + k + \'"');
    expect(manage).toContain('data-ch-qa-open="\' + k + \'"'); // deposit/charge launcher preserved
  });

  it('the delegated listener dispatches data-ch-exec to UI.qaExec', () => {
    expect(ui).toContain('data-ch-exec');
    expect(ui).toContain("else if (t.hasAttribute('data-ch-exec') && UI.qaExec) UI.qaExec(t.getAttribute('data-ch-exec'))");
  });

  it('Deposit is preserved (still opens the existing deposit window, not native execution)', () => {
    expect(manage).toContain("k === 'deposit' ? 'deposit'");
    // Deposit is NOT in the native set.
    expect(manage).toContain("var native = (k === 'send' || k === 'crosschain' || k === 'withdraw')");
  });

  it('withdraw executes a Gateway transfer to the connected wallet (never reported as trustless)', () => {
    expect(manage).toContain("var recipient = (k === 'withdraw') ? w : (f.to === null ? w : f.to)");
    expect(manage).toContain('Not a trustless withdrawal');
  });

  it('the legacy flow does not block when identity is not required (P0.2)', () => {
    // _gwResolveIdemKey returns a benign local key when the endpoint says
    // identityNotRequired (coordinator disabled), never a hard error.
    const fn = fnOf(html, 'async function _gwResolveIdemKey()');
    expect(fn).toContain('identityNotRequired');
    expect(fn).toContain('return _gwNewLocalIdemKey()');
  });
});
