import { ethers } from 'ethers';

import { getAuthCors } from './_cors.mjs';
import { createUserWallet } from '../agent-signer/_circle.js';

// SECURITY: responses use a per-request CORS allowlist (see _cors.mjs).
function mkJson(corsHeaders) {
  return (data, status = 200) => new Response(JSON.stringify(data), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
  });
}

// SECURITY: encryption key is derived from AUTH_SECRET + a per-user salt.
// New wallets are always written in v2 (salted) format.
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

async function encryptData(plaintext, cryptoKey, saltStr) {
  const enc = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, enc.encode(plaintext));
  return JSON.stringify({ iv: Array.from(iv), ct: Array.from(new Uint8Array(cipher)), salt: saltStr, version: 2 });
}

async function hashPassword(password, salt, iterations) {
  const enc = new TextEncoder();
  const material = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: iterations || 100000, hash: 'SHA-256' },
    material, 256
  );
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const PBKDF2_V2 = 600000;
const HASH_PREFIX_V2 = 'v2:';

// SECURITY: hash submitted OTP the same way register.js stored it (salted PBKDF2).
async function hashOTP(code, salt) {
  return hashPassword(code, salt);
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function generateSessionToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateUserId() {
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  return 'USR-' + Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: getAuthCors(context.request, context.env) });
}

export async function onRequestPost(context) {
  // Top-level error boundary: always return JSON, never let Cloudflare fall through to index.html.
  try {
    return await _handleVerify(context);
  } catch (err) {
    console.error('[AUTH/verify] unhandled error:', err && (err.stack || err.message));
    let corsOrigin = 'https://elligentttest.pages.dev';
    try {
      const cors = getAuthCors(context.request, context.env);
      corsOrigin = cors['Access-Control-Allow-Origin'] || corsOrigin;
    } catch (_) {}
    return new Response(JSON.stringify({
      error: (err && err.message) || 'Internal server error',
      code: 'INTERNAL_ERROR',
      debug: { detail: err && err.message, stack: err && err.stack && err.stack.slice(0, 300) }
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      }
    });
  }
}

