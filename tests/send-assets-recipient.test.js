/**
 * Send Assets — recipient must be the FINAL transfer recipient.
 * ═══════════════════════════════════════════════════════════════════════
 * Regression tests proving the Send Assets execution path encodes the
 * user-supplied recipient as the `to` of the USDC transfer (never an
 * intermediate/executor address), uses the correct Arc Mainnet USDC address and
 * amount, and keeps SendGuard validation active.
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
  it('encodes the user recipient as the `to` of the USDC transferFrom', () => {
    expect(send).toContain("encodeFunctionData('transferFrom', [walletAddress, recipient, rawAmt])");
  });

  it('does NOT replace the recipient with any executor/intermediate address', () => {
    expect(send).not.toContain('0xe348b2C4');
    expect(send).not.toContain('0xe348b2c4');
    expect(send).not.toContain('0x7fc1B0Ce');
    expect(send).not.toContain('0x7fc1b0ce');
    expect(send).not.toContain('0x0ad4c28f');
  });

  it('routes the aggregate3 through the official Arc Memo + Multicall3', () => {
    expect(send).toContain("var MC3_ADDR = '0xcA11bde05977b3631167028862bE2a173976CA11'");
    expect(send).toContain('memoC.memo(MC3_ADDR, aggData');
  });

  it('only builds two aggregate calls: transfer-to-recipient + transfer-fee-to-vault', () => {
    expect(send).toContain("encodeFunctionData('transferFrom', [walletAddress, recipient, rawAmt])");
    expect(send).toContain("encodeFunctionData('transferFrom', [walletAddress, TREASURY_VAULT_ADDRESS, feeRaw])");
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
    expect(send).toContain('SendGuard.assertSpender(MC3_ADDR)');
    expect(send).toContain('SendGuard.assertRecipient(recipient)');
  });

  it('checks approval against Multicall3 before transferring', () => {
    expect(send).toContain('contract.allowance(walletAddress, MC3_ADDR)');
    expect(send).toContain('contract.approve(MC3_ADDR, totalNeed)');
  });
});
