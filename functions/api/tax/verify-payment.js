/**
 * POST /api/tax/verify-payment
 * Verifies that a USDC payment was received on-chain for a given quoteId.
 * Uses Arc Mainnet RPC to confirm the Transfer event.
 *
 * Body: { quoteId, txHash, amount }
 * Returns: { ok, verified, txHash, error? }
 *
 * Env vars:
 *   ARC_RPC_URL         — Arc Mainnet RPC
 *   TAX_TREASURY        — Protocol treasury address receiving USDC payments
 *   TAX_KV              — KV namespace for quote state (optional)
 */

import { jsonResp, errResp, isSafeUrl } from './_tax-utils.mjs';

// USDC contract on Arc Mainnet — precompile // arc-studio-allow-onchain-literal
const USDC_ARC = '0x3600000000000000000000000000000000000000';
// Transfer(address,address,uint256) topic // arc-studio-allow-onchain-literal
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (_) { return errResp('Invalid JSON'); }

  const { quoteId, txHash, amount } = body;
  if (!quoteId || !txHash) return errResp('quoteId and txHash required');

  const rpcUrl   = env.ARC_RPC_URL || null;
  const treasury = env.TAX_TREASURY || null;

  if (!rpcUrl)   return errResp('ARC_RPC_URL not configured', 503);
  if (!treasury) return errResp('TAX_TREASURY not configured', 503);
  if (!isSafeUrl(rpcUrl)) return errResp('RPC URL blocked', 400);

  // Anti-replay: check KV if available
  if (env.TAX_KV) {
    const used = await env.TAX_KV.get('used:' + quoteId);
    if (used) return jsonResp({ ok: false, error: 'Quote already used (replay rejected)' }, 409);
  }

  try {
    // Fetch transaction receipt
    const resp = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await resp.json();
    const receipt = data.result;

    if (!receipt) return jsonResp({ ok: false, error: 'Transaction not found or not yet mined' });
    if (receipt.status !== '0x1') return jsonResp({ ok: false, error: 'Transaction reverted' });

    // Verify Transfer event to treasury
    const transferLog = (receipt.logs || []).find(log =>
      log.address?.toLowerCase() === USDC_ARC.toLowerCase() &&
      log.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC.toLowerCase() &&
      log.topics?.[2] && ('0x' + log.topics[2].slice(26)).toLowerCase() === treasury.toLowerCase()
    );

    if (!transferLog) return jsonResp({ ok: false, error: 'No USDC Transfer to treasury found in receipt' });

    // Verify amount (USDC 6 decimals)
    const paidRaw   = BigInt(transferLog.data);
    const expectedRaw = BigInt(Math.round(amount * 1e6));
    if (paidRaw < expectedRaw) {
      return jsonResp({ ok: false, error: `Underpayment: expected ${expectedRaw}, got ${paidRaw}` });
    }

    // Mark quote as used (anti-replay)
    if (env.TAX_KV) {
      await env.TAX_KV.put('used:' + quoteId, '1', { expirationTtl: 365 * 24 * 3600 });
    }

    return jsonResp({ ok: true, verified: true, txHash, paidUsdc: Number(paidRaw) / 1e6 });
  } catch (e) {
    return jsonResp({ ok: false, error: e.message }, 500);
  }
}
