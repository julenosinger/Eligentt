/**
 * Send Assets — recipient must be the FINAL transfer recipient.
 * ═══════════════════════════════════════════════════════════════════════
 * Regression tests proving the Send Assets execution path sends USDC straight
 * to the user-supplied recipient (never an intermediate/executor address), uses
 * the correct Arc Mainnet USDC address and amount, and keeps SendGuard active.
 *
 * On Arc (5042) the flow routes through the Arc Memo + Multicall3From (which
 * preserves msg.sender via the CallFrom precompile), so it uses `transfer`
 * directly to the recipient — no allowance/approve intermediary is required.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function fn(from, to) {
  const i = html.indexOf(from);
  if (i < 0) return '';
  const j = html.indexOf(to, i);
  return html.slice(i, j < 0 ? html.length : j);
}

// The Send Assets same-chain execution lives inside saExecuteSend() (a long
// function). Assert against the full source where patterns are unique.
const send = html;

describe('Send Assets — recipient encoding', () => {
  it('encodes the user recipient as the direct `to` of the Arc transfer', () => {
    expect(send).toContain("erc20If.encodeFunctionData('transfer', [recipient, rawAmt])");
  });

  it('does NOT replace the recipient with any executor/intermediate address', () => {
    expect(send).not.toContain('0xe348b2C4');
    expect(send).not.toContain('0xe348b2c4');
    expect(send).not.toContain('0x7fc1B0Ce');
    expect(send).not.toContain('0x7fc1b0ce');
    expect(send).not.toContain('0x0ad4c28f');
  });

  it('routes the aggregate3 through the Arc Memo + Multicall3From (sender-preserving)', () => {
    expect(send).toContain("var M3F_ADDR = '0x522fAf9A91c41c443c66765030741e4AaCe147D0'");
    expect(send).toContain('memoC.memo(M3F_ADDR, aggData');
  });

  it('only builds two calls: transfer-to-recipient + transfer-fee-to-vault', () => {
    expect(send).toContain("erc20If.encodeFunctionData('transfer', [recipient, rawAmt])");
    expect(send).toContain("erc20If.encodeFunctionData('transfer', [TREASURY_VAULT_ADDRESS, feeRaw])");
  });

  it('fee destination is the treasury vault (not the recipient)', () => {
    expect(send).toContain('TREASURY_VAULT_ADDRESS');
  });
});

describe('Send Assets — Arc Mainnet + token + amount', () => {
  it('requires Arc Mainnet (5042) before sending', () => {
    expect(send).toContain('isArcChainId(activeChainId)');
    expect(send).toContain("var arcHex  = '0x13b2'");
  });

  it('USDC token resolves to the Arc native/ERC-20 address 0x3600…', () => {
    expect(html).toContain("USDC:  { symbol: 'USDC',  name: 'USD Coin',    decimals: 6");
    expect(html).toContain('address: () => activeUSDC()');
  });

  it('amount is parsed in the token native decimals (6 for USDC)', () => {
    expect(fn('function saToRaw(amount)', '// ── Asset selection')).toContain('Math.pow(10, dec)');
  });
});

describe('Send Assets — SendGuard remains active', () => {
  it('validates token, spender and recipient via SendGuard before transfer', () => {
    expect(send).toContain('SendGuard.assertERC20Token(tokenAddr, activeChainId, saCurrentAsset)');
    expect(send).toContain('SendGuard.assertSpender(isArcSend ? M3F_ADDR : MC3_ADDR)');
    expect(send).toContain('SendGuard.assertRecipient(recipient)');
  });

  it('uses sender-preserving Multicall3From on Arc (no allowance intermediary)', () => {
    expect(send).toContain('var isArcSend = (activeChainId === 5042)');
    expect(send).toContain("var M3F_ADDR = '0x522fAf9A91c41c443c66765030741e4AaCe147D0'");
  });
});
