import { ethers } from 'ethers';

import { getAuthCors } from './_cors.mjs';

// SECURITY: responses use a per-request CORS allowlist (see _cors.mjs).
function mkJson(headers) {
  return (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
}

// SECURITY: OTP is never stored in plaintext nor returned in the response.
// We persist only a salted PBKDF2 hash so a KV leak does not expose live codes.
function randomSaltHex(bytes = 16) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hashOTP(code, salt) {
  const enc = new TextEncoder();
  const material = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
    material, 256
  );
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// SECURITY: OTP delivery via Resend transactional email. The raw code is handed
// only to the email transport — never logged, stored in plaintext, or returned.
// If RESEND_API_KEY is not configured this stays a no-op so registration never
// breaks (the hashed code remains in KV).
async function deliverVerificationCode(env, email, code) {
  const apiKey = env && env.RESEND_API_KEY;
  if (!apiKey) return;
  const from = (env && env.MAIL_FROM) || 'Elligentt <noreply@elligentt.xyz>';
  const subject = 'Your Elligentt verification code';
  const text = 'Your Elligentt verification code is ' + code +
    '. It expires in 10 minutes. If you did not request this, ignore this email.';
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px">' +
    '<div style="font-size:18px;font-weight:800;color:#0f1117;margin-bottom:6px">Elligentt</div>' +
    '<div style="font-size:13px;color:#475569;margin-bottom:16px">Use this code to verify your account:</div>' +
    '<div style="font-size:30px;font-weight:800;letter-spacing:8px;background:#0f1117;color:#fff;padding:16px;border-radius:10px;text-align:center">' +
    code + '</div>' +
    '<div style="font-size:12px;color:#94a3b8;margin-top:16px">This code expires in 10 minutes. If you did not request it, you can safely ignore this email.</div>' +
    '</div>';
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [email], subject, text, html }),
    });
    // OBSERVABILITY: log only transport status — never the code, email, or key.
    if (!resp.ok) {
      console.log(JSON.stringify({ event: 'email_send_failed', status: resp.status, ts: Date.now() }));
    }
  } catch (_) {
    // Delivery failure must not break registration; the hashed code stays in KV.
    console.log(JSON.stringify({ event: 'email_send_error', ts: Date.now() }));
  }
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

  // SECURITY: persist only a salted hash + TTL, never the raw code.
  const TTL_SECONDS = 600;
  const otpSalt = randomSaltHex();
  const otpHash = await hashOTP(code, otpSalt);

  await KV.put(`verify:${normalizedEmail}`, JSON.stringify({
    otpHash,
    salt: otpSalt,
    expiresAt: Date.now() + TTL_SECONDS * 1000,
    attempts: 0,
    version: 2,
  }), { expirationTtl: TTL_SECONDS });

  await KV.put(rateLimitKey, '1', { expirationTtl: 60 });

  const existingUser = await KV.get(`user:${normalizedEmail}`);
  const isNewUser = !existingUser;

  // SECURITY: hand the raw code to the email transport only; do not log or return it.
  await deliverVerificationCode(env, normalizedEmail, code);

  return json({
    ok: true,
    success: true,
    email: normalizedEmail,
    isNewUser,
    message: 'Verification code sent',
  }, 200);
}
