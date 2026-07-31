var _memFallback = new Map();

export async function checkRateLimit(kv, { identifier, endpoint, limit = 20, windowMs = 60000 }) {
  if (!kv) {
    var now2 = Date.now();
    var fbKey = endpoint + ':' + identifier;
    var fb = _memFallback.get(fbKey);
    if (!fb || (now2 - fb.windowStart) > windowMs) { fb = { count: 0, windowStart: now2 }; }
    if (fb.count >= limit) { return { allowed: false, remaining: 0, resetAt: fb.windowStart + windowMs, retryAfter: Math.ceil((fb.windowStart + windowMs - now2) / 1000) || 1 }; }
    fb.count++;
    _memFallback.set(fbKey, fb);
    return { allowed: true, remaining: limit - fb.count, resetAt: fb.windowStart + windowMs };
  }

  const key = `rate:${endpoint}:${identifier}`;
  const now = Date.now();

  let data;
  try {
    const raw = await kv.get(key);
    data = raw ? JSON.parse(raw) : null;
  } catch (_) {
    data = null;
  }

  if (!data || (now - data.windowStart) > windowMs) {
    data = { count: 0, windowStart: now };
  }

  if (data.count >= limit) {
    const resetAt = data.windowStart + windowMs;
    return {
      allowed: false,
      remaining: 0,
      resetAt,
      retryAfter: Math.max(1, Math.ceil((resetAt - now) / 1000)),
    };
  }

  data.count++;
  const ttl = Math.ceil(windowMs / 1000) + 60;

  try {
    await kv.put(key, JSON.stringify(data), { expirationTtl: ttl });
  } catch (_) {}

  return {
    allowed: true,
    remaining: limit - data.count,
    resetAt: data.windowStart + windowMs,
  };
}

export async function checkRelayLimit(kv, identifier) {
  return checkRateLimit(kv, { identifier, endpoint: 'relayer', limit: 20, windowMs: 60000 });
}

export async function checkMintLimit(kv, identifier) {
  return checkRateLimit(kv, { identifier, endpoint: 'mint', limit: 20, windowMs: 60000 });
}

export async function checkPaymentLimit(kv, identifier) {
  return checkRateLimit(kv, { identifier, endpoint: 'payment', limit: 30, windowMs: 60000 });
}
