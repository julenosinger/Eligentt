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

export {
  W3S_BASE, CHAIN_RPC, getCredentials, isConfigured, corsHeaders, json, err,
  createContractExecution, fetchNonce,
};
