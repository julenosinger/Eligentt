import { getAuthCors } from '../auth/_cors.mjs';
import {
  validateAndSanitize,
  maskSensitiveForBackup,
  decryptSettingsForRead,
  encryptSettingsForWrite,
  autoMigrateIfNeeded,
} from './_validation.mjs';

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
      out[k] = v ? '\u2022\u2022\u2022\u2022\u2022\u2022' : '';
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
  const user = JSON.parse(userRaw);
  const ownerId = env.OWNER_USER_ID || '';
  return { ...user, sessionToken: token, isOwner: !!(ownerId && user.id === ownerId), _ownerId: ownerId };
}

function checkOwner(user, json) {
  if (!user || !user._ownerId) return null; // No OWNER_USER_ID configured — allow all
  if (!user.isOwner) {
    return json({ error: 'Access denied — settings are restricted to the application owner' }, 403);
  }
  return null;
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
  const denied = checkOwner(user, json); if (denied) return denied;

  const settingsRaw = await KV.get(`settings:${user.id}`);
  let settings = settingsRaw ? JSON.parse(settingsRaw) : {};

  const migrationAudit = [];
  const migrated = await autoMigrateIfNeeded(settings, env, migrationAudit);
  if (migrated.needsSave) {
    settings = migrated.settings;
    settings._updatedAt = Date.now();
    await KV.put(`settings:${user.id}`, JSON.stringify(settings));
    if (migrationAudit.length) {
      const historyKey = `settings-audit:${user.id}`;
      const history = await KV.get(historyKey);
      const auditEntries = history ? JSON.parse(history) : [];
      auditEntries.push({
        ts: Date.now(),
        userId: user.id,
        device: request.headers.get('User-Agent') || '',
        ip: request.headers.get('CF-Connecting-IP') || '',
        changes: migrationAudit,
      });
      if (auditEntries.length > 200) auditEntries.splice(0, auditEntries.length - 200);
      await KV.put(historyKey, JSON.stringify(auditEntries));
    }
  }

  settings = await decryptSettingsForRead(settings, env, null);

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
  const denied = checkOwner(user, json); if (denied) return denied;

  let body;
  try { body = await request.json(); } catch (e) {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const auditFields = [];
  const { result: validatedBody, ignored, rejected } = validateAndSanitize(body, auditFields);

  const changes = Object.keys(validatedBody).filter(k =>
    k !== '_updatedAt' && k !== '_updatedBy' && k !== '_restoredAt'
  );
  if (ignored.length) changes.push(...ignored.map(f => `ignored:${f}`));
  if (rejected.length) changes.push(...rejected.map(f => `rejected:${f}`));

  const existingRaw = await KV.get(`settings:${user.id}`);
  const existing = existingRaw ? JSON.parse(existingRaw) : {};

  const merged = { ...existing, ...validatedBody, _updatedAt: Date.now(), _updatedBy: user.id };

  const encrypted = await encryptSettingsForWrite(merged, env, auditFields);

  await KV.put(`settings:${user.id}`, JSON.stringify(encrypted));

  const historyKey = `settings-audit:${user.id}`;
  const history = await KV.get(historyKey);
  const auditEntries = history ? JSON.parse(history) : [];
  const allChanges = [...changes, ...auditFields];
  auditEntries.push({
    ts: Date.now(),
    userId: user.id,
    device: request.headers.get('User-Agent') || '',
    ip: request.headers.get('CF-Connecting-IP') || '',
    changes: allChanges.length ? allChanges : ['settings updated'],
  });
  if (auditEntries.length > 200) auditEntries.splice(0, auditEntries.length - 200);
  await KV.put(historyKey, JSON.stringify(auditEntries));

  const responseSettings = await decryptSettingsForRead(encrypted, env, null);

  return json({
    ok: true,
    userId: user.id,
    updatedAt: encrypted._updatedAt,
    ...(rejected.length ? { rejectedFields: rejected, warning: 'Some fields were rejected due to validation' } : {}),
    settings: redactSensitive(responseSettings),
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
  const denied = checkOwner(user, json); if (denied) return denied;

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
  const denied = checkOwner(user, json); if (denied) return denied;

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
    let settings = settingsRaw ? JSON.parse(settingsRaw) : {};

    settings = await decryptSettingsForRead(settings, env, null);

    const includeSecrets = url.searchParams.get('includeSecrets') === 'true';

    const exportSettings = includeSecrets ? settings : maskSensitiveForBackup(settings);

    return json({
      ok: true,
      backup: { settings: exportSettings, exportedAt: Date.now(), userId: user.id },
    });
  }

  if (action === 'restore') {
    let body;
    try { body = await request.json(); } catch (e) {
      return json({ error: 'Invalid JSON body' }, 400);
    }
    if (!body.settings) return json({ error: 'Missing settings field' }, 400);

    const { result: validated } = validateAndSanitize(body.settings, null);
    const restored = { ...validated, _updatedAt: Date.now(), _restoredAt: Date.now() };

    const encrypted = await encryptSettingsForWrite(restored, env, null);

    await KV.put(`settings:${user.id}`, JSON.stringify(encrypted));

    const responseSettings = await decryptSettingsForRead(encrypted, env, null);

    return json({
      ok: true,
      message: 'Settings restored',
      settings: redactSensitive(responseSettings),
    });
  }

  if (action === 'export') {
    const settingsRaw = await KV.get(`settings:${user.id}`);
    let settings = settingsRaw ? JSON.parse(settingsRaw) : {};

    settings = await decryptSettingsForRead(settings, env, null);

    const includeSecrets = url.searchParams.get('includeSecrets') === 'true';

    const exportSettings = includeSecrets ? settings : maskSensitiveForBackup(settings);

    const exported = {
      settings: exportSettings,
      exportedAt: Date.now(),
      userId: user.id,
      version: '1.0',
      secretsMasked: !includeSecrets,
    };

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
