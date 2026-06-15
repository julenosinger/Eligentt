/**
 * Turbo Bridge CCTP Mint Relayer
 * ═══════════════════════════════
 * Cloudflare Pages Function — POST /api/relayer/mint
 *
 * Receives CCTP attestation data and executes MessageTransmitter.receiveMessage()
 * on-chain using TURBO_RELAYER_PRIVATE_KEY from Cloudflare environment variables.
 *
 * This completes the Turbo Bridge cycle: after the Treasury pays the user instantly
 * (via fulfillAndPayWithFee), this endpoint mints USDC back to the TreasuryVault
 * to restore liquidity.
 *
 * The relayer wallet is a dedicated EOA authorized as operator on TreasuryVault.
 * It operates fully server-side — NEVER exposed to browser, NEVER depends on
 * user wallet or MetaMask.
 *
 * Environment Variables (CF Dashboard):
 *   TURBO_RELAYER_PRIVATE_KEY  — 0x-prefixed private key of the relayer operator wallet
 *   ARC_RPC_URL                — (optional) ARC RPC URL
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
const MESSAGE_TRANSMITTER = '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275';

const VAULT_ABI = [
  'function isOperator(address) view returns (bool)',
];

const MT_ABI = [
  'function receiveMessage(bytes message, bytes attestation) returns (bool)',
  'function usedNonces(bytes32) view returns (uint256)',
];

const ARC_CHAIN_ID = 5042002;

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
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

  const { messageBytes, attestationSignature, intentId } = body;
  if (!messageBytes || !attestationSignature) {
    return json({ error: 'Missing fields: messageBytes, attestationSignature' }, 400);
  }

  const rpc = env.ARC_RPC_URL || 'https://rpc.testnet.arc.network';

  let provider, signer;
  try {
    provider = new ethers.JsonRpcProvider(rpc);
    signer   = new ethers.Wallet(key, provider);
  } catch (e) {
    return json({ error: 'Failed to create signer: ' + e.message }, 500);
  }

  const operatorAddr = await signer.getAddress();

  // ── Verify network ──
  try {
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== ARC_CHAIN_ID) {
      return json({ error: 'Wrong network: expected ' + ARC_CHAIN_ID + ', got ' + Number(network.chainId) }, 500);
    }
  } catch (e) {
    return json({ error: 'Network check failed: ' + e.message }, 500);
  }

  // ── Verify operator role on-chain ──
  try {
    const vault = new ethers.Contract(TREASURY_VAULT, VAULT_ABI, provider);
    if (!(await vault.isOperator(operatorAddr))) {
      return json({ error: 'Unauthorized: wallet is not an operator on TreasuryVault' }, 403);
    }
  } catch (e) {
    return json({ error: 'Operator check failed: ' + e.message }, 500);
  }

  // ── Check nonce — skip if already processed ──
  console.log('[RELAYER] CCTP mint request received — intent:', (intentId || '?').slice(0, 16) + '…');
  console.log('[RELAYER] Checking nonce…');

  try {
    const mtRead = new ethers.Contract(MESSAGE_TRANSMITTER, MT_ABI, provider);
    const msgHash = ethers.keccak256(messageBytes);
    const nonce = await mtRead.usedNonces(msgHash);
    if (Number(nonce) > 0) {
      console.log('[RELAYER] Nonce already used — nonce:', Number(nonce));
      return json({ success: true, status: 'already_processed', nonce: Number(nonce) });
    }
  } catch (e) {
    console.error('[RELAYER] Nonce check error:', e.shortMessage || e.message || e);
    return json({ error: 'Nonce check failed: ' + (e.shortMessage || e.message) }, 500);
  }

  // ── Execute receiveMessage ──
  console.log('[RELAYER] Executing receiveMessage…');

  try {
    const mtWrite = new ethers.Contract(MESSAGE_TRANSMITTER, MT_ABI, signer);
    const tx = await mtWrite.receiveMessage(messageBytes, attestationSignature);

    console.log('[RELAYER] Mint tx submitted:', tx.hash);

    const rc = await tx.wait();

    if (rc && rc.status === 1) {
      console.log('[RELAYER] Mint confirmed — TX:', tx.hash, 'Block:', rc.blockNumber);
      return json({ success: true, txHash: tx.hash, blockNumber: rc.blockNumber });
    } else {
      console.error('[RELAYER] Mint reverted on-chain — TX:', tx.hash);
      return json({ success: false, error: 'Transaction reverted on-chain', txHash: tx.hash }, 500);
    }
  } catch (e) {
    console.error('[RELAYER] Mint failed:', e.shortMessage || e.message || e);
    return json({ success: false, error: e.shortMessage || e.message || 'Unknown' }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
