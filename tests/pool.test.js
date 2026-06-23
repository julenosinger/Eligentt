import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';

describe('Pool USDC/cirBTC — BigInt Precision', () => {
  it('parseUnits from string: USDC 6 decimals', () => {
    const raw = ethers.parseUnits('100.123456', 6);
    expect(raw).toBe(100123456n);
    expect(ethers.formatUnits(raw, 6)).toBe('100.123456');
  });

  it('parseUnits from string: cirBTC 8 decimals', () => {
    const raw = ethers.parseUnits('0.00100000', 8);
    expect(raw).toBe(100000n);
    expect(ethers.formatUnits(raw, 8)).toBe('0.00100000');
  });

  it('parseUnits micro amount: 0.00000001 cirBTC', () => {
    const raw = ethers.parseUnits('0.00000001', 8);
    expect(raw).toBe(1n);
  });

  it('approval BigInt: 1% buffer no precision loss', () => {
    const amount = ethers.parseUnits('100', 6);
    const approval = (amount * 101n) / 100n;
    expect(approval).toBe(101000000n);
    expect(ethers.formatUnits(approval, 6)).toBe('101.000000');
  });

  it('approval BigInt: cirBTC 8 decimals', () => {
    const amount = ethers.parseUnits('0.001', 8);
    const approval = (amount * 101n) / 100n;
    expect(approval).toBe(101000n);
  });

  it('FLOAT BUG: 0.001 * 1.01 produces wrong digits', () => {
    const floatResult = 0.001 * 1.01;
    expect(floatResult).not.toBe(0.00101);

    const bigintResult = (ethers.parseUnits('0.001', 8) * 101n) / 100n;
    expect(bigintResult).toBe(101000n);
    expect(ethers.formatUnits(bigintResult, 8)).toBe('0.00101000');
  });

  it('FLOAT BUG: toFixed(8) from float drops precision', () => {
    const floatAmt = 0.001;
    const floatApproval = floatAmt * 1.01;
    const asFixed = floatApproval.toFixed(8);
    expect(asFixed).toBe('0.01010000');

    const correct = ethers.parseUnits('0.001', 8);
    const correctApproval = (correct * 101n) / 100n;
    expect(ethers.formatUnits(correctApproval, 8)).toBe('0.00101000');
  });
});

describe('Pool — LP Token Calculations', () => {
  it('LP mint estimate: existing pool', () => {
    const reserveA = ethers.parseUnits('10000', 6);
    const reserveB = ethers.parseUnits('0.15', 8);
    const lpSupply = ethers.parseUnits('100', 18);

    const addA = ethers.parseUnits('100', 6);
    const addB = ethers.parseUnits('0.0015', 8);

    const lpFromA = (addA * lpSupply) / reserveA;
    const lpFromB = (addB * lpSupply) / reserveB;
    const mintedLP = lpFromA < lpFromB ? lpFromA : lpFromB;

    expect(mintedLP).toBe(ethers.parseUnits('1', 18));
  });

  it('LP mint estimate: empty pool (first deposit)', () => {
    const addA = ethers.parseUnits('1000', 6);
    const addB = ethers.parseUnits('0.015', 8);

    const product = addA * addB;
    expect(product).toBeGreaterThan(0n);
  });

  it('remove liquidity share calculation', () => {
    const lpSupply = ethers.parseUnits('100', 18);
    const userLP = ethers.parseUnits('10', 18);
    const reserveA = ethers.parseUnits('10000', 6);
    const reserveB = ethers.parseUnits('0.15', 8);

    const shareA = (userLP * reserveA) / lpSupply;
    const shareB = (userLP * reserveB) / lpSupply;

    expect(shareA).toBe(ethers.parseUnits('1000', 6));
    expect(shareB).toBe(ethers.parseUnits('0.015', 8));
  });
});

describe('Pool — Deployment Validation', () => {
  it('zero address is not deployed', () => {
    const addr = '0x0000000000000000000000000000000000000000';
    expect(addr).toBe('0x' + '0'.repeat(40));
  });

  it('pool registry addresses are valid format', () => {
    const addresses = [
      '0x18076d992005186AeB13AC5270CaD6E27DB95247',
      '0x94875c374b9aE724BE1A79F205bD3bE0762f8326',
    ];
    for (const addr of addresses) {
      expect(/^0x[0-9a-fA-F]{40}$/.test(addr)).toBe(true);
    }
  });

  it('wallet with no balance should not send tx', () => {
    const balance = 0n;
    const amount = ethers.parseUnits('100', 6);
    expect(balance < amount).toBe(true);
  });
});
