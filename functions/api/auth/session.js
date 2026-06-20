const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet(context) {
  const { request, env } = context;
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
    },
  });
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const KV = env.AUTH_KV;
  if (!KV) return json({ error: 'AUTH_KV not configured' }, 503);

  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (token && token.length >= 32) {
    await KV.delete(`session:${token}`);
  }

  return json({ ok: true, message: 'Session destroyed' });
}
