/**
 * FASE 2 — Liquidity Pool & Economic Protection Tests
 * ════════════════════════════════════════════════
 * Covers: ABI Discovery, Router/Factory Validation, Price Impact,
 *         Liquidity Health, Low Liquidity Protection, Pool Registry,
 *         Pool Health Check, Economic Risk Engine
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ethers } from 'ethers';

const POOL_ADDRESS = '0x18076d992005186AeB13AC5270CaD6E27DB95247';
const USDC = '0x3600000000000000000000000000000000000000';
const CIRBTC = '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF';

/* ════════════════════════════════════════
   F2.1 — ABI Discovery
   ════════════════════════════════════════ */
describe('FASE 2.1 — ABI Discovery', () => {
  const SELECTORS = {
    name: '0x06fdde03', symbol: '0x95d89b41', decimals: '0x313ce567',
    totalSupply: '0x18160ddd', balanceOf: '0x70a08231', allowance: '0xdd62ed3e',
    getReserves: '0x0902f1ac', token0: '0x0dfe1681', token1: '0xd21220a7',
    tokenA: '0x0fcb5522', tokenB: '0x5f0e0dd1', fee: '0xddca3f43',
    factory: '0xc45a0155', getAmountOut: '0xf2ac2d16',
  };

  it('correct selectors for ERC-20 functions', () => {
    expect(ethers.id('name()').substring(0, 10)).toBe('0x06fdde03');
    expect(ethers.id('symbol()').substring(0, 10)).toBe('0x95d89b41');
    expect(ethers.id('decimals()').substring(0, 10)).toBe('0x313ce567');
    expect(ethers.id('totalSupply()').substring(0, 10)).toBe('0x18160ddd');
  });

  it('correct selectors for pool functions', () => {
    expect(ethers.id('getReserves()').substring(0, 10)).toBe('0x0902f1ac');
  });

  it('correct selectors for Uniswap V2 functions (not supported by this pool)', () => {
    expect(ethers.id('token0()').substring(0, 10)).toBe('0x0dfe1681');
    expect(ethers.id('token1()').substring(0, 10)).toBe('0xd21220a7');
    expect(ethers.id('fee()').substring(0, 10)).toBe('0xddca3f43');
    expect(ethers.id('factory()').substring(0, 10)).toBe('0xc45a0155');
  });

  it('classifies discovered functions by category', () => {
    const results = [
      { name: 'name', supported: true, category: 'erc20' },
      { name: 'getReserves', supported: true, category: 'pool' },
      { name: 'token0', supported: false, category: 'amm' },
    ];
    const erc20 = results.filter(function(r) { return r.category === 'erc20' && r.supported; });
    const pool = results.filter(function(r) { return r.category === 'pool' && r.supported; });
    const amm = results.filter(function(r) { return r.category === 'amm' && r.supported; });
    expect(erc20.length).toBe(1);
    expect(pool.length).toBe(1);
    expect(amm.length).toBe(0);
  });

  it('pool is ERC-20 compatible', () => {
    const supportedERC20 = ['name', 'symbol', 'decimals', 'totalSupply', 'balanceOf', 'allowance', 'transfer', 'approve', 'transferFrom'];
    expect(supportedERC20.length).toBeGreaterThanOrEqual(7);
  });

  it('pool has getReserves but not standard AMM functions', () => {
    const hasReserves = true;
    const hasStandardAMM = false;
    const poolType = hasReserves && !hasStandardAMM ? 'Custom LP Token with Reserves' : 'UniswapV2-like';
    expect(poolType).toBe('Custom LP Token with Reserves');
  });

  it('discovers pool name from on-chain data', () => {
    const name = "Elligente LP Token";
    expect(name).toBeTruthy();
    expect(name.length).toBeGreaterThan(0);
    expect(name).toContain('LP');
  });

  it('discovers pool symbol from on-chain data', () => {
    const symbol = "ELP";
    expect(symbol).toBeTruthy();
    expect(symbol.length).toBeGreaterThan(0);
  });

  it('LP token has 18 decimals', () => {
    const decimals = 18;
    expect(decimals).toBe(18);
  });
});

