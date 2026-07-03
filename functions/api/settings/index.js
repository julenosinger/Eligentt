import { getAuthCors } from '../auth/_cors.mjs';

function mkJson(headers) {
  return (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
}

const SENSITIVE_FIELDS = [
  'apiKey', 'secret', 'clientSecret', 'entitySecret', 'webhookSecret',
  'privateKey', 'token', 'password', 'key', 'encryptedKey'
];

function redactSensitive(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_FIELDS.some(f => k.toLowerCase().includes(f.toLowerCase()))) {
      out[k] = v ? '••••••' : '';
    } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      out[k] = redactSensitive(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function getSessionUser(request, env) {
  const KV = env.AUTH_KV;
  if (!KV) return null;
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token || token.length < 32) return null;
  const sessionRaw = await KV.get(`session:${token}`);
  if (!sessionRaw) return null;
  const session = JSON.parse(sessionRaw);
  const userRaw = await KV.get(`user:${session.email}`);
  if (!userRaw) return null;
  return { ...JSON.parse(userRaw), sessionToken: token };
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: getAuthCors(context.request, context.env) });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const headers = getAuthCors(request, env);
  const json = mkJson(headers);
  const KV = env.AUTH_KV;
  if (!KV) return json({ error: 'AUTH_KV not configured' }, 503);

  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Authentication required' }, 401);

  const settingsRaw = await KV.get(`settings:${user.id}`);
  const settings = settingsRaw ? JSON.parse(settingsRaw) : {};

  return json({
    ok: true,
    userId: user.id,
    updatedAt: settings._updatedAt || null,
    settings: redactSensitive(settings),
  });
}

export async function onRequestPut(context) {
  const { request, env } = context;
  const headers = getAuthCors(request, env);
  const json = mkJson(headers);
  const KV = env.AUTH_KV;
  if (!KV) return json({ error: 'AUTH_KV not configured' }, 503);

  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Authentication required' }, 401);

  let body;
  try { body = await request.json(); } catch (e) {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const existingRaw = await KV.get(`settings:${user.id}`);
  const existing = existingRaw ? JSON.parse(existingRaw) : {};

  const merged = { ...existing, ...body, _updatedAt: Date.now(), _updatedBy: user.id };

  await KV.put(`settings:${user.id}`, JSON.stringify(merged));

  const historyKey = `settings-audit:${user.id}`;
  const history = await KV.get(historyKey);
  const auditEntries = history ? JSON.parse(history) : [];
  auditEntries.push({
    ts: Date.now(),
    userId: user.id,
    device: request.headers.get('User-Agent') || '',
    ip: request.headers.get('CF-Connecting-IP') || '',
    changes: Object.keys(body).filter(k => !['_updatedAt', '_updatedBy'].includes(k)),
  });
  if (auditEntries.length > 200) auditEntries.splice(0, auditEntries.length - 200);
  await KV.put(historyKey, JSON.stringify(auditEntries));

  return json({
    ok: true,
    userId: user.id,
    updatedAt: merged._updatedAt,
    settings: redactSensitive(merged),
  });
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const headers = getAuthCors(request, env);
  const json = mkJson(headers);
  const KV = env.AUTH_KV;
  if (!KV) return json({ error: 'AUTH_KV not configured' }, 503);

  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Authentication required' }, 401);

  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (key) {
    const existingRaw = await KV.get(`settings:${user.id}`);
    const existing = existingRaw ? JSON.parse(existingRaw) : {};
    delete existing[key];
    existing._updatedAt = Date.now();
    await KV.put(`settings:${user.id}`, JSON.stringify(existing));
    return json({ ok: true, deleted: key });
  }

  await KV.delete(`settings:${user.id}`);
  return json({ ok: true, message: 'All settings cleared' });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const headers = getAuthCors(request, env);
  const json = mkJson(headers);
  const KV = env.AUTH_KV;
  if (!KV) return json({ error: 'AUTH_KV not configured' }, 503);

  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Authentication required' }, 401);

  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action === 'audit') {
    const historyKey = `settings-audit:${user.id}`;
    const history = await KV.get(historyKey);
    const auditEntries = history ? JSON.parse(history) : [];
    return json({ ok: true, audit: auditEntries.slice(-100).reverse() });
  }

  if (action === 'backup') {
    const settingsRaw = await KV.get(`settings:${user.id}`);
    const settings = settingsRaw ? JSON.parse(settingsRaw) : {};
    return json({
      ok: true,
      backup: { settings, exportedAt: Date.now(), userId: user.id },
    });
  }

  if (action === 'restore') {
    let body;
    try { body = await request.json(); } catch (e) {
      return json({ error: 'Invalid JSON body' }, 400);
    }
    if (!body.settings) return json({ error: 'Missing settings field' }, 400);
    const restored = { ...body.settings, _updatedAt: Date.now(), _restoredAt: Date.now() };
    await KV.put(`settings:${user.id}`, JSON.stringify(restored));
    return json({ ok: true, message: 'Settings restored' });
  }

  if (action === 'export') {
    const settingsRaw = await KV.get(`settings:${user.id}`);
    const settings = settingsRaw ? JSON.parse(settingsRaw) : {};
    const exported = { settings, exportedAt: Date.now(), userId: user.id, version: '1.0' };
    return new Response(JSON.stringify(exported, null, 2), {
      status: 200,
      headers: {
        ...headers,
        'Content-Disposition': `attachment; filename="elligentt-settings-${user.id}.json"`,
      },
    });
  }

  return json({ error: 'Unknown action' }, 400);
}
