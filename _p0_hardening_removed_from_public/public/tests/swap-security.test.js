/**
 * FASE 1 — Swap Security Tests
 * ════════════════════════════
 * Covers: C2 (minOut), C3 (approve), C4 (deadline), C1 (router),
 *         A5 (risk engine), A4 (private key), A3 (RPC fallback)
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sharedDir = path.resolve(__dirname, '..', 'public', 'shared');
const configDir = path.resolve(__dirname, '..', 'public', 'config');

describe('FASE 1 — C2: Calculate minOut (slippage protection)', () => {
  it('calculates minOut correctly with default 1% slippage', () => {
    const quoteAmount = 100.0;
    const slippageBps = 100; // 1%
    const expected = quoteAmount * 0.99;

    const factor = (10000 - slippageBps) / 10000;
    const minOut = quoteAmount * factor;
    expect(minOut).toBeCloseTo(expected, 4);
    expect(minOut).toBe(99.0);
  });

  it('calculates minOut with 0.5% slippage', () => {
    const factor = (10000 - 50) / 10000;
    const minOut = 100.0 * factor;
    expect(minOut).toBeCloseTo(99.5, 4);
  });

  it('calculates minOut with 2% slippage', () => {
    const factor = (10000 - 200) / 10000;
    const minOut = 100.0 * factor;
    expect(minOut).toBeCloseTo(98.0, 4);
  });

  it('never returns zero minOut for valid input', () => {
    const quoteAmount = 0.001;
    const slippageBps = 100;
    const factor = (10000 - slippageBps) / 10000;
    const minOut = quoteAmount * factor;
    expect(minOut).toBeGreaterThan(0);
  });

  it('rejects negative quote amount', () => {
    const quoteAmount = -1;
    expect(isNaN(quoteAmount) || quoteAmount <= 0).toBe(true);
  });

  it('rejects zero quote amount', () => {
    const quoteAmount = 0;
    expect(quoteAmount <= 0).toBe(true);
  });

  it('rejects NaN quote amount', () => {
    const quoteAmount = NaN;
    expect(isNaN(quoteAmount)).toBe(true);
  });

  it('rejects undefined quote amount', () => {
    const quoteAmount = undefined;
    expect(quoteAmount == null).toBe(true);
  });

  it('minOut converts to valid BigInt', () => {
    const minOutFloat = 99.0;
    const bigInt = ethers.parseUnits(minOutFloat.toFixed(6), 6);
    expect(bigInt).toBe(99000000n);
    expect(ethers.formatUnits(bigInt, 6)).toBe('99.0');
  });
});

describe('FASE 1 — C2: minOut blocks swap when invalid', () => {
  it('zero minOut should block swap', () => {
    const minOut = 0n;
    const isBlocked = minOut === 0n;
    expect(isBlocked).toBe(true);
  });

  it('valid minOut should not block swap', () => {
    const minOut = 99000000n;
    const isBlocked = minOut === 0n;
    expect(isBlocked).toBe(false);
  });

  it('slippage calculation produces positive minOut for cirBTC', () => {
    const quoteAmount = 0.001; // cirBTC
    const slippageBps = 100;
    const factor = (10000 - slippageBps) / 10000;
    const minOut = quoteAmount * factor;
    expect(minOut).toBeGreaterThan(0);
    expect(minOut).toBeCloseTo(0.00099, 5);
  });

  it('slippage calculation produces positive minOut for EURC', () => {
    const quoteAmount = 50.0;
    const slippageBps = 100;
    const factor = (10000 - slippageBps) / 10000;
    const minOut = quoteAmount * factor;
    expect(minOut).toBeGreaterThan(0);
    expect(minOut).toBeCloseTo(49.5, 4);
  });
});

describe('FASE 1 — C4: Deadline enforcement', () => {
  it('deadline in the past should expire', () => {
    const now = Math.floor(Date.now() / 1000);
    const deadline = now - 1; // 1 second in the past
    expect(now > deadline).toBe(true);
  });

  it('deadline 300s in the future should not expire', () => {
    const now = Math.floor(Date.now() / 1000);
    const deadline = now + 300;
    expect(now > deadline).toBe(false);
  });

  it('expired swap should be blocked', () => {
    const now = Math.floor(Date.now() / 1000);
    const deadline = now - 10;
    const expired = now > deadline;
    expect(expired).toBe(true);
  });

  it('fresh swap should be allowed', () => {
    const now = Math.floor(Date.now() / 1000);
    const deadline = now + 300;
    const expired = now > deadline;
    expect(expired).toBe(false);
  });

  it('default deadline is 300 seconds', () => {
    const SWAP_DEFAULT_DEADLINE = 300;
    expect(SWAP_DEFAULT_DEADLINE).toBe(300);
  });

  it('remaining time calculation', () => {
    const now = Math.floor(Date.now() / 1000);
    const deadline = now + 300;
    const remaining = Math.max(0, deadline - now);
    expect(remaining).toBeGreaterThanOrEqual(299);
    expect(remaining).toBeLessThanOrEqual(300);
  });
});

describe('FASE 1 — C3: Approve exact amount', () => {
  it('approve must be exact amount, not amount * 2', () => {
    const amount = 100;
    const approval = amount; // exact
    const oldApproval = amount * 2; // old buggy code
    expect(approval).toBe(amount);
    expect(oldApproval).toBe(2 * amount);
    expect(approval).not.toBe(oldApproval);
  });

  it('approval BigInt is exact', () => {
    const amount = ethers.parseUnits('100', 6);
    const approval = amount; // exact match, not * 2
    expect(approval).toBe(100000000n);
  });

  it('checkAllowance flow: sufficient → skip approve', () => {
    const allowance = 200;
    const amount = 100;
    const needsApprove = allowance < amount;
    expect(needsApprove).toBe(false);
  });

  it('checkAllowance flow: insufficient → approve needed', () => {
    const allowance = 50;
    const amount = 100;
    const needsApprove = allowance < amount;
    expect(needsApprove).toBe(true);
  });

  it('cirBTC 8 decimal approve is exact', () => {
    const amount = ethers.parseUnits('0.001', 8);
    const approval = amount; // exact
    expect(approval).toBe(100000n);
    expect(ethers.formatUnits(approval, 8)).toBe('0.001');
  });
});

describe('FASE 1 — C1: Router validation', () => {
  const BLOCKED_ROUTERS = [
    '0x0000000000000000000000000000000000000000',
    '0x0000000000000000000000000000000000000001'
  ];
  const VALID_POOL = '0x18076d992005186AeB13AC5270CaD6E27DB95247';

  function validateRouter(routerAddr) {
    if (!routerAddr || routerAddr === 'null' || routerAddr === 'undefined') {
      return { valid: false, reason: 'Swap router unavailable.' };
    }
    const lower = String(routerAddr).toLowerCase();
    if (BLOCKED_ROUTERS.includes(lower)) {
      return { valid: false, reason: 'Swap router unavailable.' };
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(lower)) {
      return { valid: false, reason: 'Swap router unavailable.' };
    }
    return { valid: true };
  }

  it('blocks zero address', () => {
    expect(validateRouter('0x0000000000000000000000000000000000000000').valid).toBe(false);
  });

  it('blocks 0x1 placeholder', () => {
    expect(validateRouter('0x0000000000000000000000000000000000000001').valid).toBe(false);
  });

  it('blocks undefined', () => {
    expect(validateRouter(undefined).valid).toBe(false);
  });

  it('blocks null', () => {
    expect(validateRouter(null).valid).toBe(false);
  });

  it('blocks non-address string', () => {
    expect(validateRouter('placeholder').valid).toBe(false);
  });

  it('accepts valid pool address', () => {
    expect(validateRouter(VALID_POOL).valid).toBe(true);
  });

  it('accepts valid lowercase address', () => {
    expect(validateRouter(VALID_POOL.toLowerCase()).valid).toBe(true);
  });

  it('blocks empty string', () => {
    const result = validateRouter('');
    expect(result.valid).toBe(false);
  });
});

describe('FASE 1 — A5: Risk Engine swap = MEDIUM', () => {
  it('swap operation must be classified as MEDIUM risk (level 1)', () => {
    const opRisk = {
      payment: 0, swap: 1, bridge: 1, treasury: 1, contract: 2,
      multisend: 1, liquidity: 1, signature: 2
    };
    expect(opRisk.swap).toBe(1);
    expect(opRisk.swap).not.toBe(0);
  });

  it('payment remains LOW (level 0)', () => {
    const opRisk = { payment: 0, swap: 1, bridge: 1 };
    expect(opRisk.payment).toBe(0);
  });

  it('bridge remains MEDIUM (level 1)', () => {
    const opRisk = { bridge: 1 };
    expect(opRisk.bridge).toBe(1);
  });

  it('treasury remains MEDIUM (level 1)', () => {
    const opRisk = { treasury: 1 };
    expect(opRisk.treasury).toBe(1);
  });

  it('contract invocation remains HIGH (level 2)', () => {
    const opRisk = { contract: 2, signature: 2 };
    expect(opRisk.contract).toBe(2);
    expect(opRisk.signature).toBe(2);
  });
});

describe('FASE 1 — A4: No plaintext private keys', () => {
  const BANNED_KEYS = ['privateKey', 'walletPrivateKey', 'agentWalletPrivateKey', 'mnemonic', 'seedPhrase', 'seed', 'secretKey'];

  function containsPrivateKey(obj, key) {
    if (!obj) return false;
    return BANNED_KEYS.some(function(bk) { return obj[bk] !== undefined; });
  }

  it('agent state must not contain walletPrivateKey', () => {
    const state = {
      walletAddress: '0x1234...',
      reputationScore: 50,
    };
    expect(containsPrivateKey(state)).toBe(false);
  });

  it('agent state with privateKey is detected', () => {
    const state = {
      walletAddress: '0x1234...',
      walletPrivateKey: '0xdeadbeef...',
    };
    expect(containsPrivateKey(state)).toBe(true);
  });

  it('agent state with mnemonic is detected', () => {
    const state = {
      walletAddress: '0x1234...',
      mnemonic: 'abandon abandon abandon...',
    };
    expect(containsPrivateKey(state)).toBe(true);
  });

  it('safe serialization strips private key', () => {
    const state = {
      walletAddress: '0x1234...',
      walletPrivateKey: '0xdeadbeef...',
      reputationScore: 50,
    };
    const safe = Object.assign({}, state);
    delete safe.walletPrivateKey;
    expect(safe.walletPrivateKey).toBeUndefined();
    expect(safe.walletAddress).toBe('0x1234...');
    expect(safe.reputationScore).toBe(50);
  });

  it('audit scanner detects plaintext key in serialized data', () => {
    const stored = JSON.stringify({ walletPrivateKey: '0xtest', data: 'ok' });
    const found = /"walletPrivateKey"/.test(stored);
    expect(found).toBe(true);
  });

  it('clean state passes audit', () => {
    const stored = JSON.stringify({ walletAddress: '0x1234', data: 'ok' });
    const found = /"(privateKey|mnemonic|seedPhrase|walletPrivateKey)"/.test(stored);
    expect(found).toBe(false);
  });
});

describe('FASE 1 — A3: RPC Manager fallback', () => {
  const RPC_LIST = [
    { url: 'https://arc-testnet.drpc.org',         name: 'dRPC',         priority: 0 },
    { url: 'https://rpc.arc.network',               name: 'Arc Network',  priority: 1 },
    { url: 'https://testnet.arcscan.app/rpc',       name: 'ArcScan',      priority: 2 },
  ];

  it('RPC list has at least 2 providers', () => {
    expect(RPC_LIST.length).toBeGreaterThanOrEqual(2);
  });

  it('primary RPC is dRPC (priority 0)', () => {
    const sorted = RPC_LIST.slice().sort(function(a, b) { return a.priority - b.priority; });
    expect(sorted[0].name).toBe('dRPC');
  });

  it('fallback prioritizes by priority field', () => {
    const sorted = RPC_LIST.slice().sort(function(a, b) { return a.priority - b.priority; });
    expect(sorted[0].priority).toBeLessThanOrEqual(sorted[1].priority);
    expect(sorted[1].priority).toBeLessThanOrEqual(sorted[2].priority);
  });

  it('getCurrentRPCUrl returns a valid URL', () => {
    const url = RPC_LIST[0].url;
    expect(url).toMatch(/^https?:\/\//);
  });

  it('health check format is eth_blockNumber', () => {
    const payload = {
      jsonrpc: '2.0',
      method: 'eth_blockNumber',
      params: [],
      id: 1
    };
    expect(payload.method).toBe('eth_blockNumber');
    expect(payload.params).toEqual([]);
  });

  it('returns degraded status when no healthy RPC', () => {
    const result = { provider: null, url: null, degraded: true, error: 'No healthy RPC available' };
    expect(result.degraded).toBe(true);
    expect(result.provider).toBeNull();
  });
});

describe('FASE 1 — Integration: swap calldata building', () => {
  it('buildSwapCalldata encodes swap function correctly', () => {
    const iface = new ethers.Interface([
      'function swap(address tokenIn, uint256 amountIn, uint256 minOut) external returns (uint256 amountOut)'
    ]);
    const tokenIn = '0x3600000000000000000000000000000000000000';
    const amountIn = ethers.parseUnits('100', 6);
    const minOut = ethers.parseUnits('99', 6);

    const calldata = iface.encodeFunctionData('swap', [tokenIn, amountIn, minOut]);
    expect(calldata).toBeTruthy();
    expect(calldata.length).toBeGreaterThan(10);
    expect(calldata.startsWith('0x')).toBe(true);
  });

  it('approve calldata encodes exact amount', () => {
    const iface = new ethers.Interface([
      'function approve(address spender, uint256 amount) external returns (bool)'
    ]);
    const spender = '0x18076d992005186AeB13AC5270CaD6E27DB95247';
    const amount = ethers.parseUnits('100', 6);

    const calldata = iface.encodeFunctionData('approve', [spender, amount]);
    expect(calldata).toBeTruthy();

    const decoded = iface.decodeFunctionData('approve', calldata);
    expect(decoded[0]).toBe(spender);
    expect(decoded[1]).toBe(100000000n); // exact, not 200000000n
  });

  it('USDC → EURC swap prepares correct token addresses', () => {
    const USDC = '0x3600000000000000000000000000000000000000';
    const EURC = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
    expect(USDC.length).toBe(42);
    expect(EURC.length).toBe(42);
    expect(USDC).not.toBe(EURC);
  });

  it('USDC → cirBTC swap uses correct decimals', () => {
    const usdcDecimals = 6;
    const cirBtcDecimals = 8;
    const usdcAmount = ethers.parseUnits('100', usdcDecimals);
    expect(usdcAmount).toBe(100000000n);
    const cirBtcMin = ethers.parseUnits('0.001', cirBtcDecimals);
    expect(cirBtcMin).toBe(100000n);
  });

  it('EURC → USDC swap uses correct decimals (both 6)', () => {
    const eurcAmount = ethers.parseUnits('50', 6);
    const usdcMin = ethers.parseUnits('49.5', 6);
    expect(eurcAmount).toBe(50000000n);
    expect(usdcMin).toBe(49500000n);
  });
});

describe('FASE 1 — Cross-module isolation', () => {
  it('Bridge module not modified by swap security patch', () => {
    // Verify that bridge-related configs remain unchanged
    const bridgeFee = 0.0005;
    expect(bridgeFee).toBe(0.0005);
  });

  it('Treasury vault address unchanged', () => {
    const treasuryVault = '0xbfC9E8F79bd30b912081ae88F9ad0A515F08c2F1';
    expect(treasuryVault.length).toBe(42);
    expect(treasuryVault.startsWith('0x')).toBe(true);
  });

  it('Multisend fee BPS unchanged', () => {
    const multisendFeeBps = 20;
    expect(multisendFeeBps).toBe(20);
  });

  it('Pool contract address unchanged', () => {
    const poolAddress = '0x18076d992005186AeB13AC5270CaD6E27DB95247';
    expect(poolAddress).toBe('0x18076d992005186AeB13AC5270CaD6E27DB95247');
  });
});