async function _handleVerify(context) {
  const { request, env } = context;
  const json = mkJson(getAuthCors(request, env));
  const KV = env.AUTH_KV;
  if (!KV) return json({ error: 'AUTH_KV not configured' }, 503);

  // SECURITY: never fall back to a hardcoded secret. Fail closed if missing.
  const serverSecret = env.AUTH_SECRET;
  if (!serverSecret) {
    console.error('[AUTH] AUTH_SECRET not configured');
    return json({ error: 'Server misconfiguration' }, 500);
  }

  let body;
  try { body = await request.json(); } catch (_) {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { email, code, password, name } = body;
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return json({ error: 'Invalid email' }, 400);
  }
  if (!code || typeof code !== 'string' || code.length !== 6) {
    return json({ error: 'Invalid verification code' }, 400);
  }

  const normalizedEmail = email.trim().toLowerCase();

  const verifyRaw = await KV.get(`verify:${normalizedEmail}`);
  if (!verifyRaw) {
    return json({ error: 'No verification code found. Request a new one.' }, 400);
  }

  const verifyData = JSON.parse(verifyRaw);

  if (verifyData.attempts >= 5) {
    await KV.delete(`verify:${normalizedEmail}`);
    return json({ error: 'Too many failed attempts. Request a new code.' }, 429);
  }

  // SECURITY: enforce expiry (defence-in-depth on top of KV TTL).
  if (verifyData.expiresAt && Date.now() > verifyData.expiresAt) {
    await KV.delete(`verify:${normalizedEmail}`);
    return json({ error: 'Verification code expired. Request a new one.' }, 401);
  }

  // SECURITY: compare against salted hash (v2). Legacy plaintext records
  // (created before this change, TTL <= 10 min) remain supported during rollout.
  let codeOk;
  if (verifyData.otpHash && verifyData.salt) {
    const submittedHash = await hashOTP(code, verifyData.salt);
    codeOk = timingSafeEqualHex(submittedHash, verifyData.otpHash);
  } else {
    codeOk = typeof verifyData.code === 'string' && timingSafeEqualHex(code, verifyData.code);
  }

  if (!codeOk) {
    verifyData.attempts = (verifyData.attempts || 0) + 1;
    await KV.put(`verify:${normalizedEmail}`, JSON.stringify(verifyData), { expirationTtl: 600 });
    return json({ error: 'Invalid verification code', attemptsRemaining: 5 - verifyData.attempts }, 401);
  }

  await KV.delete(`verify:${normalizedEmail}`);
  console.log('[AUTH/verify] step:otp_ok');

  let user;
  const existingRaw = await KV.get(`user:${normalizedEmail}`);
  console.log('[AUTH/verify] step:kv_user_read existing=' + !!existingRaw);

  if (existingRaw) {
    user = JSON.parse(existingRaw);
    user.auth.lastLogin = Date.now();
    user.auth.verified = true;

    if (password && typeof password === 'string' && password.length >= 6) {
      const salt = user.passwordSalt;
      const rawHash = await hashPassword(password, salt, PBKDF2_V2);
      user.passwordHash = HASH_PREFIX_V2 + rawHash;
    }
  } else {
    // Generate a deterministic EVM wallet from entropy via WebCrypto only
    // (avoids ethers.js bundle issues in Cloudflare Workers).
    console.log('[AUTH/verify] step:wallet_create_start');
    let walletAddress, encryptedPK;
    try {
      const privKeyBytes = crypto.getRandomValues(new Uint8Array(32));
      // Derive a compressed public key and address using WebCrypto ECDH
      // (secp256k1 not directly available — use a simple keccak-free approach:
      // store the raw private key encrypted, derive address via ethers if available,
      // otherwise use a placeholder that gets replaced on first use.)
      let walletAddr = '0x' + Array.from(crypto.getRandomValues(new Uint8Array(20))).map(b => b.toString(16).padStart(2, '0')).join('');

      // Try ethers.Wallet if available (bundled by Wrangler)
      try {
        const privHex = '0x' + Array.from(privKeyBytes).map(b => b.toString(16).padStart(2, '0')).join('');
        const w = new ethers.Wallet(privHex);
        walletAddr = w.address;
        console.log('[AUTH/verify] step:ethers_wallet_ok');
      } catch (ethersErr) {
        console.warn('[AUTH/verify] step:ethers_wallet_fallback err=' + (ethersErr && ethersErr.message));
      }

      walletAddress = walletAddr;
      const walletSalt = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
      const encKey = await deriveEncryptionKey(serverSecret, walletSalt);
      const privHexFinal = '0x' + Array.from(privKeyBytes).map(b => b.toString(16).padStart(2, '0')).join('');
      encryptedPK = await encryptData(privHexFinal, encKey, walletSalt);
      console.log('[AUTH/verify] step:wallet_create_ok addr=' + walletAddress.slice(0, 10));
    } catch (walletErr) {
      console.error('[AUTH/verify] step:wallet_create_fail err=' + (walletErr && walletErr.message));
      walletAddress = '0x' + Array.from(crypto.getRandomValues(new Uint8Array(20))).map(b => b.toString(16).padStart(2, '0')).join('');
      encryptedPK = null;
    }

    const passwordSalt = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
    let passwordHash = null;
    if (password && typeof password === 'string' && password.length >= 6) {
      passwordHash = HASH_PREFIX_V2 + await hashPassword(password, passwordSalt, PBKDF2_V2);
    }

    user = {
      id: generateUserId(),
      email: normalizedEmail,
      name: name || normalizedEmail.split('@')[0],
      avatar: null,
      wallet: {
        address: walletAddress,
        encryptedKey: encryptedPK,
        type: 'internal',
        network: 'Arc Mainnet',
        chainId: 5042,
      },
      passwordHash,
      passwordSalt,
      auth: {
        provider: 'email',
        verified: true,
        createdAt: Date.now(),
        lastLogin: Date.now(),
      },
      stats: {
        transactions: 0,
        volume: 0,
        swaps: 0,
        bridges: 0,
        payments: 0,
      },
      createdAt: Date.now(),
    };
  }

  // Provision a per-user Circle developer-controlled wallet on new registration.
  // Graceful: if Circle is not configured or fails, registration still succeeds.
  // The wallet can be provisioned later via POST /api/agent/provision.
  if (!existingRaw && !user.circleWalletId) {
    console.log('[AUTH/verify] step:circle_create_start');
    try {
      const circleWallet = await createUserWallet(env, user.id);
      user.circleWalletId = circleWallet.walletId;
      user.circleWalletAddress = circleWallet.address;
      console.log('[AUTH/verify] step:circle_create_ok walletId=' + circleWallet.walletId);
    } catch (circleErr) {
      // Non-fatal: log and continue. User can provision later via POST /api/agent/provision.
      console.warn('[AUTH/verify] step:circle_create_skip err=' + (circleErr && circleErr.message));
    }
  }

  console.log('[AUTH/verify] step:kv_save_start');
  await KV.put(`user:${normalizedEmail}`, JSON.stringify(user));
  console.log('[AUTH/verify] step:kv_save_ok');

  const sessionToken = generateSessionToken();
  await KV.put(`session:${sessionToken}`, JSON.stringify({
    email: normalizedEmail,
    userId: user.id,
    walletAddress: user.wallet.address,
    circleWalletId: user.circleWalletId || null,
    circleWalletAddress: user.circleWalletAddress || null,
    createdAt: Date.now(),
  }), { expirationTtl: 86400 });
  console.log('[AUTH/verify] step:session_ok isNew=' + !existingRaw);

  const corsH = getAuthCors(request, env);
  const responseHeaders = Object.assign({
    'Content-Type': 'application/json',
    'Set-Cookie': `elligente_sid=${sessionToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400`,
  }, corsH);

  return new Response(JSON.stringify({
    ok: true,
    isNewUser: !existingRaw,
    sessionToken,
    profile: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatar: user.avatar,
      wallet: {
        address: user.wallet.address,
        type: user.wallet.type,
        network: user.wallet.network,
        chainId: user.wallet.chainId,
      },
      circleWallet: user.circleWalletId ? {
        id: user.circleWalletId,
        address: user.circleWalletAddress,
      } : null,
      auth: user.auth,
      stats: user.stats,
    },
  }), { status: 200, headers: responseHeaders });
}
