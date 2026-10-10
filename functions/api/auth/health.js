import { getAuthCors } from './_cors.mjs';

export async function onRequestGet(context) {
  const headers = getAuthCors(context.request, context.env);
  const kv = context.env.AUTH_KV;
  return new Response(JSON.stringify({
    ok: true,
    ts: Date.now(),
    kv: !!kv,
    authSecret: !!context.env.AUTH_SECRET,
    circleKey: !!context.env.CIRCLE_API_KEY,
  }), { status: 200, headers });
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: getAuthCors(context.request, context.env) });
}
