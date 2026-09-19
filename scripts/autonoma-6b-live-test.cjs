/**
 * AUTONOMA-6B — Live on-chain test runner (Circle dev-controlled wallet)
 * ═══════════════════════════════════════════════════════════════════════
 * Proves the Autonoma agent can execute a REAL transaction on Arc Testnet
 * using a Circle secure signer — WITHOUT any private key in the browser.
 *
 * This script runs on YOUR machine with YOUR Circle credentials. It is NOT run
 * during CI and never ships any secret.
 *
 * Prerequisites (all from the Circle Console — never commit these):
 *   set CIRCLE_API_KEY=...
 *   set CIRCLE_ENTITY_SECRET=...        (32-byte hex entity secret)
 *   set CIRCLE_WALLET_ID=...            (dev-controlled wallet id)
 *   set CIRCLE_WALLET_ADDRESS=0x...     (dev-controlled wallet address)
 *
 * Usage:
 *   node scripts/autonoma-6b-live-test.cjs              # SEND test (Arc Testnet)
 *   node scripts/autonoma-6b-live-test.cjs --bridge     # + CCTP V2 bridge test
 *
 * Uses the OFFICIAL Circle Wallets (developer-controlled) REST API:
 *   GET  /v1/w3s/config/entity
 *   POST /v1/w3s/developer/transactions/contractExecution
 *   GET  /v1/w3s/transactions/{id}
 */
'use strict';

const crypto = require('crypto');

const BASE = 'https://api.circle.com/v1/w3s';
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const ARC_TESTNET_CHAIN_ID = 5042002;

const API_KEY = process.env.CIRCLE_API_KEY || '';
const ENTITY_SECRET = process.env.CIRCLE_ENTITY_SECRET || '';
const WALLET_ID = process.env.CIRCLE_WALLET_ID || '';
const WALLET_ADDRESS = process.env.CIRCLE_WALLET_ADDRESS || '';

function missing() {
  const out = [];
  if (!API_KEY) out.push('CIRCLE_API_KEY');
  if (!ENTITY_SECRET) out.push('CIRCLE_ENTITY_SECRET');
  if (!WALLET_ID) out.push('CIRCLE_WALLET_ID');
  if (!WALLET_ADDRESS) out.push('CIRCLE_WALLET_ADDRESS');
  return out;
}

function encryptEntitySecret(publicKeyPem, entitySecretHex) {
  const secretBuf = Buffer.from(entitySecretHex.replace(/^0x/, ''), 'hex');
  return crypto.publicEncrypt({
    key: publicKeyPem,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256',
  }, secretBuf).toString('base64');
}

async function api(path, opts = {}) {
  const resp = await fetch(BASE + path, Object.assign({}, opts, {
    headers: Object.assign({
      Authorization: 'Bearer ' + API_KEY,
      'Content-Type': 'application/json',
    }, opts.headers || {}),
  }));
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error((data && data.message) || (path + ' -> HTTP ' + resp.status));
  }
  return data;
}

async function getEntityPublicKey() {
  const data = await api('/config/entity');
  return data.data.publicKey;
}

async function contractExecution(req) {
  const publicKey = await getEntityPublicKey();
  const entitySecretCiphertext = encryptEntitySecret(publicKey, ENTITY_SECRET);
  const body = {
    idempotencyKey: req.idempotencyKey,
    walletId: WALLET_ID,
    contractAddress: req.contractAddress,
    abiFunctionSignature: req.abiFunctionSignature,
    abiParameters: req.abiParameters,
    feeLevel: 'MEDIUM',
    entitySecretCiphertext,
  };
  const data = await api('/developer/transactions/contractExecution', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return data.data;
}

async function waitTransaction(id, timeoutMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const data = await api('/transactions/' + id);
    const tx = data.data;
    const state = tx.state;
    if (state === 'COMPLETE' || state === 'CONFIRMED' || state === 'FINAL') return tx;
    if (state === 'FAILED' || state === 'DENIED' || state === 'CANCELLED') throw new Error('tx ' + state + ': ' + id);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('tx timed out: ' + id);
}

async function testSend() {
  console.log('\n== SEND (real) — 0.01 USDC on Arc Testnet via Circle signer ==');
  const recipient = WALLET_ADDRESS; // send to self for the PoC
  const amount = '10000'; // 0.01 USDC (6 decimals)
  const res = await contractExecution({
    idempotencyKey: 'autonoma6b_send_' + Date.now(),
    contractAddress: ARC_USDC,
    abiFunctionSignature: 'transfer(address,uint256)',
    abiParameters: [recipient, amount],
  });
  console.log('  submitted:', res.id, 'state:', res.state, 'txHash:', res.txHash || '(pending)');
  const final = await waitTransaction(res.id);
  console.log('  FINAL state:', final.state, 'txHash:', final.txHash);
  console.log('  SEND OK: Circle signed + broadcast a real USDC transfer.');
}

async function testBridge() {
  console.log('\n== BRIDGE (real) — CCTP V2 Arc Testnet -> Base Sepolia ==');
  // Same CCTP V2 depositForBurn parameters the app uses (finality 1000, maxFee 0.5).
  const destDomain = 6;               // Base Sepolia
  const mintRecipient = '0x' + WALLET_ADDRESS.slice(2).padStart(64, '0'); // bytes32 = agent addr
  const amount = '10000';             // 0.01 USDC
  const maxFee = '500000';            // 0.5 USDC
  const res = await contractExecution({
    idempotencyKey: 'autonoma6b_bridge_' + Date.now(),
    contractAddress: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA', // TokenMessenger (source)
    abiFunctionSignature: 'depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)',
    abiParameters: [amount, destDomain, mintRecipient, ARC_USDC, '0x' + '0'.repeat(64), maxFee, '1000'],
  });
  console.log('  submitted:', res.id, 'state:', res.state, 'txHash:', res.txHash || '(pending)');
  const final = await waitTransaction(res.id);
  console.log('  FINAL state:', final.state, 'txHash:', final.txHash);
  console.log('  BRIDGE BURN OK. Attestation + receiveMessage handled by CCTP (unchanged flow).');
}

async function main() {
  const m = missing();
  if (m.length) {
    console.error('MISSING Circle credentials (set them in env, never commit):');
    m.forEach((k) => console.error('  - ' + k));
    console.error('\nThis live test CANNOT run without credentials. It is a documented runbook.');
    process.exit(2);
  }
  console.log('Circle wallet:', WALLET_ADDRESS);
  await testSend();
  if (process.argv.includes('--bridge')) await testBridge();
  console.log('\nDone. No secrets were logged.');
}

main().catch((e) => {
  console.error('LIVE TEST FAILED:', e.message);
  process.exit(1);
});
