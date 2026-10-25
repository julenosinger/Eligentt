/**
 * CF Pages Function — POST /api/gateway/transfer/confirm
 *
 * Server-side reconciliation endpoint. Independently verifies a mint transaction
 * on-chain via RPC before writing 'confirmed' or 'failed' to the operation record.
 *
 * This is the ONLY path through which an operation can transition from
 * 'accepted' → 'confirmed' or 'accepted' → 'failed'.
 * The client cannot reach these states via the public PATCH endpoint.
 *
 * Required env vars (set in CF Pages project environment settings):
 *   GATEWAY_RPC_URLS    JSON map: { "chainId": "https://rpc-url" }
 *                       e.g. { "5042": "https://rpc.mainnet.arc.io",
 *                              "421614": "https://arb-sepolia.rpc.url" }
 *   GATEWAY_ENV         "production" to enforce DO (non-KV) mode
 *   GATEWAY_OP_LOCK     Durable Object binding (required in production)
 *   GATEWAY_OPS_KV      KV binding (fallback in non-production only)
 *   DO_INTERNAL_SECRET  Internal auth secret for DO requests
 *
 * The actual confirmation logic lives in transfer.js (onRequestPostConfirm).
 * This file imports and re-exports it for the CF Pages routing system.
 */
export { onRequestPostConfirm as onRequestPost } from '../transfer.js';
