/**
 * LI.FI integration — source + logic regression tests
 * ═══════════════════════════════════════════════════════════════════════
 * Verifies:
 *   - Arc Mainnet is wired into the Send Assets chain registry (5042).
 *   - LI.FI chain support (Arc 5042) + mainnet destinations are present.
 *   - LiFiAdapter.validateRoute rejects chain/token/amount/recipient mismatch.
 *   - SwapAggregator quotes LI.FI as a third provider (Local/Tower/LiFi).
 *   - No silent provider fallback is possible from a quoted source.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const lifiSrc = fs.readFileSync(path.join(root, 'shared', 'LiFiAdapter.js'), 'utf8');
const aggSrc = fs.readFileSync(path.join(root, 'shared', 'SwapAggregator.js'), 'utf8');

function loadLiFiAdapter() {
  const win = {};
  const fn = new Function('window', lifiSrc + '\nreturn window.LiFiAdapter;');
  return fn(win);
}

const LiFiAdapter = loadLiFiAdapter();

const ARC_USDC = '0x3600000000000000000000000000000000000000';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const RECIPIENT = '0x552008c0f6870c2f77e5cC1d2eb9bdff03e30Ea0';

function makeStep(overrides) {
  return {
    action: {
      fromChainId: 5042,
      toChainId: 8453,
      fromToken: { address: ARC_USDC },
      toToken: { address: BASE_USDC },
      fromAmount: '1000000',
      toAddress: RECIPIENT,
    },
    transactionRequest: {
      to: '0xA4072583658Fae592A3506A42431cb6316a8d40b',
      data: '0x1794958f',
      value: '0x0',
      chainId: 5042,
    },
    estimate: { toAmount: '994145', toAmountMin: '994145', approvalAddress: '0x9b4A302A548c7e313c2b74C461db7b84d3074A84' },
    ...(overrides || {}),
  };
}

const CTX = {
  fromChainId: 5042,
  toChainId: 8453,
  fromToken: ARC_USDC,
  toToken: BASE_USDC,
  amountRaw: '1000000',
  recipient: RECIPIENT,
};

describe('Arc Mainnet + LI.FI — chain registry', () => {
  it('Arc Mainnet (5042) is registered with the official RPC/explorer', () => {
    const reg = html.slice(html.indexOf('const CHAIN_REGISTRY = {'), html.indexOf('const CHAINS = ['));
    expect(reg).toContain("chainId: 5042");
    expect(reg).toContain("rpc: 'https://rpc.mainnet.arc.io'");
    expect(reg).toContain("explorer: 'https://explorer.arc.io'");
  });

  it('Arc Mainnet records the LI.FI Diamond address (verified /v1/quote approval target)', () => {
    expect(html).toContain("lifiDiamond: '0xA4072583658Fae592A3506A42431cb6316a8d40b'");
  });

  it('LI.FI-supported Mainnet destinations are registered (Ethereum / Base / Arbitrum)', () => {
    const reg = html.slice(html.indexOf('const CHAIN_REGISTRY = {'), html.indexOf('const CHAINS = ['));
    expect(reg).toContain("id: 'Ethereum'");
    expect(reg).toContain("id: 'Base'");
    expect(reg).toContain("id: 'Arbitrum'");
    expect(reg).toContain("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"); // Base USDC
    expect(reg).toContain("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"); // Arbitrum USDC
  });
});

describe('LiFiAdapter — route validation (untrusted calldata)', () => {
  it('accepts a route that matches the request', () => {
    expect(LiFiAdapter.validateRoute(makeStep(), CTX).ok).toBe(true);
  });

  it('rejects a source chain mismatch', () => {
    const step = makeStep();
    step.action.fromChainId = 5042002; // testnet instead of mainnet
    expect(LiFiAdapter.validateRoute(step, CTX)).toMatchObject({ ok: false, reason: 'from_chain_mismatch' });
  });

  it('rejects a destination chain mismatch', () => {
    const step = makeStep();
    step.action.toChainId = 42161;
    expect(LiFiAdapter.validateRoute(step, CTX)).toMatchObject({ ok: false, reason: 'to_chain_mismatch' });
  });

  it('rejects a source token mismatch', () => {
    const step = makeStep();
    step.action.fromToken.address = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    expect(LiFiAdapter.validateRoute(step, CTX)).toMatchObject({ ok: false, reason: 'from_token_mismatch' });
  });

  it('rejects a destination token mismatch', () => {
    const step = makeStep();
    step.action.toToken.address = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    expect(LiFiAdapter.validateRoute(step, CTX)).toMatchObject({ ok: false, reason: 'to_token_mismatch' });
  });

  it('rejects an amount mismatch', () => {
    const step = makeStep();
    step.action.fromAmount = '999999';
    expect(LiFiAdapter.validateRoute(step, CTX)).toMatchObject({ ok: false, reason: 'amount_mismatch' });
  });

  it('rejects a recipient mismatch', () => {
    const step = makeStep();
    step.action.toAddress = '0x0000000000000000000000000000000000000001';
    expect(LiFiAdapter.validateRoute(step, CTX)).toMatchObject({ ok: false, reason: 'recipient_mismatch' });
  });

  it('rejects missing transactionRequest (no target/calldata)', () => {
    const step = makeStep();
    delete step.transactionRequest;
    expect(LiFiAdapter.validateRoute(step, CTX)).toMatchObject({ ok: false, reason: 'invalid_target' });
  });

  it('rejects invalid calldata', () => {
    const step = makeStep();
    step.transactionRequest.data = '';
    expect(LiFiAdapter.validateRoute(step, CTX)).toMatchObject({ ok: false, reason: 'invalid_calldata' });
  });

  it('rejects a transactionRequest chain mismatch', () => {
    const step = makeStep();
    step.transactionRequest.chainId = 8453; // not the requested source chain
    expect(LiFiAdapter.validateRoute(step, CTX)).toMatchObject({ ok: false, reason: 'transaction_chain_mismatch' });
  });

  it('rejects a sender mismatch', () => {
    const step = makeStep();
    step.transactionRequest.from = '0x0000000000000000000000000000000000000001';
    expect(LiFiAdapter.validateRoute(step, { ...CTX, sender: RECIPIENT })).toMatchObject({ ok: false, reason: 'sender_mismatch' });
  });

  it('rejects an invalid transaction value', () => {
    const step = makeStep();
    step.transactionRequest.value = 'not-a-number';
    expect(LiFiAdapter.validateRoute(step, CTX)).toMatchObject({ ok: false, reason: 'invalid_value' });
  });
});

describe('SwapAggregator — three providers (Local / Tower / LiFi)', () => {
  it('quotes LI.FI as a third independent source', () => {
    expect(aggSrc).toContain('lifiPromise');
    expect(aggSrc).toContain("source: 'lifi'");
    expect(aggSrc).toContain('LiFiAdapter');
  });

  it('finalizes LI.FI executability from route validity (never self-declared)', () => {
    expect(aggSrc).toContain("qq.source === 'lifi'");
    expect(aggSrc).toContain('externalExecutionValid(qq)');
  });

  it('isolation: a LI.FI failure does not break Tower/Local quoting', () => {
    expect(aggSrc).toContain('Promise.allSettled');
    expect(aggSrc).toContain('withTimeout(lifiPromise');
  });
});

describe('Send Assets — LI.FI cross-chain path', () => {
  it('routes Arc Mainnet → mainnet destinations through LI.FI', () => {
    const fn = html.slice(html.indexOf('function saExecuteCrossChain'), html.indexOf('// ── Cross-chain status tracker'));
    expect(fn).toContain('saExecuteLiFiCrossChain()');
    expect(fn).toContain("activeChainId === ARC_MAINNET_ID");
    expect(fn).toContain('destChain.testnet === false');
  });

  it('keeps the existing CCTP testnet cross-chain path (no regression)', () => {
    const fn = html.slice(html.indexOf('function saExecuteCrossChain'), html.indexOf('// ── Cross-chain status tracker'));
    expect(fn).toContain('xcExecuteSend()');
    expect(fn).toContain('xcFromIdx = 0');
  });

  it('validates the LI.FI route before any signature', () => {
    const fn = html.slice(html.indexOf('async function saExecuteLiFiCrossChain'), html.indexOf('// ── Cross-chain status tracker'));
    expect(fn).toContain('LiFiAdapter.validateRoute');
    expect(fn).toContain('sendTransaction');
  });
});
