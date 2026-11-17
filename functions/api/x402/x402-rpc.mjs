/**
 * x402 — Arc Mainnet read-only RPC + on-chain payment-evidence validation
 * ═══════════════════════════════════════════════════════════════════════════════
 * READ-ONLY RPC helpers and receipt/event validation. NEVER sends transactions,
 * NEVER broadcasts, NEVER creates live authorizations. Transport is injected
 * (mockable) so these are unit-testable against realistic fixtures; live Arc RPC
 * certification requires network access and is performed separately.
 *
 * Evidence model (§6): a transaction hash alone is insufficient; a consumed
 * EIP-3009 authorization alone is insufficient. A SETTLED decision requires a
 * successful receipt whose `Transfer` event binds the exact authorizer →
 * recipient → atomic amount, plus the authorization-nonce consumption.
 */
export const ARC_CHAIN_ID = 5042;
export const ARC_RPC_URL = 'https://rpc.mainnet.arc.io';
export const ARC_USDC = '0x3600000000000000000000000000000000000000';

// ERC-20 Transfer(address,address,uint256) topic.
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// EIP-3009 authorizationState(address,bytes32) selector.
export const AUTHORIZATION_STATE_SELECTOR = '0xe94a0102';

function padBytes32(value) {
  const clean = String(value).replace(/^0x/, '');
  return '0x' + clean.padStart(64, '0');
}

/**
 * Generic JSON-RPC call (read-only). Returns `{ ok, result }` or `{ ok:false, error }`.
 */
export async function rpcCall(rpcUrl, method, params, transport) {
  let resp;
  try {
    const fetchFn = transport || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!fetchFn) return { ok: false, error: 'no_transport' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    resp = await fetchFn(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (e) {
    return { ok: false, error: (e && e.name === 'AbortError') ? 'rpc_timeout' : 'rpc_unavailable' };
  }
  let body;
  try { body = await resp.json(); } catch (_) { return { ok: false, error: 'rpc_malformed' }; }
  if (!body || body.error) return { ok: false, error: 'rpc_error', detail: body && body.error };
  return { ok: true, result: body.result };
}

/** eth_chainId → number, or error. */
export async function fetchChainId(rpcUrl, transport) {
  const res = await rpcCall(rpcUrl, 'eth_chainId', [], transport);
  if (!res.ok) return res;
  return { ok: true, chainId: Number(res.result) };
}

/** eth_getTransactionReceipt → normalized receipt, or error. */
export async function fetchTransactionReceipt(rpcUrl, txHash, transport) {
  const res = await rpcCall(rpcUrl, 'eth_getTransactionReceipt', [txHash], transport);
  if (!res.ok) return res;
  if (res.result == null) return { ok: false, error: 'receipt_missing' };
  const r = res.result;
  return {
    ok: true,
    receipt: {
      transactionHash: r.transactionHash,
      status: r.status,                          // '0x1' success, '0x0' reverted
      confirmations: Number(r.confirmations || 0),
      blockNumber: r.blockNumber,
      to: r.to,
      logs: r.logs || [],
    },
  };
}

/** eth_call authorizationState(owner, nonce) → used. */
export async function fetchAuthorizationState(rpcUrl, usdcAddress, owner, nonce, transport) {
  const data = AUTHORIZATION_STATE_SELECTOR + padBytes32(owner).slice(2) + padBytes32(nonce).slice(2);
  const res = await rpcCall(rpcUrl, 'eth_call', [{ to: usdcAddress, data }, 'latest'], transport);
  if (!res.ok) return res;
  const result = res.result;
  if (typeof result !== 'string') return { ok: false, error: 'rpc_malformed' };
  return { ok: true, used: result !== '0x' + '0'.repeat(64) };
}

/**
 * Decode a `Transfer` event from a receipt's logs. Returns `{ ok, from, to, value }`
 * when a matching Transfer log exists. The nonce is NOT recoverable from a
 * Transfer event — nonce binding comes from authorizationState, not the log.
 */
export function decodeTransferEvent(receipt) {
  if (!receipt || !Array.isArray(receipt.logs)) return { ok: false, reason: 'no_logs' };
  for (const log of receipt.logs) {
    if (!log || !Array.isArray(log.topics) || log.topics[0] !== TRANSFER_TOPIC) continue;
    if (log.topics.length < 3) continue;
    const from = '0x' + String(log.topics[1]).slice(-40);
    const to = '0x' + String(log.topics[2]).slice(-40);
    const value = BigInt(String(log.data || '0x')).toString();
    return { ok: true, from: from.toLowerCase(), to: to.toLowerCase(), value };
  }
  return { ok: false, reason: 'transfer_event_not_found' };
}

/**
 * Validate that a receipt proves the EXACT payment (authorizer → recipient →
 * atomic amount), is successful and sufficiently confirmed.
 * Returns `{ ok, reason?, evidence? }`. Never returns `ok` on partial evidence.
 */
export function validateReceiptEvidence(receipt, { from, to, value, requiredConfirmations = 1, chainId, tokenAddress }) {
  if (!receipt) return { ok: false, reason: 'receipt_missing' };
  if (receipt.status !== '0x1') return { ok: false, reason: 'transaction_reverted' };
  if (receipt.confirmations < requiredConfirmations) {
    return { ok: false, reason: 'insufficient_confirmations', confirmations: receipt.confirmations };
  }
  if (chainId != null && Number(receipt.chainId) !== Number(chainId)) {
    return { ok: false, reason: 'chain_mismatch' };
  }
  if (tokenAddress != null && receipt.to && String(receipt.to).toLowerCase() !== String(tokenAddress).toLowerCase()) {
    return { ok: false, reason: 'token_mismatch' };
  }
  const ev = decodeTransferEvent(receipt);
  if (!ev.ok) return { ok: false, reason: ev.reason };
  if (ev.from !== String(from).toLowerCase()) return { ok: false, reason: 'authorizer_mismatch' };
  if (ev.to !== String(to).toLowerCase()) return { ok: false, reason: 'recipient_mismatch' };
  if (ev.value !== String(value)) return { ok: false, reason: 'amount_mismatch' };
  return {
    ok: true,
    evidence: {
      transactionHash: receipt.transactionHash,
      blockNumber: receipt.blockNumber,
      confirmations: receipt.confirmations,
      from: ev.from,
      to: ev.to,
      value: ev.value,
    },
  };
}