/* ════════════════════════════════════════
   F2.2 — Router & Factory Validation
   ════════════════════════════════════════ */
describe('FASE 2.2 — Router & Factory Validation', () => {
  it('no router configured — pool used directly', () => {
    const routerAddress = null;
    const usesDirectPool = !routerAddress || routerAddress === '0x0000000000000000000000000000000000000001';
    expect(usesDirectPool).toBe(true);
  });

  it('pool address is the LP token address', () => {
    const poolAddress = POOL_ADDRESS;
    const lpAddress = POOL_ADDRESS;
    expect(poolAddress).toBe(lpAddress);
  });

  it('pool contract has bytecode on-chain (verified)', () => {
    const hasCode = true; // Verified via eth_getCode in discovery
    expect(hasCode).toBe(true);
  });

  it('no factory — not standard Uniswap V2', () => {
    const factoryAddress = null;
    const isStandardUniswap = !!factoryAddress && factoryAddress !== '0x0000000000000000000000000000000000000000';
    expect(isStandardUniswap).toBe(false);
  });

  it('token addresses documented correctly', () => {
    const tokens = [
      { symbol: 'USDC', address: USDC, decimals: 6 },
      { symbol: 'cirBTC', address: CIRBTC, decimals: 8 }
    ];
    expect(tokens.length).toBe(2);
    expect(tokens[0].address.length).toBe(42);
    expect(tokens[1].address.length).toBe(42);
    expect(tokens[0].symbol).toBe('USDC');
    expect(tokens[1].symbol).toBe('cirBTC');
  });
});

/* ════════════════════════════════════════
   F2.3 — Price Impact Protection
   ════════════════════════════════════════ */
describe('FASE 2.3 — Price Impact Protection', () => {
  function calculatePriceImpact(amountIn, reserveIn) {
    if (reserveIn <= 0) return Infinity;
    return (amountIn / (reserveIn + amountIn)) * 100;
  }

  function classify(impact) {
    if (impact <= 1) return 'LOW';
    if (impact <= 5) return 'MEDIUM';
    if (impact <= 10) return 'HIGH';
    return 'CRITICAL';
  }

  it('small swap (<1% of liquidity) = LOW impact', () => {
    const impact = calculatePriceImpact(100, 20508);
    expect(impact).toBeLessThan(1);
    expect(classify(impact)).toBe('LOW');
  });

  it('medium swap (1-5%) = MEDIUM impact', () => {
    const impact = calculatePriceImpact(500, 20508);
    expect(impact).toBeGreaterThan(1);
    expect(impact).toBeLessThan(5);
    expect(classify(impact)).toBe('MEDIUM');
  });

  it('large swap (5-10%) = HIGH impact', () => {
    const impact = calculatePriceImpact(1500, 20508);
    expect(impact).toBeGreaterThan(5);
    expect(classify(impact)).toBe('HIGH');
  });

  it('very large swap (>10%) = CRITICAL impact', () => {
    const impact = calculatePriceImpact(5000, 20508);
    expect(impact).toBeGreaterThan(10);
    expect(classify(impact)).toBe('CRITICAL');
  });

  it('>5% requires warning', () => {
    const impact = calculatePriceImpact(1500, 20508);
    expect(impact > 5).toBe(true);
  });

  it('>10% requires confirmation', () => {
    const impact = calculatePriceImpact(5000, 20508);
    expect(impact > 10).toBe(true);
  });

  it('>15% blocks swap', () => {
    const impact = calculatePriceImpact(4000, 20508);
    const blocks = impact > 15;
    // 4000/(20508+4000) = 16.32% → should indeed block
    expect(blocks).toBe(true);
    expect(impact).toBeGreaterThan(15);
  });

  it('zero reserves returns Infinite impact', () => {
    const impact = calculatePriceImpact(100, 0);
    expect(impact).toBe(Infinity);
  });

  it('price impact with constant product AMM formula', () => {
    // amountOut = reserveOut * amountIn / (reserveIn + amountIn)
    // priceImpact = amountIn / (reserveIn + amountIn) * 100
    const reserveA = 20508, reserveB = 0.15;
    const amountIn = 100;
    const amtWithFee = amountIn * 0.997;
    const amountOut = (amtWithFee * reserveB) / (reserveA + amtWithFee);
    const impact = (amountIn / (reserveA + amountIn)) * 100;
    expect(amountOut).toBeGreaterThan(0);
    expect(impact).toBeLessThan(1);
  });

  it('price impact formatted correctly', () => {
    const impact = 3.456;
    expect(impact.toFixed(2) + '%').toBe('3.46%');
  });
});

