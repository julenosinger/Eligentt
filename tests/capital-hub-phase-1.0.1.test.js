/**
 * Capital Hub Phase 1.0.1 — Gateway confirmation integrity + financial validation.
 *
 * P0 fixes covered:
 *   - _execGatewayMint must NOT report success without a receipt (tx hash is not
 *     confirmation); it returns a discriminated { status: 'confirmed'|'pending'|'failed' }.
 *   - saExecGateway validates amounts as strict decimal strings (no Number/parseFloat,
 *     no scientific notation) and rejects excessive precision instead of truncating.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function extract(name) {
  const m = html.match(new RegExp('function ' + name + '\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}'));
  return m ? m[0] : null;
}
// Full async function body via brace matching (preserves `async` + nested blocks).
function extractAsync(name) {
  const start = html.indexOf('function ' + name);
  if (start === -1) return null;
  const asyncStart = html.slice(start - 6, start).trim() === 'async' ? start - 6 : start;
  const braceStart = html.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(asyncStart, i + 1); }
  }
  return null;
}

describe('_execGatewayMint confirmation integrity', () => {
  const fn = extractAsync('_execGatewayMint');
  it('returns a discriminated result, never a bare tx hash as success', () => {
    expect(fn).toContain("return { status: 'confirmed', txHash: mintTxHash, receipt: receipt };");
    expect(fn).toContain("return { status: 'pending', txHash: mintTxHash };");
    expect(fn).toContain("return { status: 'failed', txHash: mintTxHash, receipt: receipt };");
    // No longer returns the raw hash.
    expect(fn).not.toMatch(/\n\s*return mintTxHash;\s*\n/);
  });

  it('uses POSITIVE success validation — only status 1/0x1 is confirmed (Gate E)', () => {
    expect(fn).toContain("receipt.status === 1 || receipt.status === '0x1'");
    // Confirmed is the positive branch; any other receipt (null/undefined/0x2) is pending.
    expect(fn).toContain("if (receipt.status === 1 || receipt.status === '0x1')");
  });

  it('treats a revert (status 0 / 0x0) as failed, not pending', () => {
    expect(fn).toContain("receipt.status === 0 || receipt.status === '0x0'");
  });

  it('treats a missing receipt after polling as pending (never success)', () => {
    // No receipt → the only fallthrough is the pending return (positive success
    // requires receipt.status 1/'0x1').
    expect(fn).toContain("return { status: 'pending', txHash: mintTxHash };");
  });

  it('the caller branches on status and never shows a pending hash as success', () => {
    const caller = html.slice(html.indexOf("mintResult = await _execGatewayMint"), html.indexOf('var mintResult;') === -1 ? html.indexOf('await _execGatewayMint') : html.indexOf('await _execGatewayMint'));
    expect(html).toContain("mintResult.status === 'confirmed'");
    expect(html).toContain("mintResult.status === 'pending'");
    expect(html).toContain('awaiting confirmation. Do not resubmit');
  });
});

describe('saExecGateway amount validation', () => {
  it('validates the amount as a strict decimal string (no Number/parseFloat)', () => {
    const fn = extractAsync('saExecGateway');
    expect(fn).toContain("var _amtStr = String(amt).trim();");
    expect(fn).toContain('/^\\d+(\\.\\d+)?$/.test(_amtStr)');
  });

  it('rejects excessive precision instead of silently truncating', () => {
    const fn = extractAsync('saExecGateway');
    expect(fn).toContain('fracPart.length > srcTokenCfg.decimals');
    expect(fn).toContain("error: 'amount_too_precise'");
  });

  it('still uses BigInt for the atomic conversion (no float)', () => {
    const fn = extractAsync('saExecGateway');
    expect(fn).toContain('10n ** BigInt(srcTokenCfg.decimals)');
    expect(fn).toContain('amtAtomic <= 0n');
  });

  it('validates the recipient EVM address and rejects the zero address', () => {
    const fn = extractAsync('saExecGateway');
    expect(fn).toContain('/^0x[0-9a-fA-F]{40}$/.test(recip)');
    expect(fn).toContain('zero_address');
    expect(fn).toContain('/^0x0{40}$/i.test(recip)');
  });

  it('uses BigInt exponentiation for the decimal scale (Gate F)', () => {
    const fn = extractAsync('saExecGateway');
    expect(fn).toContain('10n ** BigInt(srcTokenCfg.decimals)');
    expect(fn).not.toContain('BigInt(10 ** srcTokenCfg.decimals)');
  });

  it('pads the fractional part with padEnd, not a fixed 9-zero pad (Gate F)', () => {
    const fn = extractAsync('saExecGateway');
    expect(fn).toContain("fracPart.padEnd(srcTokenCfg.decimals, '0')");
    expect(fn).not.toContain("(fracPart + '000000000')");
  });
});

describe('saExecGateway secure proxy routing (Gate B)', () => {
  it('routes MAINNET submissions through /api/gateway/transfer (the secure proxy)', () => {
    const fn = extractAsync('saExecGateway');
    expect(fn).toContain("'/api/gateway/transfer'");
    expect(fn).toContain("var _transferUrl = _isTestnetChain ? (GW_API_BASE + '/v1/transfer') : '/api/gateway/transfer'");
  });

  it('keeps testnet on the direct Circle API (the proxy is mainnet-only)', () => {
    const fn = extractAsync('saExecGateway');
    expect(fn).toContain('_isTestnetChain');
    expect(fn).toContain('GW_TESTNET_CHAINS.indexOf(chainId) !== -1');
  });

  it('parses the array attestation response (not a bare object)', () => {
    const fn = extractAsync('saExecGateway');
    expect(fn).toContain("Array.isArray(respBody)");
    expect(fn).toContain('first.attestation.payload');
    expect(fn).toContain('first.attestation.signature');
  });

  it('maps proxy errors to the correct status (409 ambiguous, 503 fail-closed error, 5xx ambiguous)', () => {
    const fn = extractAsync('saExecGateway');
    expect(fn).toContain("resp.status === 409");
    expect(fn).toContain("error: 'already_submitted'");
    expect(fn).toContain("resp.status === 503");
    // 503 is fail-closed but NOT a 'blocked' status (Fase 2.9.4 removed it).
    expect(fn).toContain("error: proxyErr || 'persistence_unavailable'");
  });
});

// Behavioral: the exact decimal-string regex used for validation.
describe('decimal-string validation regex (behavioral)', () => {
  const re = /^\d+(\.\d+)?$/;
  it('accepts plain integers and decimals', () => {
    expect(re.test('0')).toBe(true);
    expect(re.test('12.345678')).toBe(true);
    expect(re.test('100')).toBe(true);
  });
  it('rejects scientific notation, signs, and malformed input', () => {
    expect(re.test('1e3')).toBe(false);
    expect(re.test('-1')).toBe(false);
    expect(re.test('+1')).toBe(false);
    expect(re.test('1.2.3')).toBe(false);
    expect(re.test('abc')).toBe(false);
    expect(re.test('')).toBe(false);
    expect(re.test(' 1')).toBe(false);
  });
});
