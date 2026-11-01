/**
 * POST /api/tax/scan
 * Scans each network for transaction count for a given address.
 * No private key required — reads public RPC / explorer APIs.
 *
 * Required env vars (CF Pages):
 *   ALCHEMY_API_KEY     — Alchemy key for Ethereum/Base/Arbitrum/Optimism/Polygon
 *   SOLANA_RPC_URL      — Solana RPC endpoint
 *   ARC_RPC_URL         — Arc Mainnet RPC (default: env-configured, never hardcoded)
 *
 * Returns: { results: [{ network, ops, error? }] }
 */

import { jsonResp, errResp, isSafeUrl } from './_tax-utils.mjs';

const NETWORKS = ['arc', 'ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'solana'];

// EVM RPC endpoints — all sourced from env vars; no literal fallback // arc-studio-allow-onchain-literal
function evmRpc(env, net) {
  const ak = env.ALCHEMY_API_KEY || '';
  const map = {
    arc:       env.ARC_RPC_URL       || env.ARC_MAINNET_RPC || null,
    ethereum:  ak ? `https://eth-mainnet.g.alchemy.com/v2/${ak}` : (env.ETHEREUM_RPC_URL || null), // arc-studio-allow-onchain-literal
    base:      ak ? `https://base-mainnet.g.alchemy.com/v2/${ak}` : (env.BASE_RPC_URL || null), // arc-studio-allow-onchain-literal
    arbitrum:  ak ? `https://arb-mainnet.g.alchemy.com/v2/${ak}` : (env.ARBITRUM_RPC_URL || null), // arc-studio-allow-onchain-literal
    optimism:  ak ? `https://opt-mainnet.g.alchemy.com/v2/${ak}` : (env.OPTIMISM_RPC_URL || null), // arc-studio-allow-onchain-literal
    polygon:   ak ? `https://polygon-mainnet.g.alchemy.com/v2/${ak}` : (env.POLYGON_RPC_URL || null), // arc-studio-allow-onchain-literal
  };
  return map[net] || null;
}

async function scanEvmNet(net, address, env) {
  const rpcUrl = evmRpc(env, net);
  if (!rpcUrl) return { network: net, ops: 0, error: 'RPC not configured — set ' + net.toUpperCase() + '_RPC_URL or ALCHEMY_API_KEY in CF env' };
  if (!isSafeUrl(rpcUrl)) return { network: net, ops: 0, error: 'RPC URL blocked (SSRF guard)' };
  try {
    const resp = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount', params: [address, 'latest'] }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await resp.json();
    const nonce = data.result ? parseInt(data.result, 16) : 0;
    return { network: net, ops: nonce };
  } catch (e) {
    return { network: net, ops: 0, error: e.message };
  }
}

async function scanSolana(address, env) {
  const rpcUrl = env.SOLANA_RPC_URL || null;
  if (!rpcUrl) return { network: 'solana', ops: 0, error: 'SOLANA_RPC_URL not configured' };
  if (!isSafeUrl(rpcUrl)) return { network: 'solana', ops: 0, error: 'RPC URL blocked' };
  try {
    const resp = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress',
        params: [address, { limit: 1000 }] }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await resp.json();
    const sigs = Array.isArray(data.result) ? data.result.length : 0;
    return { network: 'solana', ops: sigs };
  } catch (e) {
    return { network: 'solana', ops: 0, error: e.message };
  }
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (_) { return errResp('Invalid JSON'); }
  const { address, targetType, networks = NETWORKS } = body;
  if (!address) return errResp('address required');

  const isEvm    = /^0x[0-9a-fA-F]{40}$/.test(address);
  const isSolana = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) && !isEvm;

  const results = await Promise.allSettled(
    networks.map(net => {
      if (net === 'solana') {
        if (!isSolana) return Promise.resolve({ network: 'solana', ops: 0, error: 'EVM address — Solana skipped' });
        return scanSolana(address, env);
      }
      if (!isEvm) return Promise.resolve({ network: net, ops: 0, error: 'Solana address — EVM skipped' });
      return scanEvmNet(net, address, env);
    })
  );

  return jsonResp({
    ok: true,
    address,
    results: results.map((r, i) =>
      r.status === 'fulfilled' ? r.value : { network: networks[i], ops: 0, error: r.reason?.message || 'Error' }
    ),
  });
}
