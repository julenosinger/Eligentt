/**
 * Turbo Bridge Operator Relayer
 * ═══════════════════════════════
 * Cloudflare Pages Function — POST /api/relayer
 *
 * Receives intent data and executes fulfillAndPayWithFee() on-chain
 * using TURBO_RELAYER_PRIVATE_KEY from Cloudflare environment variables.
 *
 * The relayer wallet is a dedicated EOA authorized as operator on TreasuryVault.
 * It operates fully server-side — NEVER exposed to browser, NEVER depends on
 * user wallet or MetaMask.
 *
 * Deployment:
 *   1. Set TURBO_RELAYER_PRIVATE_KEY in Cloudflare Dashboard > Pages > Settings > Environment Variables
 *   2. Set ARC_RPC_URL (optional, defaults to ARC Testnet)
 *   3. Deploy: npx wrangler pages deploy public --project-name elligente
 *
 * Environment Variables (CF Dashboard):
 *   TURBO_RELAYER_PRIVATE_KEY  — 0x-prefixed private key of the relayer operator wallet
 *   ARC_RPC_URL                — (optional) ARC RPC URL
 */
import { ethers } from 'ethers';
import { checkRelayLimit } from './rate-limit.mjs';
import { RELAYER_CONFIG } from './shared-config.mjs';
import { verifyRelayerAuth } from './relayer-auth.mjs';

function getCORS(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || 'https://elligente.pages.dev').split(',').map(s => s.trim());
  const origin = request.headers.get('Origin') || '';
  const corsOrigin = allowed.includes(origin) ? origin : (allowed[0] || 'https://elligente.pages.dev');
  return {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

const TREASURY_VAULT = RELAYER_CONFIG.TREASURY_VAULT;
const ASSETS = RELAYER_CONFIG.ASSETS;
const VAULT_ABI = RELAYER_CONFIG.VAULT_ABI;

export async function onRequest(context) {
  const { request, env } = context;

  const corsHeaders = getCORS(request, env);

  // Rate limit check
  const clientIP = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
  const rateCheck = await checkRelayLimit(env.RATE_LIMIT_KV, clientIP);
  if (!rateCheck.allowed) {
    return new Response(JSON.stringify({ error: 'Rate limit exceeded', retryAfter: rateCheck.reset }), {
      status: 429,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Retry-After': String(rateCheck.reset) },
    });
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const key = env.TURBO_RELAYER_PRIVATE_KEY;
  if (!key) {
    return json({ error: 'TURBO_RELAYER_PRIVATE_KEY not set in Cloudflare environment' }, 500);
  }

  let body;
  try { body = await request.json(); } catch (_) {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const authResult = await verifyRelayerAuth(body, env.RATE_LIMIT_KV);
  if (!authResult.valid) {
    return json({ error: 'Auth failed: ' + authResult.error }, 401);
  }

  const { intentBytes32, asset, grossAmount, feeAmount, userAddress } = body;
  if (!intentBytes32 || !asset || grossAmount == null || feeAmount == null || !userAddress) {
    return json({ error: 'Missing fields: intentBytes32, asset, grossAmount, feeAmount, userAddress' }, 400);
  }

  if (typeof grossAmount !== 'number' || grossAmount <= 0) {
    return json({ error: 'Invalid grossAmount: must be positive' }, 400);
  }
  if (typeof feeAmount !== 'number' || feeAmount < 0 || feeAmount > grossAmount) {
    return json({ error: 'Invalid feeAmount: must be between 0 and grossAmount' }, 400);
  }
  if (!ethers.isAddress(userAddress)) {
    return json({ error: 'Invalid userAddress: not a valid Ethereum address' }, 400);
  }
  if (typeof intentBytes32 !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(intentBytes32)) {
    return json({ error: 'Invalid intentBytes32: must be 0x-prefixed bytes32 hex' }, 400);
  }
  if (!['usdc', 'eurc', 'cirbtc'].includes(asset)) {
    return json({ error: 'Unknown asset: must be usdc, eurc, or cirbtc' }, 400);
  }

  const rpc = env.ARC_RPC_URL || 'https://rpc.testnet.arc.network';

  let provider, signer;
  try {
    provider = new ethers.JsonRpcProvider(rpc);
    signer   = new ethers.Wallet(key, provider);
  } catch (e) {
    return json({ error: 'Failed to create signer: ' + e.message }, 500);
  }

  // Verify operator role on-chain
  try {
    const vault = new ethers.Contract(TREASURY_VAULT, VAULT_ABI, provider);
    if (!(await vault.isOperator(await signer.getAddress()))) {
      return json({ error: 'Wallet is not an operator on TreasuryVault' }, 403);
    }
    // Skip if already fulfilled
    const state = await vault.intentState(intentBytes32);
    if (Number(state) >= 2) {
      return json({ skipped: true, reason: 'Already fulfilled/settled (state=' + state + ')', intentState: Number(state) });
    }
  } catch (e) {
    return json({ error: 'On-chain pre-check failed: ' + e.message }, 500);
  }

  // Parse amounts
  const addr = ASSETS[asset];
  if (!addr) return json({ error: 'Unknown asset: ' + asset }, 400);
  const dec = asset === 'cirbtc' ? 8 : 6;

  let rawGross, rawFee;
  try {
    rawGross = ethers.parseUnits(String(grossAmount), dec);
    rawFee   = ethers.parseUnits(String(feeAmount), dec);
  } catch (e) {
    return json({ error: 'Amount parse error: ' + e.message }, 400);
  }

  // Execute fulfillAndPayWithFee
  try {
    const vault = new ethers.Contract(TREASURY_VAULT, VAULT_ABI, signer);
    const tx = await vault.fulfillAndPayWithFee(addr, rawGross, rawFee, intentBytes32, userAddress);
    const rc = await tx.wait();

    console.log('[RELAYER] Fulfilled:', intentBytes32.slice(0, 16) + '…');
    console.log('[RELAYER] TX:', tx.hash);
    console.log('[RELAYER] Block:', rc.blockNumber);

    return json({ success: true, txHash: tx.hash, blockNumber: rc.blockNumber });
  } catch (e) {
    console.error('[RELAYER] Fail:', e.shortMessage || e.message || e);
    return json({ success: false, error: e.shortMessage || e.message || 'Unknown' }, 500);
  }

  function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}
