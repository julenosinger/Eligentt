import { describe, it, expect } from 'vitest';
import { generateMemo, parseMemo, validateMemo, MEMO_PREFIX } from '../functions/api/memo.mjs';

describe('Multi-Application — on-chain memo (backward compatible expansion)', () => {
  it('emits the exact legacy 5-field memo when no app/client provided', () => {
    const memo = generateMemo('REPAY', 'INT-123', 'usdc', 100);
    expect(memo).toBe('ELLIGENTE|REPAY|INT-123|USDC|100');
  });

  it('appends Application + Client while keeping the first 5 fields identical', () => {
    const legacy = generateMemo('REPAY', 'INT-123', 'usdc', 100);
    const expanded = generateMemo('REPAY', 'INT-123', 'usdc', 100, 'EXECDAAT', 'acme');
    expect(expanded).toBe('ELLIGENTE|REPAY|INT-123|USDC|100|EXECDAAT|acme');
    expect(expanded.startsWith(legacy)).toBe(true);
    expect(expanded.split('|').slice(0, 5)).toEqual(legacy.split('|'));
  });

  it('defaults the appended fields to ELLIGENT / default', () => {
    const memo = generateMemo('REPAY', 'INT-9', 'usdc', 5, undefined, 'x');
    expect(memo).toBe('ELLIGENTE|REPAY|INT-9|USDC|5|ELLIGENT|x');
    const memo2 = generateMemo('REPAY', 'INT-9', 'usdc', 5, 'EXECDAAT', undefined);
    expect(memo2).toBe('ELLIGENTE|REPAY|INT-9|USDC|5|EXECDAAT|default');
  });

  it('parses a LEGACY memo → ELLIGENT / default attribution', () => {
    const parsed = parseMemo('ELLIGENTE|REPAY|INT-123|USDC|100');
    expect(parsed).toMatchObject({
      action: 'REPAY', intentId: 'INT-123', asset: 'USDC', amount: 100,
      application: 'ELLIGENT', client: 'default',
    });
  });

  it('parses an EXPANDED memo → correct attribution', () => {
    const parsed = parseMemo('ELLIGENTE|REPAY|INT-123|USDC|100|EXECDAAT|acme');
    expect(parsed.application).toBe('EXECDAAT');
    expect(parsed.client).toBe('acme');
    expect(parsed.amount).toBe(100);
  });

  it('round-trips generate → parse', () => {
    const parsed = parseMemo(generateMemo('BRIDGE', 'INT-77', 'eurc', 42.5, 'EXECDAAT', 'partner'));
    expect(parsed.action).toBe('BRIDGE');
    expect(parsed.asset).toBe('EURC');
    expect(parsed.amount).toBe(42.5);
    expect(parsed.application).toBe('EXECDAAT');
    expect(parsed.client).toBe('partner');
  });

  it('validates both legacy and expanded memos', () => {
    expect(validateMemo('ELLIGENTE|REPAY|INT-1|USDC|100')).toBe(true);
    expect(validateMemo('ELLIGENTE|REPAY|INT-1|USDC|100|EXECDAAT|acme')).toBe(true);
  });

  it('rejects malformed / non-elligente memos', () => {
    expect(validateMemo('SOMETHING|REPAY|INT-1|USDC|100')).toBe(false);
    expect(validateMemo('ELLIGENTE|REPAY|INT-1|USDC')).toBe(false);
    expect(validateMemo('ELLIGENTE|NOPE|INT-1|USDC|100')).toBe(false);
    expect(validateMemo('ELLIGENTE|REPAY||USDC|100')).toBe(false);
    expect(validateMemo('ELLIGENTE|REPAY|INT-1|USDC|-5')).toBe(false);
    expect(parseMemo('not-a-memo')).toBeNull();
    expect(parseMemo(null)).toBeNull();
  });

  it('exposes the ELLIGENTE prefix unchanged', () => {
    expect(MEMO_PREFIX).toBe('ELLIGENTE');
  });
});
