import { ethers } from 'ethers';
import { RELAYER_CONFIG } from '../shared-config.mjs';

import { getAuthCors } from './_cors.mjs';

// SECURITY: responses use a per-request CORS allowlist (see _cors.mjs).
function mkJson(headers) {
  return (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
}

// SECURITY: legacy static salt kept ONLY to read v1 wallets created before
// per-user salts were introduced. New wallets are written as v2 by verify.js.
const LEGACY_WALLET_SALT = 'elligente-server-wallet-v1';

async function deriveEncryptionKey(secret, saltStr) {
  const enc = new TextEncoder();
  const material = await crypto.subtle.importKey(
    'raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(saltStr), iterations: 100000, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

// Backward-compatible wallet decryption: v2 records embed their own salt,
// v1 records fall back to the legacy static salt.
async function decryptWallet(jsonStr, serverSecret) {
  const parsed = JSON.parse(jsonStr);
  const saltStr = (parsed.version === 2 && parsed.salt) ? parsed.salt : LEGACY_WALLET_SALT;
  const cryptoKey = await deriveEncryptionKey(serverSecret, saltStr);
  const iv = new Uint8Array(parsed.iv);
  const ct = new Uint8Array(parsed.ct);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ct);
  return new TextDecoder().decode(plain);
}

// SECURITY: transaction policy for the custodial signer.
// Only official Elligentt contracts may be targeted. This blocks free transfers
// to arbitrary addresses and interactions with unknown contracts, while leaving
// existing payments (ERC-20 transfers whose recipient lives in calldata) intact.
const SIGN_ALLOWLIST = new Set((RELAYER_CONFIG.SIGN_ALLOWLIST || []).map(a => a.toLowerCase()));

function checkTxPolicy(transaction, env) {
  // Operational kill-switch (set SIGN_POLICY_DISABLED="true" only for emergencies).
  if (env && env.SIGN_POLICY_DISABLED === 'true') return { allowed: true };

  if (!transaction || typeof transaction !== 'object') {
    return { allowed: false, reason: 'missing transaction' };
  }
  const to = transaction.to;
  if (!to || typeof to !== 'string' || !ethers.isAddress(to)) {
    return { allowed: false, reason: 'invalid destination' };
  }
  if (!SIGN_ALLOWLIST.has(to.toLowerCase())) {
    return { allowed: false, reason: 'destination not allowlisted' };
  }
  if (transaction.data != null && (typeof transaction.data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(transaction.data))) {
    return { allowed: false, reason: 'invalid calldata' };
  }
  return { allowed: true };
}

function extractToken(request) {
  const authHeader = request.headers.get('Authorization') || '';
  const bearer = authHeader.replace('Bearer ', '').trim();
  if (bearer && bearer.length >= 32) return bearer;
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(/elligente_sid=([^;]+)/);
  return match ? match[1].trim() : '';
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: getAuthCors(context.request, context.env) });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const json = mkJson(getAuthCors(request, env));
  const KV = env.AUTH_KV;
  if (!KV) return json({ error: 'AUTH_KV not configured' }, 503);

  const serverSecret = env.AUTH_SECRET;
  if (!serverSecret) {
    console.error('[AUTH/SIGN] AUTH_SECRET not configured');
    return json({ error: 'Server misconfiguration' }, 500);
  }

  const token = extractToken(request);
  if (!token || token.length < 32) {
    return json({ error: 'Invalid session token' }, 401);
  }

  const sessionRaw = await KV.get(`session:${token}`);
  if (!sessionRaw) {
    return json({ error: 'Session expired or invalid' }, 401);
  }

  const session = JSON.parse(sessionRaw);

  // CUSTODIAL UNLOCK CHECK — sign/send requires unlocked state
  const unlockRaw = await KV.get(`unlock:${token}`);
  if (!unlockRaw) {
    return json({ error: 'Custodial wallet locked. Use /api/auth/unlock to authorize operations.' }, 403);
  }
  const unlock = JSON.parse(unlockRaw);
  if (Date.now() > unlock.expiresAt) {
    return json({ error: 'Custodial unlock expired. Re-enter your password.' }, 403);
  }

  let body;
  try { body = await request.json(); } catch (_) {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { action } = body;
  if (!action || !['signTransaction', 'signMessage', 'sendTransaction', 'signTypedData'].includes(action)) {
    return json({ error: 'Invalid action: must be signTransaction, signMessage, sendTransaction, or signTypedData' }, 400);
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
    privateKey = await decryptWallet(user.wallet.encryptedKey, serverSecret);
  } catch (e) {
    return json({ error: 'Failed to decrypt wallet key' }, 500);
  }

  const rpc = env.ARC_RPC_URL || 'https://arc-testnet.drpc.org';
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

    // SECURITY: EIP-712 typed-data signing. This is a signature, not a transaction,
    // so the SIGN_ALLOWLIST tx policy does NOT apply and to/value/data are ignored.
    if (action === 'signTypedData') {
      const { domain, types, value } = body;
      if (!domain || typeof domain !== 'object') {
        return json({ error: 'domain object required for signTypedData' }, 400);
      }
      if (!types || typeof types !== 'object') {
        return json({ error: 'types object required for signTypedData' }, 400);
      }
      if (!value || typeof value !== 'object') {
        return json({ error: 'value object required for signTypedData' }, 400);
      }
      // ethers v6 derives the domain separator itself — EIP712Domain must be absent.
      const sanitizedTypes = { ...types };
      delete sanitizedTypes.EIP712Domain;
      const signature = await wallet.signTypedData(domain, sanitizedTypes, value);
      return json({ ok: true, signature, address: wallet.address });
    }

    if (action === 'signTransaction') {
      const { transaction } = body;
      if (!transaction || typeof transaction !== 'object') {
        return json({ error: 'Transaction object required' }, 400);
      }
      const policy = checkTxPolicy(transaction, env);
      if (!policy.allowed) {
        console.warn('[AUTH/SIGN] transaction rejected by policy');
        return json({ error: 'Transaction not allowed' }, 403);
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
      const policy = checkTxPolicy(transaction, env);
      if (!policy.allowed) {
        console.warn('[AUTH/SIGN] transaction rejected by policy');
        return json({ error: 'Transaction not allowed' }, 403);
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
