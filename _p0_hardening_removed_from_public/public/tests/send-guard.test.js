/**
 * SEND GUARD — Regression tests for the Send/Allowance CALL_EXCEPTION fix
 * ═══════════════════════════════════════════════════════════════════════
 * Root cause covered: allowance(owner, spender) sent to the Arc-only USDC
 * address 0x3600...0000 while the wallet was connected to another chain
 * (contract has no code there → "missing revert data" CALL_EXCEPTION).
 *
 * The SendGuard module embedded in public/index.html is extracted and
 * executed here so tests run against the exact production logic.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.resolve(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(indexPath, 'utf8');

const ARC = 5042002;
const SEPOLIA = 11155111;
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const SEPOLIA_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const ZERO = '0x0000000000000000000000000000000000000000';

const REGISTRY = {
  [ARC]: {
    USDC: ARC_USDC,
    EURC: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
    cirBTC: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF',
  },
  [SEPOLIA]: {
    USDC: SEPOLIA_USDC,
    EURC: '0x08210f9170f89ab7658f0b5e3ff39b0e03c2bfa4',
  },
};

function loadSendGuard() {
  const start = html.indexOf('const SendGuard = (() => {');
  const endMarker = "if (typeof window !== 'undefined') window.SendGuard = SendGuard;";
  const end = html.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const src = html.slice(start, end);
  // eslint-disable-next-line no-new-func
  const factory = new Function('ethers', 'getTokenAddressForChain', src + '\nreturn SendGuard;');
  const getTokenAddressForChain = (chainId, sym) => (REGISTRY[chainId] || {})[sym] || null;
  return factory(ethers, getTokenAddressForChain);
}

const SendGuard = loadSendGuard();

describe('SendGuard — address validation', () => {
  it('accepts valid checksummed addresses', () => {
    expect(SendGuard.isValidAddress(MULTICALL3)).toBe(true);
    expect(SendGuard.isValidAddress(ARC_USDC)).toBe(true);
  });

  it('rejects malformed addresses', () => {
    expect(SendGuard.isValidAddress('')).toBe(false);
    expect(SendGuard.isValidAddress(null)).toBe(false);
    expect(SendGuard.isValidAddress('0x123')).toBe(false);
    expect(SendGuard.isValidAddress('not-an-address')).toBe(false);
    expect(SendGuard.isValidAddress('0xZZ11bde05977b3631167028862bE2a173976CA11')).toBe(false);
  });
});

describe('SendGuard — placeholder detection (Phase 4)', () => {
  it('flags the zero address as placeholder on any chain', () => {
    expect(SendGuard.isPlaceholderToken(ZERO, ARC)).toBe(true);
    expect(SendGuard.isPlaceholderToken(ZERO, SEPOLIA)).toBe(true);
  });

  it('flags Arc USDC (0x3600...) as placeholder OUTSIDE Arc Testnet', () => {
    expect(SendGuard.isPlaceholderToken(ARC_USDC, SEPOLIA)).toBe(true);
    expect(SendGuard.isPlaceholderToken(ARC_USDC, 1)).toBe(true);
    expect(SendGuard.isPlaceholderToken(ARC_USDC, 999999)).toBe(true);
  });

  it('accepts Arc USDC (0x3600...) ON Arc Testnet (5042002)', () => {
    expect(SendGuard.isPlaceholderToken(ARC_USDC, ARC)).toBe(false);
  });

  it('flags empty token as placeholder', () => {
    expect(SendGuard.isPlaceholderToken(null, ARC)).toBe(true);
    expect(SendGuard.isPlaceholderToken('', ARC)).toBe(true);
  });
});

describe('SendGuard — assertERC20Token (blocks the reported bug)', () => {
  it('BUG SCENARIO: blocks allowance target 0x3600... when wallet is on another chain', () => {
    expect(() => SendGuard.assertERC20Token(ARC_USDC, SEPOLIA, 'USDC'))
      .toThrow('Placeholder token detected.');
  });

  it('allows Arc USDC on Arc Testnet', () => {
    expect(SendGuard.assertERC20Token(ARC_USDC, ARC, 'USDC')).toBe(true);
  });

  it('allows Sepolia USDC on Sepolia', () => {
    expect(SendGuard.assertERC20Token(SEPOLIA_USDC, SEPOLIA, 'USDC')).toBe(true);
  });

  it('blocks the zero address', () => {
    expect(() => SendGuard.assertERC20Token(ZERO, ARC, 'USDC'))
      .toThrow('Placeholder token detected.');
  });

  it('blocks invalid addresses', () => {
    expect(() => SendGuard.assertERC20Token('0x1234', ARC, 'USDC'))
      .toThrow('Invalid token address.');
    expect(() => SendGuard.assertERC20Token(null, ARC, 'USDC'))
      .toThrow('Invalid token address.');
  });

  it('blocks tokens not registered on the target chain (wrong-chain fallback)', () => {
    expect(() => SendGuard.assertERC20Token(SEPOLIA_USDC, 999999, 'USDC'))
      .toThrow('Token USDC is not available on chain 999999.');
  });

  it('blocks a valid token resolved for the wrong chain', () => {
    expect(() => SendGuard.assertERC20Token(SEPOLIA_USDC, ARC, 'USDC'))
      .toThrow('Token USDC resolved to a wrong-chain address for chain 5042002.');
  });

  it('blocks cirBTC fallback address outside chains where it is registered', () => {
    const CIRBTC = REGISTRY[ARC].cirBTC;
    expect(() => SendGuard.assertERC20Token(CIRBTC, 999999, 'cirBTC'))
      .toThrow('Token cirBTC is not available on chain 999999.');
    expect(SendGuard.assertERC20Token(CIRBTC, ARC, 'cirBTC')).toBe(true);
  });
});

describe('SendGuard — spender validation (Phase 3)', () => {
  it('accepts Multicall3 as spender (intentional transferFrom pattern)', () => {
    expect(SendGuard.assertSpender(MULTICALL3)).toBe(true);
  });

  it('blocks the zero address as spender', () => {
    expect(() => SendGuard.assertSpender(ZERO)).toThrow('Spender cannot be the zero address.');
  });

  it('blocks invalid spender addresses', () => {
    expect(() => SendGuard.assertSpender('0xdead')).toThrow('Invalid spender address.');
    expect(() => SendGuard.assertSpender(undefined)).toThrow('Invalid spender address.');
  });
});

describe('SendGuard — recipient validation', () => {
  it('accepts a valid recipient', () => {
    expect(SendGuard.assertRecipient('0x01dE545e8Fea5EcAAb78eC2C09E6D98117f7687d')).toBe(true);
  });

  it('blocks the zero address recipient', () => {
    expect(() => SendGuard.assertRecipient(ZERO)).toThrow('Recipient cannot be the zero address.');
  });
});

describe('SendGuard — contract deployment check (missing revert data prevention)', () => {
  it('throws when the address has no code on the connected network', async () => {
    const prov = { getCode: async () => '0x' };
    await expect(SendGuard.assertContractDeployed(prov, ARC_USDC, 'USDC token'))
      .rejects.toThrow('USDC token has no code on the connected network');
  });

  it('passes when the address holds contract code', async () => {
    const prov = { getCode: async () => '0x6080604052' };
    await expect(SendGuard.assertContractDeployed(prov, ARC_USDC, 'USDC token'))
      .resolves.toBe(true);
  });

  it('does not hard-block on RPC failure (tx layer surfaces errors)', async () => {
    const prov = { getCode: async () => { throw new Error('rpc down'); } };
    await expect(SendGuard.assertContractDeployed(prov, ARC_USDC, 'USDC token'))
      .resolves.toBe(true);
  });

  it('is a no-op without a provider', async () => {
    await expect(SendGuard.assertContractDeployed(null, ARC_USDC)).resolves.toBe(true);
  });
});

describe('SendGuard — live chainId detection (Phase 2)', () => {
  it('reads the live chainId from the injected provider', async () => {
    const eth = { request: async ({ method }) => (method === 'eth_chainId' ? '0x4cef52' : null) };
    expect(await SendGuard.getLiveChainId(eth)).toBe(ARC);
  });

  it('returns null when no provider is available', async () => {
    expect(await SendGuard.getLiveChainId(null)).toBe(null);
  });

  it('returns null when the provider request fails', async () => {
    const eth = { request: async () => { throw new Error('nope'); } };
    expect(await SendGuard.getLiveChainId(eth)).toBe(null);
  });
});

describe('Send flow wiring — source-level regression checks', () => {
  it('saExecuteSend validates the token before the allowance() call', () => {
    const fnStart = html.indexOf('async function saExecuteSend()');
    const fnBody = html.slice(fnStart, fnStart + 16000);
    const guardIdx = fnBody.indexOf('SendGuard.assertERC20Token');
    const allowanceIdx = fnBody.indexOf('contract.allowance(walletAddress, MC3_ADDR)');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(allowanceIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(allowanceIdx);
  });

  it('saExecuteSend hard-refreshes the provider after wallet_switchEthereumChain', () => {
    const fnStart = html.indexOf('async function saExecuteSend()');
    const fnBody = html.slice(fnStart, fnStart + 16000);
    const switchIdx = fnBody.indexOf('wallet_switchEthereumChain');
    const refreshIdx = fnBody.indexOf('refreshProviderState', switchIdx);
    expect(switchIdx).toBeGreaterThan(-1);
    expect(refreshIdx).toBeGreaterThan(switchIdx);
  });

  it('saExecuteSend re-verifies the chainId after the switch (never proceeds off-chain)', () => {
    const fnStart = html.indexOf('async function saExecuteSend()');
    const fnBody = html.slice(fnStart, fnStart + 16000);
    const switchIdx = fnBody.indexOf('wallet_switchEthereumChain');
    const recheck = fnBody.indexOf('if (activeChainId !== 5042002)', switchIdx);
    expect(recheck).toBeGreaterThan(switchIdx);
  });

  it('saExecuteSend blocks native tokens from the ERC-20 path', () => {
    const fnStart = html.indexOf('async function saExecuteSend()');
    const fnBody = html.slice(fnStart, fnStart + 16000);
    expect(fnBody).toContain('saTokenCfg.isNative');
  });

  it('multisend executeBatchViaMulticall3 validates token + spender before allowance', () => {
    const fnStart = html.indexOf('async function executeBatchViaMulticall3(');
    const fnBody = html.slice(fnStart, fnStart + 20000);
    const guardIdx = fnBody.indexOf('SendGuard.assertERC20Token');
    const allowanceIdx = fnBody.indexOf('tokenContract.allowance(senderAddr, MULTICALL3_ADDRESS)');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(allowanceIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(allowanceIdx);
  });
});
