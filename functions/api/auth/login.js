import { getAuthCors } from './_cors.mjs';

function mkJson(headers) {
  return (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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

const PBKDF2_V1 = 100000;
const PBKDF2_V2 = 600000;
const HASH_PREFIX_V1 = 'v1:';
const HASH_PREFIX_V2 = 'v2:';

function versionedHash(hexHash, version) {
  return (version === 2 ? HASH_PREFIX_V2 : HASH_PREFIX_V1) + hexHash;
}

async function verifyAndRehash(password, storedHash, salt, KV, normalizedEmail, user) {
  let ok = false;
  let rehash = false;
  if (storedHash.startsWith(HASH_PREFIX_V2)) {
    const expected = storedHash.substring(HASH_PREFIX_V2.length);
    const computed = await hashPassword(password, salt, PBKDF2_V2);
    ok = timingSafeEqualHex(computed, expected);
  } else if (storedHash.startsWith(HASH_PREFIX_V1)) {
    const expected = storedHash.substring(HASH_PREFIX_V1.length);
    const computed = await hashPassword(password, salt, PBKDF2_V1);
    ok = timingSafeEqualHex(computed, expected);
    rehash = ok; // rehash on successful v1 login
  } else {
    const computed = await hashPassword(password, salt, PBKDF2_V1);
    ok = timingSafeEqualHex(computed, storedHash);
    rehash = ok;
  }
  if (ok && rehash) {
    const newHash = await hashPassword(password, salt, PBKDF2_V2);
    user.passwordHash = versionedHash(newHash, 2);
    try { await KV.put(`user:${normalizedEmail}`, JSON.stringify(user)); } catch (_) {}
  }
  return ok;
}

function generateSessionToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

// SECURITY: per-email login throttling (anti brute-force) — 5 attempts / 15 min.
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 900000;

async function getLoginAttempts(KV, email) {
  try {
    const raw = await KV.get(`login_attempt:${email}`);
    if (!raw) return { count: 0, windowStart: Date.now() };
    const data = JSON.parse(raw);
    if (Date.now() - data.windowStart > LOGIN_WINDOW_MS) return { count: 0, windowStart: Date.now() };
    return data;
  } catch (_) {
    return { count: 0, windowStart: Date.now() };
  }
}

async function recordLoginFailure(KV, email) {
  const data = await getLoginAttempts(KV, email);
  data.count = (data.count || 0) + 1;
  try {
    await KV.put(`login_attempt:${email}`, JSON.stringify(data), { expirationTtl: Math.ceil(LOGIN_WINDOW_MS / 1000) });
  } catch (_) {}
}

async function clearLoginAttempts(KV, email) {
  try { await KV.delete(`login_attempt:${email}`); } catch (_) {}
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: getAuthCors(context.request, context.env) });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const json = mkJson(getAuthCors(request, env));
  const KV = env.AUTH_KV;
  if (!KV) return json({ error: 'AUTH_KV not configured' }, 503);

  let body;
  try { body = await request.json(); } catch (_) {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { email, password } = body;
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return json({ error: 'Invalid email' }, 400);
  }
  if (!password || typeof password !== 'string') {
    return json({ error: 'Password required' }, 400);
  }

  const normalizedEmail = email.trim().toLowerCase();

  // SECURITY: throttle brute-force attempts before touching credentials.
  const attempts = await getLoginAttempts(KV, normalizedEmail);
  if (attempts.count >= LOGIN_MAX_ATTEMPTS) {
    return json({ error: 'Too many login attempts. Try again later.' }, 429);
  }

  // SECURITY: generic 'Invalid credentials' for every failure — no user enumeration.
  const userRaw = await KV.get(`user:${normalizedEmail}`);
  if (!userRaw) {
    await recordLoginFailure(KV, normalizedEmail);
    return json({ error: 'Invalid credentials' }, 401);
  }

  const user = JSON.parse(userRaw);

  if (!user.passwordHash || !user.passwordSalt) {
    await recordLoginFailure(KV, normalizedEmail);
    return json({ error: 'Invalid credentials' }, 401);
  }

  const verified = await verifyAndRehash(password, user.passwordHash, user.passwordSalt, KV, normalizedEmail, user);
  if (!verified) {
    await recordLoginFailure(KV, normalizedEmail);
    return json({ error: 'Invalid credentials' }, 401);
  }

  // SECURITY: successful login clears the failure counter.
  await clearLoginAttempts(KV, normalizedEmail);

  user.auth.lastLogin = Date.now();
  await KV.put(`user:${normalizedEmail}`, JSON.stringify(user));

  const sessionToken = generateSessionToken();
  await KV.put(`session:${sessionToken}`, JSON.stringify({
    email: normalizedEmail,
    userId: user.id,
    walletAddress: user.wallet.address,
    createdAt: Date.now(),
  }), { expirationTtl: 86400 });

  console.log('[AUTH] password login successful');

  const ownerId = env.OWNER_USER_ID || '';
  const headers = getAuthCors(request, env);
  headers.set('Set-Cookie', `elligente_sid=${sessionToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400`);

  return new Response(JSON.stringify({
    ok: true,
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
      permissions: {
        settings: !!(ownerId && user.id === ownerId),
      },
    },
  }), { status: 200, headers });
}
