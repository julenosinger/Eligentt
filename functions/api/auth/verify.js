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

async function encryptData(plaintext, cryptoKey) {
  const enc = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, enc.encode(plaintext));
  return JSON.stringify({ iv: Array.from(iv), ct: Array.from(new Uint8Array(cipher)), v: 1 });
}

async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const material = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
    material, 256
  );
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
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

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const KV = env.AUTH_KV;
  if (!KV) return json({ error: 'AUTH_KV not configured' }, 503);

  const serverSecret = env.AUTH_SECRET || 'elligente-default-secret-change-me';

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

  if (verifyData.code !== code) {
    verifyData.attempts++;
    await KV.put(`verify:${normalizedEmail}`, JSON.stringify(verifyData), { expirationTtl: 600 });
    return json({ error: 'Invalid verification code', attemptsRemaining: 5 - verifyData.attempts }, 401);
  }

  await KV.delete(`verify:${normalizedEmail}`);

  let user;
  const existingRaw = await KV.get(`user:${normalizedEmail}`);

  if (existingRaw) {
    user = JSON.parse(existingRaw);
    user.auth.lastLogin = Date.now();
    user.auth.verified = true;

    if (password && typeof password === 'string' && password.length >= 6) {
      const salt = user.passwordSalt;
      user.passwordHash = await hashPassword(password, salt);
    }
  } else {
    const wallet = ethers.Wallet.createRandom();
    const encKey = await deriveEncryptionKey(serverSecret);
    const encryptedPK = await encryptData(wallet.privateKey, encKey);

    const passwordSalt = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
    let passwordHash = null;
    if (password && typeof password === 'string' && password.length >= 6) {
      passwordHash = await hashPassword(password, passwordSalt);
    }

    user = {
      id: generateUserId(),
      email: normalizedEmail,
      name: name || normalizedEmail.split('@')[0],
      avatar: null,
      wallet: {
        address: wallet.address,
        encryptedKey: encryptedPK,
        type: 'internal',
        network: 'Arc Testnet',
        chainId: 5042002,
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

  await KV.put(`user:${normalizedEmail}`, JSON.stringify(user));

  const sessionToken = generateSessionToken();
  await KV.put(`session:${sessionToken}`, JSON.stringify({
    email: normalizedEmail,
    userId: user.id,
    walletAddress: user.wallet.address,
    createdAt: Date.now(),
  }), { expirationTtl: 86400 });

  console.log(`[AUTH] ${existingRaw ? 'Login' : 'Registration'} successful: ${normalizedEmail} → ${user.wallet.address}`);

  return json({
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
      auth: user.auth,
      stats: user.stats,
    },
  });
}