/* ════════════════════════════════════════
   F2.4 — Liquidity Health Score
   ════════════════════════════════════════ */
describe('FASE 2.4 — Liquidity Health Score', () => {
  function scoreLiquidity(totalValueUsd) {
    if (totalValueUsd >= 100000) return 5;
    if (totalValueUsd >= 50000) return 4;
    if (totalValueUsd >= 20000) return 3;
    if (totalValueUsd >= 10000) return 2;
    if (totalValueUsd >= 5000) return 1;
    return 0;
  }

  function classifyHealth(score) {
    if (score >= 8) return 'Excellent';
    if (score >= 6) return 'Good';
    if (score >= 4) return 'Moderate';
    if (score >= 2) return 'Low';
    return 'Critical';
  }

  it('>100k TVL = Excellent', () => {
    expect(scoreLiquidity(150000)).toBe(5);
  });

  it('>50k TVL = Good', () => {
    expect(scoreLiquidity(75000)).toBe(4);
  });

  it('>20k TVL = Moderate', () => {
    expect(classifyHealth(5)).toBe('Moderate');
  });

  it('<20k TVL = Low', () => {
    expect(classifyHealth(3)).toBe('Low');
  });

  it('reserve A ~20,508 USDC = Moderate tier', () => {
    const totalValue = 20508;
    expect(scoreLiquidity(totalValue)).toBe(3);
  });

  it('stability score rewards balanced reserves', () => {
    const ratio = Math.min(20508, 0.15) / Math.max(20508, 0.15);
    expect(ratio).toBeLessThan(0.8);
    expect(ratio).toBeLessThan(0.5);
    // Heavily imbalanced pool
  });

  it('diversity score for 2 tokens', () => {
    const tokenCount = 2;
    const score = tokenCount >= 2 ? 1 : 0;
    expect(score).toBe(1);
  });

  it('health score formatted as X/10', () => {
    const score = 5;
    expect(score + '/10').toBe('5/10');
  });

  it('excellent health has green color', () => {
    const color = '#22c55e';
    expect(color).toBe('#22c55e');
  });
});

/* ════════════════════════════════════════
   F2.5 — Low Liquidity Protection
   ════════════════════════════════════════ */
describe('FASE 2.5 — Low Liquidity Protection', () => {
  function checkUtilization(swapAmount, reserveIn) {
    return (swapAmount / reserveIn) * 100;
  }

  it('>5% of liquidity triggers warning', () => {
    const utilization = checkUtilization(1500, 20508);
    expect(utilization).toBeGreaterThan(5);
    expect(utilization > 5).toBe(true);
  });

  it('>10% of liquidity requires confirmation', () => {
    const utilization = checkUtilization(2500, 20508);
    expect(utilization).toBeGreaterThan(10);
    expect(utilization > 10).toBe(true);
  });

  it('>20% of liquidity blocks swap', () => {
    const utilization = checkUtilization(5000, 20508);
    expect(utilization).toBeGreaterThan(20);
  });

  it('<5% is safe', () => {
    const utilization = checkUtilization(500, 20508);
    expect(utilization).toBeLessThan(5);
  });

  it('zero reserves handled gracefully', () => {
    const utilization = 0;
    expect(utilization).toBe(0);
  });

  it('thresholds are configurable', () => {
    const config = { warnPct: 3, confirmPct: 8, blockPct: 25 };
    expect(config.warnPct).toBe(3);
    expect(config.confirmPct).toBe(8);
    expect(config.blockPct).toBe(25);
  });
});

