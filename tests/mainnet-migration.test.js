/**
 * Mainnet Migration — full-production-path regression tests.
 * ═══════════════════════════════════════════════════════════════════════
 * Verifies that every production execution path consistently resolves to
 * Arc Mainnet (chain 5042) and real supported Mainnet networks, that the
 * canonical Circle Wallet is the single agent wallet identity, and that no
 * production path silently selects the legacy Testnet (5042002).
 *
 * These are SOURCE-LEVEL tests: they read the actual production files
 * (config/, shared/, functions/, index.html) rather than self-contained mocks.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

const CANONICAL_CIRCLE_WALLET = '0x794eb2f43a333e9eab9731d8f5e5423d5ec628eb';

const PROD_FILES = [
  'config/system.js', 'config/runtime.js', 'config/chains.js', 'config/contracts.js', 'config/cctp.js',
  'functions/api/shared-config.mjs', 'functions/api/agent-signer/_circle.js',
  'functions/api/agent-signer/authorize.js', 'functions/api/agent-signer/broadcast.js',
  'functions/api/agent-signer/nonce.js', 'functions/api/agent-signer/config.js',
  'functions/api/pool-index/index.js', 'functions/api/health/index.js',
  'functions/api/auth/sign.js', 'functions/api/auth/verify.js',
  'functions/api/relayer.js', 'functions/api/relayer/mint.js',
  'functions/api/core/quote-engine.mjs', 'functions/api/core/settlement.mjs',
  'functions/api/core/intent-service.mjs', 'functions/index.js',
  'shared/rpcManager.js', 'shared/walletManager.js', 'shared/agentWalletManager.js',
  'shared/agentIdentity.js', 'shared/aiSmartWallet.js', 'shared/autonomaExecutionGate.js',
  'shared/agentScheduleExecutor.js', 'shared/LiFiAdapter.js', 'shared/secureSignerProvider.js',
  'shared/CrossChainTransferRouter.js',
];

describe('Mainnet — single source of truth (chain 5042)', () => {
  it('every production config declares Arc Mainnet chain id 5042', () => {
    expect(read('config/system.js')).toContain('ARC_CHAIN_ID:       5042');
    expect(read('config/runtime.js')).toContain('ARC_CHAIN_ID:       5042');
    expect(read('config/chains.js')).toContain('ARC_CHAIN_ID:         5042');
    expect(read('config/chains.js')).toContain('ACTIVE_CHAIN_ID: 5042');
  });

  it('Arc Mainnet RPC + explorer are the official docs endpoints', () => {
    const chains = read('config/chains.js');
    expect(chains).toContain("rpc:'https://rpc.mainnet.arc.io'");
    expect(chains).toContain("explorer:'https://explorer.arc.io'");
    expect(read('config/system.js')).toContain("ARC_RPC_URL:        'https://rpc.mainnet.arc.io'");
    expect(read('config/system.js')).toContain("ARC_EXPLORER_URL:   'https://explorer.arc.io'");
  });

  it('no production path selects legacy Testnet 5042002', () => {
    for (const f of PROD_FILES) {
      const src = read(f);
      expect(src, `${f} must not reference 5042002`).not.toContain('5042002');
    }
    expect(read('index.html')).not.toContain('5042002');
  });

  it('no production path uses Testnet RPC / explorer / Iris sandbox', () => {
    for (const f of PROD_FILES) {
      const src = read(f);
      expect(src, f).not.toMatch(/arc-testnet|testnet\.arcscan|testnet\.arc\.network/);
      expect(src, f).not.toContain('iris-api-sandbox.circle.com');
    }
    const html = read('index.html');
    expect(html).not.toMatch(/arc-testnet|testnet\.arcscan|testnet\.arc\.network/);
    expect(html).not.toContain('iris-api-sandbox.circle.com');
  });

  it('no production path selects Sepolia / Amoy Testnets', () => {
    for (const f of PROD_FILES) {
      const src = read(f);
      expect(src, f).not.toMatch(/\b11155111\b|\b84532\b|\b421614\b|\b11155420\b|\b80002\b/);
    }
  });
});

describe('Mainnet — real token configuration', () => {
  it('Arc Mainnet token addresses match the official docs', () => {
    const sys = read('config/system.js');
    expect(sys).toContain("USDC_ADDRESS:       '0x3600000000000000000000000000000000000000'");
    expect(sys).toContain("EURC_ADDRESS:       '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1'");
    expect(sys).toContain("CIRBTC_ADDRESS:     '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0'");
  });

  it('the old Testnet EURC/cirBTC addresses are removed from production', () => {
    for (const f of PROD_FILES) {
      const src = read(f);
      expect(src, f).not.toMatch(/89B50855|89b50855|f0C4a4CE|f0c4a4ce/);
    }
    expect(read('index.html')).not.toMatch(/89B50855|89b50855|f0C4a4CE|f0c4a4ce/);
  });

  it('CCTP v2 contracts are the Mainnet addresses (domain 26)', () => {
    const cctp = read('config/cctp.js');
    expect(cctp).toContain("tokenMessenger:'0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d'");
    expect(cctp).toContain("messageTransmitter:'0x81D40F21F12A8F0E3252Bccb954D722d4c464B64'");
    expect(cctp).toContain("tokenMinter:'0xfd78EE919681417d192449715b2594ab58f5D002'");
    expect(read('functions/api/shared-config.mjs')).toContain("MESSAGE_TRANSMITTER: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64'");
  });

  it('Iris uses the production endpoint (no sandbox)', () => {
    expect(read('config/cctp.js')).toContain('iris-api.circle.com');
    expect(read('functions/api/core/settlement.mjs')).toContain("'https://iris-api.circle.com'");
  });
});

describe('Circle Wallet — canonical single identity', () => {
  it('the agent-signer exposes the canonical Circle wallet constant', () => {
    const circle = read('functions/api/agent-signer/_circle.js');
    expect(circle).toContain(`const CANONICAL_CIRCLE_WALLET = '${CANONICAL_CIRCLE_WALLET}'`);
  });

  it('the canonical Circle wallet is documented in .dev.vars.example', () => {
    const dev = read('.dev.vars.example');
    expect(dev).toContain(`CIRCLE_WALLET_ADDRESS=${CANONICAL_CIRCLE_WALLET}`);
  });

  it('the signer reads the wallet from env (never invents a competing wallet)', () => {
    const circle = read('functions/api/agent-signer/_circle.js');
    expect(circle).toContain('walletAddress: (env && env.CIRCLE_WALLET_ADDRESS) || \'\'');
    expect(circle).not.toContain('ethers.Wallet.createRandom');
  });

  it('Circle credentials are never hardcoded or exposed to the browser', () => {
    const circle = read('functions/api/agent-signer/_circle.js');
    expect(circle).not.toContain('CIRCLE_ENTITY_SECRET =');
    // Browser-bound agent modules must not embed the entity secret / api key.
    for (const f of ['shared/agentWalletManager.js', 'shared/secureSignerProvider.js', 'shared/aiSmartWallet.js']) {
      const src = read(f);
      expect(src, f).not.toContain('CIRCLE_ENTITY_SECRET');
      expect(src, f).not.toContain('entitySecretCiphertext');
    }
  });
});

describe('Agent-signer — Mainnet chain resolution', () => {
  it('the agent-signer RPC map targets Mainnet chains only', () => {
    const circle = read('functions/api/agent-signer/_circle.js');
    expect(circle).toContain("5042: 'https://rpc.mainnet.arc.io'");
    expect(circle).toContain("1: 'https://cloudflare-eth.com'");
    expect(circle).toContain("8453: 'https://mainnet.base.org'");
    expect(circle).toContain("42161: 'https://arb1.arbitrum.io/rpc'");
    expect(circle).toContain("10: 'https://mainnet.optimism.io'");
    expect(circle).toContain("137: 'https://polygon-rpc.com'");
  });

  it('agent-signer endpoints default to Arc Mainnet (5042)', () => {
    expect(read('functions/api/agent-signer/config.js')).toContain('chainId: 5042');
    expect(read('functions/api/agent-signer/nonce.js')).toContain('|| 5042');
    expect(read('functions/api/agent-signer/broadcast.js')).toContain(': 5042');
    expect(read('functions/api/agent-signer/authorize.js')).toContain(': 5042');
  });

  it('server-side allowlists reference Mainnet token + CCTP addresses', () => {
    const cfg = read('functions/api/shared-config.mjs');
    expect(cfg).toContain("'0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1'"); // EURC
    expect(cfg).toContain("'0x171a4217b86a807a64eb94757db6849fb4bdbaa0'"); // cirBTC
    expect(cfg).toContain("'0x28b5a0e9c621a5badaa536219b3a228c8168cf5d'"); // TokenMessenger
    expect(cfg).toContain("'0x81d40f21f12a8f0e3252bccb954d722d4c464b64'"); // MessageTransmitter
  });
});

describe('Autonoma / AI Smart Wallet — Mainnet-aware', () => {
  it('the Autonoma execution gate is Mainnet-only for on-chain ops', () => {
    const gate = read('shared/autonomaExecutionGate.js');
    expect(gate).toContain('var ARC_CHAIN_ID = 5042');
    expect(gate).toContain('CCTP_SOURCE_CHAINS = [5042, 1, 8453, 42161, 10, 137]');
  });

  it('the cross-chain router uses Mainnet source chains', () => {
    const router = read('shared/CrossChainTransferRouter.js');
    expect(router).toContain('var ARC_CHAIN_ID = 5042');
    expect(router).toContain('CCTP_V2_SOURCE_CHAINS = [1, 8453, 42161, 10, 137]');
  });

  it('the AI Smart Wallet resolves balances on Arc Mainnet', () => {
    const aiw = read('shared/aiSmartWallet.js');
    expect(aiw).not.toContain('5042002');
    expect(aiw).toContain("EURC: { address: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1'");
    expect(aiw).toContain("cirBTC: { address: '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0'");
  });

  it('wallet manager targets Arc Mainnet', () => {
    const wm = read('shared/walletManager.js');
    expect(wm).not.toContain('5042002');
    expect(wm).toContain("'https://rpc.mainnet.arc.io'");
  });
});

describe('LI.FI — real router, Mainnet chain ids', () => {
  it('/api/lifi/quote validates chains and forwards to the real LI.FI API', () => {
    const q = read('functions/api/lifi/quote.js');
    expect(q).toContain("const LIFI_BASE = 'https://li.quest/v1'");
    expect(q).toContain('LIFI_BASE + \'/quote?\'');
    expect(q).toContain('isChainId(body.fromChain)');
  });

  it('the frontend adapter resolves token addresses from the Mainnet registry', () => {
    const a = read('shared/LiFiAdapter.js');
    expect(a).toContain('getTokenAddressForChain(chainId, symbol)');
    expect(a).toContain('/api/lifi/quote');
    expect(a).not.toContain('5042002');
  });
});

describe('Cloudflare API routes — Mainnet configuration', () => {
  it('server config uses Arc Mainnet chain id + RPC', () => {
    const cfg = read('functions/api/shared-config.mjs');
    expect(cfg).toContain('ARC_CHAIN_ID:    5042');
    expect(cfg).toContain("ARC_RPC_URL:     'https://rpc.mainnet.arc.io'");
  });

  it('health / pool-index / auth report Arc Mainnet', () => {
    expect(read('functions/api/health/index.js')).toContain('chainId: 5042');
    expect(read('functions/api/health/index.js')).toContain("'Arc Mainnet'");
    expect(read('functions/api/pool-index/index.js')).toContain('const CHAIN_ID = 5042');
    expect(read('functions/api/auth/verify.js')).toContain('chainId: 5042');
    expect(read('functions/api/auth/sign.js')).toContain("tx.chainId = 5042");
  });

  it('CSP connect-src is Mainnet-only (no Testnet domains)', () => {
    const headers = read('public/_headers');
    expect(headers).not.toMatch(/arc-testnet|testnet\.arcscan|rpc\.testnet\.arc|sepolia|amoy/);
    expect(headers).toContain('https://rpc.mainnet.arc.io');
    expect(headers).toContain('https://explorer.arc.io');
    expect(headers).toContain('https://iris-api.circle.com');
  });
});

describe('Authorization / signature gates remain intact', () => {
  it('Circle broadcast requires an authorization proof (fail-closed)', () => {
    const b = read('functions/api/agent-signer/broadcast.js');
    expect(b).toContain('authorizationProof');
    expect(b).toContain('if (!proofToken || typeof proofToken !== \'string\')');
    expect(b).toContain('return err(\'Authorization proof required\', 401');
  });

  it('the custodial signer policy allowlists only official contracts', () => {
    const cfg = read('functions/api/shared-config.mjs');
    expect(cfg).toContain('SIGN_ALLOWLIST');
  });
});
