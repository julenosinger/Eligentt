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

  const { email } = body;
  if (!email || typeof email !== 'string' || !email.includes('@') || email.length > 320) {
    return json({ error: 'Invalid email address' }, 400);
  }

  const normalizedEmail = email.trim().toLowerCase();

  const rateLimitKey = `ratelimit:register:${normalizedEmail}`;
  const lastAttempt = await KV.get(rateLimitKey);
  if (lastAttempt) {
    return json({ error: 'Verification code already sent. Wait 60 seconds.' }, 429);
  }

  const codeArr = new Uint32Array(1);
  crypto.getRandomValues(codeArr);
  const code = String(codeArr[0] % 900000 + 100000);

  await KV.put(`verify:${normalizedEmail}`, JSON.stringify({
    code,
    createdAt: Date.now(),
    attempts: 0,
  }), { expirationTtl: 600 });

  await KV.put(rateLimitKey, '1', { expirationTtl: 60 });

  const existingUser = await KV.get(`user:${normalizedEmail}`);
  const isNewUser = !existingUser;

  console.log(`[AUTH] Verification code for ${normalizedEmail}: ${code}`);

  return json({
    ok: true,
    email: normalizedEmail,
    isNewUser,
    message: 'Verification code sent',
    _testCode: code,
  }, 200);
}
