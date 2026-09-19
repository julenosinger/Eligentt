/**
 * AUTONOMA-6B — Circle dev-controlled Wallets helper (server-side only).
 * ═══════════════════════════════════════════════════════════════════════
 * Implements the official Circle Wallets (developer-controlled) REST flow so
 * the Autonoma agent can sign + broadcast through a Circle-managed wallet
 * WITHOUT any private key ever reaching the browser.
 *
 * Credentials are read from `context.env` (Cloudflare Secrets) ONLY:
 *   CIRCLE_API_KEY          — Circle API key (Bearer auth)
 *   CIRCLE_ENTITY_SECRET    — the developer entity secret (never leaves server)
 *   CIRCLE_WALLET_ID        — the dev-controlled wallet id to use
 *   CIRCLE_WALLET_ADDRESS   — the wallet address (for nonce/verification)
 *
 * Official API reference (validate against the live docs before enabling):
 *   https://developers.circle.com/api-reference/wallets
 * Endpoints used (dev-controlled Wallets API):
 *   GET  /v1/w3s/config/entity                       → entity public key
 *   POST /v1/w3s/developer/transactions/contractExecution
 *
 * This file is NOT routed by Cloudflare Pages (leading underscore).
 */

const W3S_BASE = 'https://api.circle.com/v1/w3s';

const CHAIN_RPC = {
  5042002: 'https://arc-testnet.drpc.org',
  11155111: 'https://ethereum-sepolia-rpc.publicnode.com',
  84532: 'https://sepolia.base.org',
  421614: 'https://sepolia-rollup.arbitrum.io/rpc',
  11155420: 'https://sepolia.optimism.io',
  80002: 'https://rpc-amoy.polygon.technology',
};

const DEFAULT_ALLOWED_ORIGINS = 'https://execdaat.xyz,https://elligentt.xyz,https://elligente.pages.dev';

function getCredentials(env) {
  return {
    apiKey: (env && env.CIRCLE_API_KEY) || '',
    entitySecret: (env && env.CIRCLE_ENTITY_SECRET) || '',
    walletId: (env && env.CIRCLE_WALLET_ID) || '',
    walletAddress: (env && env.CIRCLE_WALLET_ADDRESS) || '',
  };
}

function isConfigured(env) {
  const c = getCredentials(env);
  return !!(c.apiKey && c.entitySecret && c.walletId && c.walletAddress);
}

function allowedOrigin(env) {
  const list = ((env && env.ALLOWED_ORIGINS) || DEFAULT_ALLOWED_ORIGINS).split(',').map((s) => s.trim()).filter(Boolean);
  return list;
}

function corsHeaders(env, request) {
  const origin = (request && request.headers && request.headers.get('Origin')) || '';
  const allow = allowedOrigin(env).includes(origin) ? origin : allowedOrigin(env)[0] || '*';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data, status, env, request) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders(env, request)),
  });
}

function err(message, status, env, request) {
  return json({ ok: false, error: message }, status || 500, env, request);
}

