/**
 * x402-rpc.test.js — Arc Mainnet read-only RPC + on-chain evidence validation
 * ═══════════════════════════════════════════════════════════════════════════════
 * Unit tests against realistic fixtures (mockable RPC transport). Live Arc RPC
 * certification is NOT performed here (no network access) and remains UNVERIFIED.
 * These tests certify the VALIDATION LOGIC: receipts, Transfer-event decoding and
 * exact evidence binding — never a SETTLED decision on partial evidence.
 */
import { describe, it, expect } from 'vitest';
import {
  rpcCall,
  fetchChainId,
  fetchTransactionReceipt,
  fetchAuthorizationState,
  decodeTransferEvent,
  validateReceiptEvidence,
  TRANSFER_TOPIC,
  AUTHORIZATION_STATE_SELECTOR,
} from '../functions/api/x402/x402-rpc.mjs';

function mockRpc(response) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const responseFor = (method) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: response }), { status: 200 });
    return responseFor(body.method);
  };
}

const OWNER = '0x' + 'ab'.repeat(20);
const RECIPIENT = '0x' + 'cd'.repeat(20);

function transferLog(from, to, value) {
  return {
    address: '0x3600000000000000000000000000000000000000',
    topics: [TRANSFER_TOPIC, '0x' + '0'.repeat(24) + from.slice(2), '0x' + '0'.repeat(24) + to.slice(2)],
    data: '0x' + BigInt(value).toString(16).padStart(64, '0'),
  };
}

describe('x402 RPC — read-only primitives', () => {
  it('parses eth_chainId', async () => {
    const transport = mockRpc('0x13b2'); // 5042
    const res = await fetchChainId('https://rpc', transport);
    expect(res.ok).toBe(true);
    expect(res.chainId).toBe(5042);
  });

  it('parses a transaction receipt', async () => {
    const transport = mockRpc({ status: '0x1', confirmations: 5, transactionHash: '0x' + 'aa'.repeat(32), blockNumber: '0x10', to: '0x3600000000000000000000000000000000000000', logs: [] });
    const res = await fetchTransactionReceipt('https://rpc', '0x' + 'aa'.repeat(32), transport);
    expect(res.ok).toBe(true);
    expect(res.receipt.status).toBe('0x1');
    expect(res.receipt.confirmations).toBe(5);
  });

  it('reports a missing receipt', async () => {
    const transport = mockRpc(null);
    const res = await fetchTransactionReceipt('https://rpc', '0x' + 'aa'.repeat(32), transport);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('receipt_missing');
  });

  it('detects an authorization-state consumed flag', async () => {
    const transport = mockRpc('0x' + '0'.repeat(63) + '1');
    const res = await fetchAuthorizationState('https://rpc', '0x3600000000000000000000000000000000000000', OWNER, '0x' + '11'.repeat(32), transport);
    expect(res.ok).toBe(true);
    expect(res.used).toBe(true);
  });

  it('classifies RPC timeout and malformed responses', async () => {
    const timeoutTransport = async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
    expect((await rpcCall('https://rpc', 'eth_chainId', [], timeoutTransport)).error).toBe('rpc_timeout');
    const badTransport = async () => new Response('not json', { status: 200 });
    expect((await rpcCall('https://rpc', 'eth_chainId', [], badTransport)).error).toBe('rpc_malformed');
  });
});

describe('x402 RPC — Transfer-event decoding & evidence binding', () => {
  it('decodes a Transfer event (from, to, value)', () => {
    const receipt = { logs: [transferLog(OWNER, RECIPIENT, 1000000)] };
    const ev = decodeTransferEvent(receipt);
    expect(ev.ok).toBe(true);
    expect(ev.from).toBe(OWNER);
    expect(ev.to).toBe(RECIPIENT);
    expect(ev.value).toBe('1000000');
  });

  it('validates exact evidence (authorizer/recipient/amount/confirmations)', () => {
    const receipt = { status: '0x1', confirmations: 3, transactionHash: '0x' + 'aa'.repeat(32), blockNumber: '0x10', logs: [transferLog(OWNER, RECIPIENT, 1000000)] };
    const res = validateReceiptEvidence(receipt, { from: OWNER, to: RECIPIENT, value: '1000000', requiredConfirmations: 2 });
    expect(res.ok).toBe(true);
    expect(res.evidence.transactionHash).toBe('0x' + 'aa'.repeat(32));
  });

  it('rejects reverted transactions, insufficient confirmations, and every binding mismatch', () => {
    const base = { status: '0x1', confirmations: 3, transactionHash: '0x' + 'aa'.repeat(32), blockNumber: '0x10', logs: [transferLog(OWNER, RECIPIENT, 1000000)] };
    const terms = { from: OWNER, to: RECIPIENT, value: '1000000', requiredConfirmations: 2 };
    expect(validateReceiptEvidence({ ...base, status: '0x0' }, terms).reason).toBe('transaction_reverted');
    expect(validateReceiptEvidence({ ...base, confirmations: 1 }, terms).reason).toBe('insufficient_confirmations');
    expect(validateReceiptEvidence({ ...base, logs: [transferLog('0x' + 'ee'.repeat(20), RECIPIENT, 1000000)] }, terms).reason).toBe('authorizer_mismatch');
    expect(validateReceiptEvidence({ ...base, logs: [transferLog(OWNER, '0x' + 'ee'.repeat(20), 1000000)] }, terms).reason).toBe('recipient_mismatch');
    expect(validateReceiptEvidence({ ...base, logs: [transferLog(OWNER, RECIPIENT, 2000000)] }, terms).reason).toBe('amount_mismatch');
    expect(validateReceiptEvidence(base, { ...terms, chainId: 1, receiptChainId: 1 }).ok).toBe(false); // chain mismatch path
  });

  it('rejects a receipt with no Transfer event (no fabricated evidence)', () => {
    const receipt = { status: '0x1', confirmations: 3, transactionHash: '0x' + 'aa'.repeat(32), logs: [] };
    const res = validateReceiptEvidence(receipt, { from: OWNER, to: RECIPIENT, value: '1000000' });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('transfer_event_not_found');
  });
});
