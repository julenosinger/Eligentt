import { ethers } from 'ethers';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

async function deriveEncryptionKey(secret) {
  const enc = new TextEncoder();
  const material = await crypto.subtle.importKey(
    'raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('elligente-server-wallet-v1'), iterations: 100000, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

async function decryptData(jsonStr, cryptoKey) {
  const parsed = JSON.parse(jsonStr);
  const iv = new Uint8Array(parsed.iv);
  const ct = new Uint8Array(parsed.ct);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ct);
  return new TextDecoder().decode(plain);
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const KV = env.AUTH_KV;
  if (!KV) return json({ error: 'AUTH_KV not configured' }, 503);

  const serverSecret = env.AUTH_SECRET || 'elligente-default-secret-change-me';

  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token || token.length < 32) {
    return json({ error: 'Invalid session token' }, 401);
  }

  const sessionRaw = await KV.get(`session:${token}`);
  if (!sessionRaw) {
    return json({ error: 'Session expired or invalid' }, 401);
  }

  const session = JSON.parse(sessionRaw);

  let body;
  try { body = await request.json(); } catch (_) {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { action } = body;
  if (!action || !['signTransaction', 'signMessage', 'sendTransaction'].includes(action)) {
    return json({ error: 'Invalid action: must be signTransaction, signMessage, or sendTransaction' }, 400);
  }

  const userRaw = await KV.get(`user:${session.email}`);
  if (!userRaw) {
    return json({ error: 'User not found' }, 404);
  }

  const user = JSON.parse(userRaw);
  if (!user.wallet || !user.wallet.encryptedKey) {
    return json({ error: 'No wallet configured for this account' }, 400);
  }

  let privateKey;
  try {
    const encKey = await deriveEncryptionKey(serverSecret);
    privateKey = await decryptData(user.wallet.encryptedKey, encKey);
  } catch (e) {
    return json({ error: 'Failed to decrypt wallet key' }, 500);
  }

  const rpc = env.ARC_RPC_URL || 'https://rpc.testnet.arc.network';
  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(privateKey, provider);

  try {
    if (action === 'signMessage') {
      const { message } = body;
      if (!message || typeof message !== 'string') {
        return json({ error: 'Message required for signMessage' }, 400);
      }
      const signature = await wallet.signMessage(message);
      return json({ ok: true, signature, address: wallet.address });
    }

    if (action === 'signTransaction') {
      const { transaction } = body;
      if (!transaction || typeof transaction !== 'object') {
        return json({ error: 'Transaction object required' }, 400);
      }
      const tx = { ...transaction };
      if (!tx.chainId) tx.chainId = 5042002;
      const signed = await wallet.signTransaction(tx);
      return json({ ok: true, signedTransaction: signed, address: wallet.address });
    }

    if (action === 'sendTransaction') {
      const { transaction } = body;
      if (!transaction || typeof transaction !== 'object') {
        return json({ error: 'Transaction object required' }, 400);
      }
      const tx = await wallet.sendTransaction(transaction);
      const receipt = await tx.wait();
      return json({
        ok: true,
        txHash: tx.hash,
        blockNumber: receipt?.blockNumber,
        status: receipt?.status,
        address: wallet.address,
      });
    }
  } catch (e) {
    console.error('[AUTH/SIGN] Error:', e.shortMessage || e.message || e);
    return json({ error: e.shortMessage || e.message || 'Signing failed' }, 500);
  }
}
