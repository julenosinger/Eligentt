import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';

describe('USDC Fee Calculation (BigInt precision)', () => {
  const USDC_DECIMALS = 6;

  it('calculates 2% fee correctly for 100 USDC', () => {
    const amount = ethers.parseUnits('100', USDC_DECIMALS);
    const feeBps = 200n;
    const fee = (amount * feeBps) / 10000n;
    expect(fee).toBe(ethers.parseUnits('2', USDC_DECIMALS));
  });

  it('calculates 0.2% fee correctly for 1000 USDC', () => {
    const amount = ethers.parseUnits('1000', USDC_DECIMALS);
    const feeBps = 20n;
    const fee = (amount * feeBps) / 10000n;
    expect(fee).toBe(ethers.parseUnits('2', USDC_DECIMALS));
  });

  it('handles small amounts without precision loss', () => {
    const amount = ethers.parseUnits('0.01', USDC_DECIMALS);
    const feeBps = 200n;
    const fee = (amount * feeBps) / 10000n;
    expect(fee).toBe(ethers.parseUnits('0.0002', USDC_DECIMALS));
  });

  it('handles large amounts correctly', () => {
    const amount = ethers.parseUnits('999999.999999', USDC_DECIMALS);
    const feeBps = 100n;
    const fee = (amount * feeBps) / 10000n;
    const total = amount + fee;
    expect(total).toBeGreaterThan(amount);
    expect(ethers.formatUnits(fee, USDC_DECIMALS)).toBe('9999.999999');
  });

  it('total = amount + fee without floating point drift', () => {
    const amount = ethers.parseUnits('33.33', USDC_DECIMALS);
    const feeBps = 200n;
    const fee = (amount * feeBps) / 10000n;
    const total = amount + fee;
    expect(total).toBe(amount + fee);
    expect(ethers.formatUnits(total, USDC_DECIMALS)).toBe('33.996600');
  });

  it('parseUnits/formatUnits roundtrip is lossless', () => {
    const values = ['0.000001', '1.000000', '123456.789012', '999999.999999'];
    for (const v of values) {
      const raw = ethers.parseUnits(v, USDC_DECIMALS);
      const formatted = ethers.formatUnits(raw, USDC_DECIMALS);
      expect(formatted).toBe(v);
    }
  });

  it('cirBTC 8 decimals precision', () => {
    const amount = ethers.parseUnits('0.5', 8);
    const feeBps = 100n;
    const fee = (amount * feeBps) / 10000n;
    expect(ethers.formatUnits(fee, 8)).toBe('0.00500000');
  });
});