/* ── crypto helpers ── */
function pemToArrayBuffer(pem) {
  const b64 = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function hexToBytes(hex) {
  const clean = String(hex).replace(/^0x/, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/* ── Circle Wallets API ── */
async function fetchEntityPublicKey(env) {
  const creds = getCredentials(env);
  const resp = await fetch(W3S_BASE + '/config/entity', {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + creds.apiKey, 'Content-Type': 'application/json' },
  });
  if (!resp.ok) throw new Error('Circle entity config failed (' + resp.status + ')');
  const data = await resp.json();
  const pub = data && data.data && data.data.publicKey;
  if (!pub) throw new Error('Circle entity publicKey missing');
  return pub;
}

// Encrypt the entity secret with Circle's entity public key (RSA-OAEP/SHA-256).
async function encryptEntitySecret(env) {
  const creds = getCredentials(env);
  const pubPem = await fetchEntityPublicKey(env);
  const key = await crypto.subtle.importKey(
    'spki',
    pemToArrayBuffer(pubPem),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  );
  const secretBytes = hexToBytes(creds.entitySecret);
  const encrypted = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, secretBytes);
  return bytesToBase64(new Uint8Array(encrypted));
}

/**
 * Create + sign + broadcast a contract-execution transaction through the
 * Circle dev-controlled wallet. Returns Circle's response (contains txHash/state).
 */
async function createContractExecution(env, req) {
  const creds = getCredentials(env);
  const entitySecretCiphertext = await encryptEntitySecret(env);
  const body = {
    idempotencyKey: req.idempotencyKey,
    walletId: creds.walletId,
    contractAddress: req.contractAddress,
    abiFunctionSignature: req.abiFunctionSignature,
    abiParameters: req.abiParameters || [],
    feeLevel: 'MEDIUM',
    entitySecretCiphertext,
  };
  if (req.value && req.value !== '0x0' && req.value !== '0') body.value = req.value;

  const resp = await fetch(W3S_BASE + '/developer/transactions/contractExecution', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + creds.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error((data && data.message) || ('Circle contractExecution failed (' + resp.status + ')'));
  }
  return data;
}

// Query the nonce for the circle wallet on a given chain (eth_getTransactionCount).
async function fetchNonce(env, chainId, address) {
  const rpc = CHAIN_RPC[chainId];
  if (!rpc) throw new Error('Unsupported chain ' + chainId);
  const target = address || getCredentials(env).walletAddress;
  if (!target) throw new Error('Circle wallet address missing');
  const resp = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount',
      params: [target, 'pending'],
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (data && data.result != null) return data.result;
  throw new Error('Nonce lookup failed: ' + ((data && data.error && data.error.message) || 'unknown'));
}

/* ───────────────────────────────────────────────────────────────────────
   AUTONOMA-6C — Structured request → Circle contract-execution descriptor.
   The endpoint never accepts a raw transaction as the authority of truth.
   Every operation maps to a concrete, allowlisted contract + real ABI.
   ─────────────────────────────────────────────────────────────────────── */

// Known/allowlisted contracts (mirror functions/api/shared-config.mjs SIGN_ALLOWLIST,
// lowercased). A contractExecution request may ONLY target one of these.
const SIGN_ALLOWLIST = [
  '0x3600000000000000000000000000000000000000', // USDC
  '0x89b50855aa3be2f677cd6303cec089b5f319d72a', // EURC
  '0xf0c4a4ce82a5746abaad9425360ab04fbba432bf', // CIRBTC
  '0xbfc9e8f79bd30b912081ae88f9ad0a515f08c2f1', // TreasuryVault
  '0x18076d992005186aeb13ac5270cad6e27db95247', // Pool
  '0x17cfb1aacbc64d0f0c247ed261b66c3d56e3eb16', // CrosschainBatch
  '0xca11bde05977b3631167028862be2a173976ca11', // Multicall3
  '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa', // CCTP TokenMessenger
  '0xe737e5cebeeba77efe34d4aa090756590b1ce275', // CCTP MessageTransmitter
  '0x5294e9927c3306dcbadb03fe70b92e01ccede505', // Memo
  '0x0000000000000000000000000000000000000001', // SwapRouter
].map((a) => a.toLowerCase());

const KNOWN_CONTRACTS = {
  USDC: '0x3600000000000000000000000000000000000000',
  CCTP_TOKEN_MESSENGER: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
};

function isAddress(a) {
  return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
}

function isKnownContract(addr) {
  return typeof addr === 'string' && SIGN_ALLOWLIST.indexOf(addr.toLowerCase()) !== -1;
}

function toBytes32Hex(bytes32Like) {
  const s = String(bytes32Like || '');
  if (/^0x[0-9a-fA-F]{64}$/.test(s)) return s;
  if (isAddress(s)) return '0x' + s.slice(2).padStart(64, '0');
  throw new Error('invalid bytes32');
}

/**
 * Map a structured request into a Circle contract-execution descriptor.
 *   { type:'transfer', tokenAddress, to, amount }
 *   { type:'bridge', amount, destinationDomain, mintRecipient, burnToken?, destinationCaller?, maxFee?, finality? }
 *   { type:'swap' | 'multisend' | 'contractExecution', contractAddress, abiFunctionSignature, abiParameters, value? }
 *
 * FAIL-CLOSED: unknown type, unknown/unauthorized contract, or invalid ABI
 * signature throws — the request is rejected, never silently re-routed.
 */
function mapStructuredRequest(req) {
  if (!req || typeof req !== 'object') throw new Error('missing request');
  const type = req.type || 'contractExecution';

  if (type === 'transfer' || type === 'send') {
    if (!req.tokenAddress || !req.to || req.amount == null) {
      throw new Error('transfer requires tokenAddress, to, amount');
    }
    if (!isKnownContract(req.tokenAddress)) throw new Error('transfer token not allowlisted');
    if (!isAddress(req.to)) throw new Error('transfer recipient invalid');
    return {
      contractAddress: String(req.tokenAddress).toLowerCase(),
      abiFunctionSignature: 'transfer(address,uint256)',
      abiParameters: [String(req.to), String(req.amount)],
      value: null,
    };
  }

  if (type === 'bridge' || type === 'depositForBurn') {
    // Real CCTP V2 TokenMessenger.depositForBurn (source chain) — same signature
    // and contract the existing CCTP V2 bridge uses.
    if (req.amount == null) throw new Error('bridge requires amount');
    const destDomain = Number(req.destinationDomain);
    if (!Number.isFinite(destDomain) || destDomain < 0) throw new Error('bridge requires destinationDomain');
    const mintRecipient = toBytes32Hex(req.mintRecipient);
    const burnToken = req.burnToken || KNOWN_CONTRACTS.USDC;
    if (!isKnownContract(burnToken)) throw new Error('bridge burn token not allowlisted');
    const destinationCaller = req.destinationCaller != null ? toBytes32Hex(req.destinationCaller) : '0x' + '0'.repeat(64);
    const maxFee = req.maxFee != null ? String(req.maxFee) : '500000'; // 0.5 USDC default (existing flow)
    const finality = req.finality != null ? String(Math.floor(Number(req.finality))) : '1000';
    return {
      contractAddress: KNOWN_CONTRACTS.CCTP_TOKEN_MESSENGER.toLowerCase(),
      abiFunctionSignature: 'depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)',
      abiParameters: [String(req.amount), String(destDomain), mintRecipient, String(burnToken).toLowerCase(), destinationCaller, maxFee, finality],
      value: null,
    };
  }

  // swap / multisend / generic contractExecution: the adapter supplies the real
  // contract + ABI. The contract MUST be allowlisted; the signature MUST be a
  // syntactically valid ABI function signature.
  if (type === 'swap' || type === 'multisend' || type === 'contractExecution') {
    if (!req.contractAddress || !req.abiFunctionSignature) {
      throw new Error(type + ' requires contractAddress, abiFunctionSignature');
    }
    if (!isKnownContract(req.contractAddress)) throw new Error('contract not allowlisted');
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*\([a-zA-Z0-9\[\],\s]*\)$/.test(req.abiFunctionSignature)) {
      throw new Error('invalid abiFunctionSignature');
    }
    if (req.abiParameters != null && !Array.isArray(req.abiParameters)) {
      throw new Error('abiParameters must be an array');
    }
    return {
      contractAddress: String(req.contractAddress).toLowerCase(),
      abiFunctionSignature: req.abiFunctionSignature,
      abiParameters: req.abiParameters || [],
      value: req.value || null,
    };
  }

  throw new Error('unknown request type: ' + type);
}

export {
  W3S_BASE, CHAIN_RPC, getCredentials, isConfigured, corsHeaders, json, err,
  createContractExecution, fetchNonce,
  mapStructuredRequest, isKnownContract, isAddress, SIGN_ALLOWLIST, KNOWN_CONTRACTS,
};
