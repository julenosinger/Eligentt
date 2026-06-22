/**
 * Turbo Bridge CCTP Mint Relayer + Arc Transaction Memo
 * ═══════════════════════════════════════════════════════
 * Cloudflare Pages Function — POST /api/relayer/mint
 *
 * Receives CCTP attestation data and executes MessageTransmitter.receiveMessage()
 * on-chain using TURBO_RELAYER_PRIVATE_KEY from Cloudflare environment variables.
 *
 * Wraps the receiveMessage() call through the Arc Memo contract to emit
 * ELLIGENTE transaction memos for on-chain audit trail and recovery.
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
import { checkMintLimit } from '../rate-limit.mjs';
import { RELAYER_CONFIG } from '../shared-config.mjs';
import { verifyRelayerAuth, relayerConfigError } from '../relayer-auth.mjs';

// SECURITY: structured, safe telemetry only — never logs signature, token, key,
// OTP, session or intent payload. Fields are limited to operational metadata.
function relayerEvent(event, fields) {
  try {
    console.log(JSON.stringify({ event, timestamp: Date.now(), ...(fields || {}) }));
  } catch (_) {}
}
function relayerTelemetry(endpoint, reason) {
  relayerEvent('relayer_auth_failed', { endpoint, reason: reason || 'unknown' });
}

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
const MESSAGE_TRANSMITTER = RELAYER_CONFIG.MESSAGE_TRANSMITTER;
const MEMO_CONTRACT_ADDRESS = RELAYER_CONFIG.MEMO_CONTRACT;
const VAULT_ABI = RELAYER_CONFIG.VAULT_ABI;
const MT_ABI = RELAYER_CONFIG.MT_ABI;
const MEMO_ABI = RELAYER_CONFIG.MEMO_ABI;

const ARC_CHAIN_ID = RELAYER_CONFIG.ARC_CHAIN_ID;
const MEMO_PREFIX = 'ELLIGENTE';

function generateMemo(action, intentId, asset, amount) {
  return `${MEMO_PREFIX}|${action}|${intentId}|${(asset ?? 'USDC').toUpperCase()}|${amount}`;
}

export async function onRequest(context) {
  const { request, env } = context;

  const corsHeaders = getCORS(request, env);

  // Rate limit check
  const clientIP = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
  const rateCheck = await checkMintLimit(env.RATE_LIMIT_KV, clientIP);
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

  // OPERATIONAL: emergency kill switch. Blocks mint execution only.
  // Does NOT affect auth/login (separate endpoints). Default off.
  if (env.RELAYER_KILL_SWITCH === 'true') {
    relayerEvent('relayer_blocked', { endpoint: 'mint', reason: 'kill_switch' });
    return json({ error: 'Relayer temporarily disabled' }, 503);
  }

  // SECURITY: in production the relayer allowlist must be configured.
  const cfgErr = relayerConfigError(env);
  if (cfgErr) {
    relayerTelemetry('mint', 'config_missing');
    return json({ error: cfgErr }, 500);
  }

  const key = env.TURBO_RELAYER_PRIVATE_KEY;
  if (!key) {
    return json({ error: 'TURBO_RELAYER_PRIVATE_KEY not set in Cloudflare environment' }, 500);
  }

  let body;
  try { body = await request.json(); } catch (_) {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const authResult = await verifyRelayerAuth(body, env.RATE_LIMIT_KV, env);
  if (!authResult.valid) {
    relayerTelemetry('mint', authResult.reason);
    return json({ error: 'Auth failed: ' + authResult.error }, 401);
  }

  // SECURITY: bind the authorization to userAddress when the client provides it.
  // Optional for now (legacy clients omit it) — enforced once present so a valid
  // signature from one user cannot authorize a mint bound to another user.
  // Works for both legacy and EIP-712 (authResult.address is the recovered signer).
  // Disable via RELAYER_REQUIRE_SELF="false".
  if (body.userAddress !== undefined) {
    if (typeof body.userAddress !== 'string' || !ethers.isAddress(body.userAddress)) {
      return json({ error: 'Invalid userAddress' }, 400);
    }
    if (env.RELAYER_REQUIRE_SELF !== 'false' && authResult.address &&
        authResult.address.toLowerCase() !== body.userAddress.toLowerCase()) {
      relayerTelemetry('mint', 'address_mismatch');
      return json({ error: 'Invalid authorization' }, 403);
    }
  }

  // OBSERVABILITY: authorization accepted. mint_path reflects which scheme bound it.
  const mintPath = authResult.scheme || 'legacy';
  relayerEvent('relayer_auth_success', { endpoint: 'mint', mode: mintPath, mint_path: mintPath });

  const { messageBytes, attestationSignature, intentId, asset, amount } = body;
  if (!messageBytes || !attestationSignature) {
    return json({ error: 'Missing fields: messageBytes, attestationSignature' }, 400);
  }
  if (!intentId || typeof intentId !== 'string' || intentId.trim().length === 0) {
    return json({ error: 'Missing or invalid intentId' }, 400);
  }
  if (intentId.includes('|')) {
    return json({ error: 'Invalid intentId: contains reserved character' }, 400);
  }
  if (asset !== undefined && !['usdc', 'eurc', 'cirbtc'].includes(String(asset).toLowerCase())) {
    return json({ error: 'Invalid asset: must be usdc, eurc, or cirbtc' }, 400);
  }
  if (amount !== undefined && (typeof amount !== 'number' || !isFinite(amount) || amount < 0)) {
    return json({ error: 'Invalid amount: must be a non-negative number' }, 400);
  }

  if (typeof messageBytes !== 'string' || !/^0x[0-9a-fA-F]+$/.test(messageBytes) || messageBytes.length < 10) {
    return json({ error: 'Invalid messageBytes: must be 0x-prefixed hex' }, 400);
  }
  if (typeof attestationSignature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(attestationSignature) || attestationSignature.length < 10) {
    return json({ error: 'Invalid attestationSignature: must be 0x-prefixed hex' }, 400);
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

  // ── Generate Elligente Transaction Memo ──
  const memoStr = generateMemo('REPAY', intentId ?? 'UNKNOWN', asset ?? 'USDC', amount ?? 0);
  const memoId = ethers.id(intentId ?? 'UNKNOWN');
  const memoData = ethers.toUtf8Bytes(memoStr);
  console.log('[RELAYER] Generated memo:', memoStr);

  // ── Execute receiveMessage wrapped via Arc Memo contract ──
  console.log('[RELAYER] Executing receiveMessage via Memo contract…');

  try {
    const mtIface = new ethers.Interface(MT_ABI);
    const receiveMessageCalldata = mtIface.encodeFunctionData('receiveMessage', [messageBytes, attestationSignature]);

    const memoContract = new ethers.Contract(MEMO_CONTRACT_ADDRESS, MEMO_ABI, signer);

    let tx;
    let memoOnChain = false;
    try {
      tx = await memoContract.memo(MESSAGE_TRANSMITTER, receiveMessageCalldata, memoId, memoData);
      memoOnChain = true;
      console.log('[RELAYER] Memo-wrapped receiveMessage submitted — TX:', tx.hash);
    } catch (memoErr) {
      console.warn('[RELAYER] Memo-wrapped call failed, falling back to direct receiveMessage:', memoErr.shortMessage || memoErr.message);
      const mtWrite = new ethers.Contract(MESSAGE_TRANSMITTER, MT_ABI, signer);
      tx = await mtWrite.receiveMessage(messageBytes, attestationSignature);
      memoOnChain = false;
      console.log('[RELAYER] Direct receiveMessage submitted (no memo) — TX:', tx.hash);
    }

    const rc = await tx.wait(1, 25000);

    if (!rc || rc.status !== 1) {
      console.error('[RELAYER] Mint reverted or no receipt — TX:', tx.hash);
      relayerEvent('mint_failed', { endpoint: 'mint', mode: mintPath, reason: 'reverted' });
      return json({ success: false, error: 'Transaction reverted on-chain or no receipt', txHash: tx.hash }, 500);
    }

    const verifyReceipt = await provider.getTransactionReceipt(tx.hash);
    if (!verifyReceipt || verifyReceipt.status !== 1) {
      console.error('[RELAYER] Post-confirm verification failed — TX:', tx.hash, 'receipt:', !!verifyReceipt);
      relayerEvent('mint_failed', { endpoint: 'mint', mode: mintPath, reason: 'not_confirmed' });
      return json({ success: false, error: 'Transaction not confirmed on re-verification', txHash: tx.hash }, 500);
    }

    console.log('[RELAYER] Treasury mint confirmed — TX:', tx.hash, 'Block:', rc.blockNumber, 'Memo:', memoStr, 'OnChain:', memoOnChain);
    relayerEvent('mint_success', { endpoint: 'mint', mode: mintPath });
    return json({
      success: true,
      txHash: tx.hash,
      blockNumber: rc.blockNumber,
      verified: true,
      memo: memoStr,
      memoOnChain,
    });
  } catch (e) {
    console.error('[RELAYER] Mint failed:', e.shortMessage || e.message || e);
    relayerEvent('mint_failed', { endpoint: 'mint', mode: mintPath, reason: 'exception' });
    return json({ success: false, error: e.shortMessage || e.message || 'Unknown' }, 500);
  }

  function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}
