import { getAuthCors } from './_cors.mjs';

// SECURITY: responses use a per-request CORS allowlist (see _cors.mjs).
function mkJson(headers) {
  return (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: getAuthCors(context.request, context.env) });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const json = mkJson(getAuthCors(request, env));
  const KV = env.AUTH_KV;
  if (!KV) return json({ error: 'AUTH_KV not configured' }, 503);

  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token || token.length < 32) {
    return json({ error: 'Invalid session token' }, 401);
  }

  const sessionRaw = await KV.get(`session:${token}`);
  if (!sessionRaw) {
    return json({ error: 'Session expired or invalid' }, 401);
  }

  const session = JSON.parse(sessionRaw);

  const userRaw = await KV.get(`user:${session.email}`);
  if (!userRaw) {
    return json({ error: 'User not found' }, 404);
  }

  const user = JSON.parse(userRaw);
  const ownerId = env.OWNER_USER_ID || '';

  return json({
    ok: true,
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
  });
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const json = mkJson(getAuthCors(request, env));
  const KV = env.AUTH_KV;
  if (!KV) return json({ error: 'AUTH_KV not configured' }, 503);

  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (token && token.length >= 32) {
    await KV.delete(`session:${token}`);
  }

  return json({ ok: true, message: 'Session destroyed' });
}
