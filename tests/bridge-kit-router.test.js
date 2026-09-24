/**
 * Bridge Kit Router — CCTP-primary / LI.FI-fallback routing tests.
 * ═══════════════════════════════════════════════════════════════════════
 * Validates the routing decision matrix, the Mainnet-only chain/domain map,
 * and that the router never references Testnet, Iris sandbox, wrapped USDC, or
 * a private-key adapter.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'shared', 'bridgeKitRouter.js'), 'utf8');

function loadRouter() {
  const win = {};
  const fn = new Function('window', src);
  fn(win);
  return win.BridgeKitRouter;
}

const R = loadRouter();

const ARC = 5042, ETH = 1, BASE = 8453, OPT = 10, ARB = 42161, POLY = 137;

describe('BridgeKitRouter — routing decision matrix', () => {
  it('USDC between two CCTP chains → CCTP (primary)', () => {
    expect(R.route(ETH, ARC, 'USDC').provider).toBe('cctp');
    expect(R.route(ARC, BASE, 'USDC').provider).toBe('cctp');
    expect(R.route(OPT, POLY, 'USDC').provider).toBe('cctp');
  });

  it('EURC between two CCTP chains → CCTP (primary)', () => {
    expect(R.route(ARC, ETH, 'EURC').provider).toBe('cctp');
  });

  it('non-USDC/EURC token → LI.FI (fallback)', () => {
    expect(R.route(ETH, ARC, 'cirBTC').provider).toBe('lifi');
    expect(R.route(ETH, ARC, 'WBTC').provider).toBe('lifi');
    expect(R.route(ETH, ARC, 'ETH').provider).toBe('lifi');
    expect(R.route(ETH, ARC, undefined).provider).toBe('lifi');
  });

  it('same chain → LI.FI (local transfer, not CCTP)', () => {
    expect(R.route(ARC, ARC, 'USDC').provider).toBe('lifi');
    expect(R.route(ARC, ARC, 'USDC').reason).toBe('same_chain');
  });

  it('unsupported chain → LI.FI (not CCTP eligible)', () => {
    expect(R.route(999999, ARC, 'USDC').provider).toBe('lifi');
    expect(R.route(ETH, 999999, 'USDC').provider).toBe('lifi');
  });
});

describe('BridgeKitRouter — chain/domain identifiers (Mainnet only)', () => {
  it('maps numeric chain ids to the Bridge Kit chain strings', () => {
    expect(R.getKitChainId(ETH)).toBe('Ethereum');
    expect(R.getKitChainId(OPT)).toBe('Optimism');
    expect(R.getKitChainId(ARB)).toBe('Arbitrum');
    expect(R.getKitChainId(BASE)).toBe('Base');
    expect(R.getKitChainId(POLY)).toBe('Polygon');
    expect(R.getKitChainId(ARC)).toBe('Arc');
  });

  it('maps numeric chain ids to Circle CCTP domains', () => {
    expect(R.getDomain(ETH)).toBe(0);
    expect(R.getDomain(OPT)).toBe(2);
    expect(R.getDomain(ARB)).toBe(3);
    expect(R.getDomain(BASE)).toBe(6);
    expect(R.getDomain(POLY)).toBe(7);
    expect(R.getDomain(ARC)).toBe(26);
  });

  it('uses Mainnet USDC addresses (never wrapped / never testnet)', () => {
    expect(R.CHAINS['1'].usdc).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
    expect(R.CHAINS['8453'].usdc).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(R.CHAINS['42161'].usdc).toBe('0xaf88d065e77c8cC2239327C5EDb3A432268e5831');
    expect(R.CHAINS['5042'].usdc).toBe('0x3600000000000000000000000000000000000000');
  });
});

describe('BridgeKitRouter — no Testnet / sandbox / private key', () => {
  it('never references Testnet identifiers', () => {
    expect(src).not.toMatch(/Arc_Testnet|Ethereum_Sepolia|Base_Sepolia|Arbitrum_Sepolia|Optimism_Sepolia|Polygon_Amoy/);
    expect(src).not.toContain('5042002');
    expect(src).not.toMatch(/11155111|84532|421614|11155420|80002/);
  });

  it('never references Iris sandbox or wrapped USDC', () => {
    expect(src).not.toContain('iris-api-sandbox');
    expect(src).not.toMatch(/wrapped|WUSDC|wUSDC/i);
  });

  it('only creates the adapter from the browser provider (no private key on the frontend)', () => {
    expect(src).toContain('createViemAdapterFromProvider');
    expect(src).not.toContain('createViemAdapterFromPrivateKey');
    expect(src).not.toContain('createAdapterFromPrivateKey');
    expect(src).not.toMatch(/privateKey|mnemonic|entitySecret|apiKey/i);
  });
});

describe('BridgeKitRouter — integration surface', () => {
  it('exposes the full routing + bridge API', () => {
    for (const m of ['route', 'isEligible', 'getKitChainId', 'getDomain', 'isAvailable', 'createAdapter', 'bridge', 'estimate', 'retry', 'onEvent']) {
      expect(typeof R[m], m).toBe('function');
    }
  });

  it('is not available when the vendor bundle is absent', () => {
    expect(R.isAvailable()).toBe(false);
  });

  it('pins the public client to the app RPC (never public-node fallback)', () => {
    // The adapter must override getPublicClient so read/simulation calls use the
    // app's configured RPC, never base.publicnode.com or similar fallbacks.
    expect(src).toContain('getPublicClient');
    expect(src).toContain('_rpcListForChain');
    expect(src).toContain('getChainById');
  });
});

describe('Bridge Kit vendor bundle — CCTP contracts (Mainnet)', () => {
  it('config still carries the Mainnet CCTP v2 contracts', () => {
    const cctp = fs.readFileSync(path.join(root, 'config', 'cctp.js'), 'utf8');
    expect(cctp).toContain("tokenMessenger:'0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d'");
    expect(cctp).toContain("messageTransmitter:'0x81D40F21F12A8F0E3252Bccb954D722d4c464B64'");
  });
});

describe('Routing wiring in index.html (CCTP primary / LI.FI fallback)', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

  it('bridge dispatches through BridgeKitRouter (CCTP first)', () => {
    const fn = html.slice(html.indexOf('function executeBridgeOrTurbo'), html.indexOf('async function executeBridgeViaCCTP'));
    expect(fn).toContain('BridgeKitRouter.route');
    expect(fn).toContain('executeBridgeViaCCTP()');
    expect(fn).toContain('executeBridgeViaLiFi()');
  });

  it('CCTP bridge path never calls LI.FI', () => {
    const fn = html.slice(html.indexOf('async function executeBridgeViaCCTP'), html.indexOf('// ── Bridge via LI.FI'));
    expect(fn).toContain('BridgeKitRouter.bridge');
    expect(fn).toContain('BridgeKitRouter.retry');
    expect(fn).not.toContain('LiFiAdapter.getQuote');
  });

  it('CCTP bridge retries a failed result (no second burn)', () => {
    const fn = html.slice(html.indexOf('async function executeBridgeViaCCTP'), html.indexOf('// ── Bridge via LI.FI'));
    expect(fn).toContain("result.state === 'error'");
    expect(fn).toContain('BridgeKitRouter.retry(result');
  });

  it('Send Assets cross-chain dispatches CCTP before LI.FI', () => {
    const fn = html.slice(html.indexOf('function saExecuteCrossChain'), html.indexOf('async function saExecuteLiFiCrossChain'));
    expect(fn).toContain('BridgeKitRouter.route');
    expect(fn).toContain('saExecuteCCTPCrossChain()');
    expect(fn).toContain('saExecuteLiFiCrossChain()');
  });

  it('Send Assets CCTP passes the destination as recipientAddress', () => {
    const fn = html.slice(html.indexOf('async function saExecuteCCTPCrossChain'), html.indexOf('async function saExecuteLiFiCrossChain'));
    expect(fn).toContain('BridgeKitRouter.bridge(srcChain.chainId, destChain.chainId, amount, saCurrentAsset, recipient, adapter)');
  });
});