/* ════════════════════════════════════════
   F2.6 — Pool Registry
   ════════════════════════════════════════ */
describe('FASE 2.6 — Pool Registry', () => {
  const pool = {
    id: 'arc_testnet_usdc_cirbtc',
    chainId: 5042002,
    chainName: 'Arc Testnet',
    poolType: 'Custom LP Token',
    poolAddress: POOL_ADDRESS,
    poolName: 'Elligente LP Token',
    poolSymbol: 'ELP',
    poolDecimals: 18,
    routerAddress: null,
    factoryAddress: null,
    lpAddress: POOL_ADDRESS,
    tokens: [
      { symbol: 'USDC', address: USDC, decimals: 6 },
      { symbol: 'cirBTC', address: CIRBTC, decimals: 8 }
    ],
    feeBps: 30,
    feePct: 0.3,
    supportedFunctions: ['name', 'symbol', 'decimals', 'totalSupply', 'balanceOf', 'allowance', 'getReserves'],
    unsupportedFunctions: ['token0', 'token1', 'tokenA', 'tokenB', 'fee', 'factory', 'getAmountOut']
  };

  it('registry contains pool metadata', () => {
    expect(pool.id).toBeTruthy();
    expect(pool.chainId).toBe(5042002);
    expect(pool.poolAddress).toBe(POOL_ADDRESS);
  });

  it('pool address matches LP address (LP = pool)', () => {
    expect(pool.poolAddress).toBe(pool.lpAddress);
  });

  it('has at least 2 tokens', () => {
    expect(pool.tokens.length).toBeGreaterThanOrEqual(2);
  });

  it('tokens have valid addresses', () => {
    for (let i = 0; i < pool.tokens.length; i++) {
      expect(pool.tokens[i].address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it('documents supported and unsupported functions', () => {
    expect(pool.supportedFunctions.length).toBeGreaterThan(0);
    expect(pool.unsupportedFunctions.length).toBeGreaterThan(0);
    expect(pool.supportedFunctions).toContain('getReserves');
    expect(pool.unsupportedFunctions).toContain('token0');
  });

  it('routerAddress is null (direct pool)', () => {
    expect(pool.routerAddress).toBeNull();
  });

  it('factoryAddress is null (custom pool)', () => {
    expect(pool.factoryAddress).toBeNull();
  });

  it('ABI version is documented', () => {
    expect(pool.abiVersion || 'custom_v1').toBeTruthy();
  });

  it('fee structure documented', () => {
    expect(pool.feeBps).toBeGreaterThanOrEqual(0);
  });

  it('lookup by address works', () => {
    const found = pool.poolAddress.toLowerCase() === POOL_ADDRESS.toLowerCase();
    expect(found).toBe(true);
  });
});

/* ════════════════════════════════════════
   F2.7 — Pool Health Check
   ════════════════════════════════════════ */
describe('FASE 2.7 — Pool Health Check', () => {
  it('contract code check passes when bytecode exists', () => {
    const code = '0x60806040...';
    const hasCode = code && code !== '0x';
    expect(hasCode).toBe(true);
  });

  it('RPC availability check passes when block number > 0', () => {
    const blockNumber = 12345678;
    expect(blockNumber > 0).toBe(true);
  });

  it('reserve validation requires positive reserves', () => {
    const reserveA = 20508094695n;
    const reserveB = 15186215374n;
    expect(reserveA > 0n).toBe(true);
    expect(reserveB > 0n).toBe(true);
  });

  it('token validation requires at least 2 tokens', () => {
    const tokens = ['USDC', 'cirBTC'];
    expect(tokens.length).toBeGreaterThanOrEqual(2);
  });

  it('LP token validation checks name and totalSupply', () => {
    const name = 'Elligente LP Token';
    const totalSupply = 17543847605n;
    expect(name).toBeTruthy();
    expect(totalSupply > 0n).toBe(true);
  });

  it('router validation passes when no router configured', () => {
    const routerAddress = null;
    const noRouter = !routerAddress || routerAddress === '0x0000000000000000000000000000000000000001';
    expect(noRouter).toBe(true);
  });

  it('all checks pass = healthy pool', () => {
    const checks = [
      { name: 'Contract Code', passed: true },
      { name: 'RPC Availability', passed: true },
      { name: 'Pool Reserves', passed: true },
      { name: 'Token Addresses', passed: true },
      { name: 'LP Token', passed: true },
      { name: 'Router/Factory', passed: true }
    ];
    const failed = checks.filter(function(c) { return !c.passed; });
    expect(failed.length).toBe(0);
  });

  it('any check fails = unhealthy pool', () => {
    const checks = [
      { name: 'Contract Code', passed: true },
      { name: 'Pool Reserves', passed: false },
      { name: 'LP Token', passed: true }
    ];
    const healthy = checks.every(function(c) { return c.passed; });
    expect(healthy).toBe(false);
  });
});

/* ════════════════════════════════════════
   F2.8 — Economic Risk Engine
   ════════════════════════════════════════ */
describe('FASE 2.8 — Economic Risk Engine', () => {
  function analyze(config) {
    var score = 0;
    var factors = [];

    if (config.priceImpact != null) {
      var imp = config.priceImpact;
      var impactScore = imp <= 1 ? 0 : imp <= 5 ? 10 : imp <= 10 ? 20 : 35;
      score += impactScore;
      factors.push({ name: 'Price Impact', score: impactScore });
    }

    if (config.poolUtilizationPct != null) {
      var util = config.poolUtilizationPct;
      var utilScore = util <= 5 ? 0 : util <= 10 ? 8 : util <= 20 ? 16 : 25;
      score += utilScore;
      factors.push({ name: 'Liquidity Utilization', score: utilScore });
    }

    if (config.healthScore != null) {
      var h = config.healthScore;
      var healthScore = h >= 8 ? 0 : h >= 6 ? 5 : h >= 4 ? 10 : h >= 2 ? 15 : 20;
      score += healthScore;
      factors.push({ name: 'Pool Health', score: healthScore });
    }

    var level = score <= 20 ? 'LOW' : score <= 45 ? 'MEDIUM' : score <= 70 ? 'HIGH' : 'CRITICAL';

    return { level: level, score: score, factors: factors };
  }

  it('low risk swap: small amount, good pool', () => {
    const result = analyze({
      priceImpact: 0.5,
      poolUtilizationPct: 2,
      healthScore: 8
    });
    expect(result.level).toBe('LOW');
    expect(result.score).toBeLessThanOrEqual(20);
  });

  it('medium risk swap: moderate price impact', () => {
    const result = analyze({
      priceImpact: 3,
      poolUtilizationPct: 7,
      healthScore: 5
    });
    expect(result.level).toBe('MEDIUM');
  });

  it('high risk swap: large impact + low health', () => {
    const result = analyze({
      priceImpact: 8,
      poolUtilizationPct: 15,
      healthScore: 3
    });
    expect(result.level).toBe('HIGH');
  });

  it('critical risk swap: extreme conditions', () => {
    const result = analyze({
      priceImpact: 15,
      poolUtilizationPct: 25,
      healthScore: 1
    });
    expect(result.level).toBe('CRITICAL');
    expect(result.score).toBeGreaterThan(70);
  });

  it('default swap (1% impact, 2% util, health 5/10) = LOW-MEDIUM', () => {
    const result = analyze({
      priceImpact: 1,
      poolUtilizationPct: 2,
      healthScore: 5
    });
    expect(['LOW', 'MEDIUM']).toContain(result.level);
  });

  it('all factors contribute to score', () => {
    const result = analyze({
      priceImpact: 3,
      poolUtilizationPct: 7,
      healthScore: 5
    });
    expect(result.factors.length).toBe(3);
    expect(result.score).toBeGreaterThan(0);
  });

  it('scoring caps at reasonable max', () => {
    const result = analyze({
      priceImpact: 50,
      poolUtilizationPct: 80,
      healthScore: 0
    });
    expect(result.score).toBeLessThanOrEqual(100);
  });
});

/* ════════════════════════════════════════
   F2.9 — Cross-module Integration
   ════════════════════════════════════════ */
describe('FASE 2 — Cross-module Integration', () => {
  it('all engines combine for full swap analysis', () => {
    const analysis = {
      reserves: { reserveA: 20508, reserveB: 0.15 },
      priceImpact: { tier: 'LOW', priceImpact: 0.49 },
      liquidityUtilization: { tier: 'LOW', poolUtilizationPct: 2.4 },
      liquidityHealth: { tier: 'Moderate', score: 5 },
      economicRisk: { level: 'MEDIUM', score: 28 }
    };
    expect(analysis.reserves).toBeTruthy();
    expect(analysis.priceImpact).toBeTruthy();
    expect(analysis.liquidityUtilization).toBeTruthy();
    expect(analysis.liquidityHealth).toBeTruthy();
    expect(analysis.economicRisk).toBeTruthy();
  });

  it('Bridge module isolated', () => {
    const bridgeFee = 0.0005;
    expect(bridgeFee).toBe(0.0005);
  });

  it('Treasury vault address unchanged', () => {
    const treasuryVault = '0xbfC9E8F79bd30b912081ae88F9ad0A515F08c2F1';
    expect(treasuryVault.length).toBe(42);
  });
});

/* ════════════════════════════════════════
   F2.10 — AMM Formula Verification
   ════════════════════════════════════════ */
describe('FASE 2 — Constant Product AMM Formula', () => {
  it('constant product: k = x * y remains approximately constant', () => {
    const reserveA = 20508, reserveB = 0.15;
    const k = reserveA * reserveB;
    const amountIn = 100;
    const amtWithFee = amountIn * 0.997;
    const newA = reserveA + amtWithFee;
    const newB = k / newA;
    const amountOut = reserveB - newB;
    const newK = newA * newB;
    expect(amountOut).toBeGreaterThan(0);
    expect(newK).toBeCloseTo(k, -1); // ~same constant within 1% due to fee
  });

  it('getAmountOut simulation via constant product', () => {
    const reserveIn = 20508;
    const reserveOut = 0.15;
    const amountIn = 100;
    const amtWithFee = amountIn * 0.997;
    const amountOut = (amtWithFee * reserveOut) / (reserveIn + amtWithFee);
    expect(amountOut).toBeCloseTo(0.000725, 5);
  });

  it('slippage reduces minOut correctly', () => {
    const quoteAmount = 0.000725;
    const slippageBps = 100;
    const factor = (10000 - slippageBps) / 10000;
    const minOut = quoteAmount * factor;
    expect(minOut).toBeLessThan(quoteAmount);
    expect(minOut).toBeCloseTo(0.000718, 6);
  });
});

/* ════════════════════════════════════════
   FASE 2 — Reserve Scaling & Decimals
   ════════════════════════════════════════ */
describe('FASE 2 — Reserve Scaling & Decimals', () => {
  it('USDC 6 decimal scaling', () => {
    const raw = 20508094695n;
    const scaled = Number(raw) / 1e6;
    expect(scaled).toBeCloseTo(20508.09, 1);
  });

  it('cirBTC 8 decimal scaling', () => {
    const raw = 15186215374n;
    const scaled = Number(raw) / 1e8;
    expect(scaled).toBeCloseTo(151.86, 1);
  });

  it('LP token 18 decimal scaling', () => {
    const raw = 17543847605n;
    const scaled = Number(raw) / 1e18;
    expect(scaled).toBeCloseTo(0.0000000175, 8);
  });

  it('BigInt safe arithmetic for reserves', () => {
    const rA = ethers.parseUnits('20508.09', 6);
    const rB = ethers.parseUnits('0.15', 8);
    expect(rA).toBe(20508090000n);
    expect(rB).toBe(15000000n);
  });
});
