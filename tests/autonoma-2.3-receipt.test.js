/**
 * Autonoma 2.3 — Premium conversational transaction receipt (presentation-only) guards.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

describe('Autonoma transaction receipt', () => {
  it('renders a borderless inline receipt (aut-receipt), no card wrapper', () => {
    expect(html).toContain('aut-receipt');
    // The receipt container has no background or border.
    expect(html).toMatch(/\.aut-receipt\{[^}]*display:flex/);
    expect(html).not.toMatch(/\.aut-receipt\{[^}]*border:/);
  });

  it('removed the legacy bordered "…Verified On-chain" card result', () => {
    expect(html).not.toContain('Payment Verified On-chain');
    expect(html).not.toContain('Swap Verified On-chain');
    expect(html).not.toContain('Bridge Verified On-chain');
    // New conversational titles present.
    expect(html).toContain("title: 'Payment confirmed'");
    expect(html).toContain("title: 'Swap confirmed'");
    expect(html).toContain("title: 'Bridge sent'");
  });

  it('_addAgentResultMsg no longer wraps in a card (no aut-rc / aut-msg-header)', () => {
    const fn = html.slice(html.indexOf('function _addAgentResultMsg'), html.indexOf('async function _agentGetGasParams'));
    expect(fn).not.toContain('aut-rc');
    expect(fn).not.toContain('aut-msg-header');
  });

  it('preserves transaction hash + explorer + copy actions', () => {
    expect(html).toContain('View on Arc Explorer');
    expect(html).toContain('Copy transaction hash');
    expect(html).toContain('_agentCopyHash');
    expect(html).toContain('navigator.clipboard');
    expect(html).toContain('explorer.arc.io/tx/');
  });

  it('shortens hashes/addresses for display while preserving full values', () => {
    expect(html).toContain('function _shortHash(');
    expect(html).toContain('function _shortAddr(');
    expect(html).toContain("_agentReceipt"); // uses shortened display + full copy
  });

  it('never hardcodes amounts/addresses (uses existing transaction data)', () => {
    // Receipt calls pass dynamic values (amount, dest, txHash), not literals.
    expect(html).toContain('amount: amount +');
    expect(html).toContain('recipient: dest');
    expect(html).toContain('txHash: lastTxHash');
  });
});
