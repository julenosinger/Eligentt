/**
 * AUTONOMA-6B — POST /api/agent-signer/broadcast
 * Signs + broadcasts a transaction through the Circle dev-controlled wallet.
 *
 * Body:
 *   { chainId, operation, executionId, request: { type, ... } }
 *
 *   request.type === 'transfer'
 *     { type:'transfer', tokenAddress, to, amount }        → transfer(address,uint256)
 *   request.type === 'contractExecution'
 *     { type:'contractExecution', contractAddress, abiFunctionSignature, abiParameters, value? }
 *
 * FAIL-CLOSED: 503 if Circle is not configured; 400 on malformed request.
 * No secret ever leaves the server.
 */
import { isConfigured, getCredentials, json, err, createContractExecution } from './_circle.js';

function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'idem_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
}

// Normalize a structured request into a Circle contract-execution descriptor.
function toContractExecution(req) {
  if (!req || typeof req !== 'object') throw new Error('missing request');
  if (req.type === 'transfer') {
    if (!req.tokenAddress || !req.to || req.amount == null) throw new Error('transfer requires tokenAddress, to, amount');
    return {
      contractAddress: req.tokenAddress,
      abiFunctionSignature: 'transfer(address,uint256)',
      abiParameters: [req.to, String(req.amount)],
    };
  }
  if (!req.type || req.type === 'contractExecution') {
    if (!req.contractAddress || !req.abiFunctionSignature) throw new Error('contractExecution requires contractAddress, abiFunctionSignature');
    return {
      contractAddress: req.contractAddress,
      abiFunctionSignature: req.abiFunctionSignature,
      abiParameters: req.abiParameters || [],
      value: req.value || null,
    };
  }
  throw new Error('unknown request type: ' + req.type);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!isConfigured(env)) {
    return err('Circle signer not configured', 503, env, request);
  }
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return err('Invalid JSON body', 400, env, request);
  }

  try {
    const descriptor = toContractExecution(body && body.request);
    const idempotencyKey = (body.executionId && typeof body.executionId === 'string' && body.executionId.length)
      ? 'autonoma_' + body.executionId
      : uuid();
    const res = await createContractExecution(env, {
      idempotencyKey,
      contractAddress: descriptor.contractAddress,
      abiFunctionSignature: descriptor.abiFunctionSignature,
      abiParameters: descriptor.abiParameters,
      value: descriptor.value || null,
    });
    const tx = res && res.data ? res.data : {};
    const txHash = tx.txHash || null;
    return json({
      ok: true,
      txHash,
      state: tx.state || null,
      id: tx.id || null,
      address: getCredentials(env).walletAddress,
    }, 200, env, request);
  } catch (e) {
    return err('Broadcast failed: ' + (e.message || e), 502, env, request);
  }
}
