/**
 * Turbo Bridge Operator Relayer
 * ═══════════════════════════════
 * Cloudflare Pages Function — POST /api/relayer
 *
 * Receives intent data and executes fulfillAndPayWithFee() on-chain
 * using OPERATOR_PRIVATE_KEY from Cloudflare environment variables.
 *
 * NEVER exposes the private key to the browser.
 * NEVER depends on user wallet or MetaMask browser extension.
 *
 * Deployment:
 *   1. Set OPERATOR_PRIVATE_KEY in Cloudflare Dashboard > Pages > Settings > Environment Variables
 *   2. Set ARC_RPC_URL (optional, defaults to ARC Testnet)
 *   3. Deploy: npx wrangler pages deploy src --branch main
 *
 * Environment Variables (CF Dashboard):
 *   OPERATOR_PRIVATE_KEY  — 0x-prefixed private key of an operator wallet
 *   ARC_RPC_URL           — (optional) ARC RPC URL
 */
import { ethers } from 'ethers';

// ── CORS ──
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── Contract addresses (must match frontend config/runtime.js) ──
const TREASURY_VAULT = '0xbfC9E8F79bd30b912081ae88F9ad0A515F08c2F1';
const ASSETS = {
  usdc:   '0x3600000000000000000000000000000000000000',
  eurc:   '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
  cirbtc: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF',
};
const VAULT_ABI = [
  'function fulfillAndPayWithFee(address asset, uint256 grossAmount, uint256 feeAmount, bytes32 intentId, address recipient)',
  'function intentState(bytes32) view returns (uint8)',
  'function isOperator(address) view returns (bool)',
];

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const key = env.OPERATOR_PRIVATE_KEY;
  if (!key) {
    return json({ error: 'OPERATOR_PRIVATE_KEY not set in Cloudflare environment' }, 500);
  }

  let body;
  try { body = await request.json(); } catch (_) {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { intentBytes32, asset, grossAmount, feeAmount, userAddress } = body;
  if (!intentBytes32 || !asset || grossAmount == null || feeAmount == null || !userAddress) {
    return json({ error: 'Missing fields: intentBytes32, asset, grossAmount, feeAmount, userAddress' }, 400);
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
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
