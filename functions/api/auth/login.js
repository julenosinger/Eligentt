const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
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

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost(context) {
  const { request, env } = context;
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

  const userRaw = await KV.get(`user:${normalizedEmail}`);
  if (!userRaw) {
    return json({ error: 'Account not found. Create one first.' }, 404);
  }

  const user = JSON.parse(userRaw);

  if (!user.passwordHash || !user.passwordSalt) {
    return json({ error: 'No password set for this account. Use email verification to login.' }, 400);
  }

  const hash = await hashPassword(password, user.passwordSalt);
  if (hash !== user.passwordHash) {
    return json({ error: 'Invalid password' }, 401);
  }

  user.auth.lastLogin = Date.now();
  await KV.put(`user:${normalizedEmail}`, JSON.stringify(user));

  const sessionToken = generateSessionToken();
  await KV.put(`session:${sessionToken}`, JSON.stringify({
    email: normalizedEmail,
    userId: user.id,
    walletAddress: user.wallet.address,
    createdAt: Date.now(),
  }), { expirationTtl: 86400 });

  console.log(`[AUTH] Password login: ${normalizedEmail}`);

  return json({
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
    },
  });
}
