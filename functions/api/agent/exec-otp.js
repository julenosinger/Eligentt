/**
 * POST /api/agent/exec-otp
 *
 * Two-phase endpoint for email OTP-based execution authorization:
 *
 *   Phase 1 — request:  { action: 'request', intentId, operation, amount, asset, destination }
 *             → sends 6-digit OTP to the authenticated user's email
 *             → returns { ok: true, sent: true, expiresIn: 300 }
 *
 *   Phase 2 — verify:   { action: 'verify', intentId, code }
 *             → validates OTP, returns a signed execution token
 *             → returns { ok: true, execToken, circleWalletId, circleWalletAddress }
 *
 * The execToken is a short-lived (5 min) HMAC-signed claim that the Autonoma
 * execution path accepts in place of the front-end authorization object.
 * It binds: intentId + userId + circleWalletId + operation + amount + expiresAt.
 *
 * SECURITY:
 *   - OTP stored only as salted PBKDF2 hash in KV (TTL 5 min)
 *   - Max 3 attempts per intentId before lockout (1 min)
 *   - execToken is HMAC-SHA256 signed with AUTH_SECRET — forgery requires the secret
 *   - execToken expires in 5 minutes and is single-use (consumed on verify)
 */

function mkJson(corsH) {
  return (data, status = 200) => new Response(JSON.stringify(data), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*' }, corsH),
  });
}

// ── Crypto helpers ──────────────────────────────────────────────────────────

function randomDigits(n) {
  const arr = crypto.getRandomValues(new Uint8Array(n * 2));
  return Array.from(arr).map(b => b % 10).join('').slice(0, n);
}

function randomHex(bytes = 16) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hashOTP(code, salt) {
  const enc = new TextEncoder();
  const mat = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' }, mat, 256);
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSign(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacVerify(secret, message, expectedSig) {
  const actual = await hmacSign(secret, message);
  // Constant-time compare
  if (actual.length !== expectedSig.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expectedSig.charCodeAt(i);
  return diff === 0;
}

// ── Session extraction (same pattern as agent [[path]].js) ─────────────────

function extractSessionToken(req) {
  const auth = req.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const cookie = req.headers.get('Cookie') || '';
  const m = cookie.match(/(?:^|;\s*)elligente_sid=([^;]+)/);
  return m ? m[1].trim() : null;
}

async function resolveSession(KV, req) {
  const token = extractSessionToken(req);
  if (!token || token.length < 16) return null;
  try {
    const raw = await KV.get('session:' + token);
    if (!raw) return null;
    const sess = JSON.parse(raw);
    if (!sess || !sess.userId) return null;
    if (sess.expiresAt && Date.now() > sess.expiresAt) return null;
    return sess; // { userId, email, circleWalletId, circleWalletAddress, ... }
  } catch (_) { return null; }
}

// ── Email delivery (same as register.js) ────────────────────────────────────

async function deliverExecOTP(env, email, code, operation, amount, asset) {
  const apiKey = env && env.RESEND_API_KEY;
  if (!apiKey) return; // no-op without key
  const from = (env && env.MAIL_FROM) || 'Elligentt <noreply@elligentt.xyz>';
  const opLabel = operation ? operation.charAt(0).toUpperCase() + operation.slice(1) : 'Operation';
  const amtLabel = amount ? ` ${amount} ${asset || 'USDC'}` : '';
  const subject = `Elligentt — confirm your ${opLabel}`;
  const text = `Your Elligentt authorization code for ${opLabel}${amtLabel} is ${code}. It expires in 5 minutes. If you did not request this, ignore this email.`;
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px">` +
    `<div style="font-size:18px;font-weight:800;color:#0f1117;margin-bottom:6px">Elligentt</div>` +
    `<div style="font-size:13px;color:#475569;margin-bottom:8px">Authorize this operation:</div>` +
    `<div style="font-size:14px;font-weight:700;color:#0f1117;background:#f1f5f9;padding:10px 16px;border-radius:8px;margin-bottom:12px">` +
    `${opLabel}${amtLabel}</div>` +
    `<div style="font-size:13px;color:#475569;margin-bottom:12px">Enter this code to confirm:</div>` +
    `<div style="font-size:30px;font-weight:800;letter-spacing:8px;background:#0f1117;color:#06F7E9;padding:16px;border-radius:10px;text-align:center">${code}</div>` +
    `<div style="font-size:12px;color:#94a3b8;margin-top:16px">Expires in 5 minutes. If you did not request this, ignore this email.</div>` +
    `</div>`;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [email], subject, text, html }),
    });
  } catch (_) {}
}

// ── Main handler ─────────────────────────────────────────────────────────────

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  }});
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const json = mkJson({});
  const KV = env.AUTH_KV;
  if (!KV) return json({ error: 'AUTH_KV not configured' }, 503);
  if (!env.AUTH_SECRET) return json({ error: 'Server misconfiguration' }, 503);

  const sess = await resolveSession(KV, request);
  if (!sess) return json({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch (_) {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { action, intentId, operation, amount, asset, destination, code } = body;

  if (!intentId || typeof intentId !== 'string' || intentId.length > 128) {
    return json({ error: 'Invalid intentId' }, 400);
  }

  // ── Phase 1: request OTP ──────────────────────────────────────────────────
  if (action === 'request') {
    // Rate limit: max 3 requests per intentId per user per 5 min
    const rlKey = `execotp:rl:${sess.userId}:${intentId}`;
    const rlRaw = await KV.get(rlKey);
    const rl = rlRaw ? JSON.parse(rlRaw) : { count: 0, firstAt: Date.now() };
    if (rl.count >= 3 && (Date.now() - rl.firstAt) < 5 * 60 * 1000) {
      return json({ error: 'Too many OTP requests. Please wait a few minutes.' }, 429);
    }

    const rawCode = randomDigits(6);
    const salt = randomHex(16);
    const hashed = await hashOTP(rawCode, salt);

    const otpKey = `execotp:${sess.userId}:${intentId}`;
    await KV.put(otpKey, JSON.stringify({
      hash: hashed, salt, attempts: 0,
      operation: operation || '', amount: amount || 0, asset: asset || 'USDC',
      destination: destination || '',
      createdAt: Date.now(),
    }), { expirationTtl: 300 }); // 5 min

    // Update rate limit counter
    await KV.put(rlKey, JSON.stringify({
      count: rl.count + 1, firstAt: rl.count === 0 ? Date.now() : rl.firstAt
    }), { expirationTtl: 300 });

    await deliverExecOTP(env, sess.email, rawCode, operation, amount, asset);

    console.log(JSON.stringify({ event: 'exec_otp_sent', userId: sess.userId,
      intentId, operation, ts: Date.now() }));

    return json({ ok: true, sent: true, email: sess.email, expiresIn: 300 });
  }

  // ── Phase 2: verify OTP ───────────────────────────────────────────────────
  if (action === 'verify') {
    if (!code || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      return json({ error: 'Invalid code format' }, 400);
    }

    const otpKey = `execotp:${sess.userId}:${intentId}`;
    const otpRaw = await KV.get(otpKey);
    if (!otpRaw) return json({ error: 'Code expired or not found' }, 400);

    let otp;
    try { otp = JSON.parse(otpRaw); } catch (_) {
      return json({ error: 'Invalid OTP state' }, 500);
    }

    if (otp.attempts >= 3) {
      await KV.delete(otpKey);
      return json({ error: 'Too many failed attempts. Request a new code.' }, 429);
    }

    const hashed = await hashOTP(code, otp.salt);
    if (hashed !== otp.hash) {
      otp.attempts = (otp.attempts || 0) + 1;
      if (otp.attempts >= 3) {
        await KV.delete(otpKey);
      } else {
        await KV.put(otpKey, JSON.stringify(otp), { expirationTtl: 300 });
      }
      const remaining = 3 - otp.attempts;
      return json({ error: `Invalid code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.` }, 401);
    }

    // OTP valid — consume it (single-use)
    await KV.delete(otpKey);

    // Build execToken: HMAC-signed claim
    const expiresAt = Date.now() + 5 * 60 * 1000;
    const payload = [
      sess.userId, intentId, sess.circleWalletId || '', otp.operation,
      String(otp.amount), otp.asset, otp.destination, String(expiresAt)
    ].join(':');
    const sig = await hmacSign(env.AUTH_SECRET, payload);
    const execToken = Buffer.from(JSON.stringify({ payload, sig })).toString('base64');

    console.log(JSON.stringify({ event: 'exec_otp_verified', userId: sess.userId,
      intentId, operation: otp.operation, ts: Date.now() }));

    return json({
      ok: true,
      execToken,
      circleWalletId: sess.circleWalletId || null,
      circleWalletAddress: sess.circleWalletAddress || null,
      operation: otp.operation,
      amount: otp.amount,
      asset: otp.asset,
      destination: otp.destination,
      expiresAt,
    });
  }

  return json({ error: 'Invalid action. Use "request" or "verify".' }, 400);
}
