/**
 * GET /api/lifi/tokens?chainId=8453[,1,42161,...]
 * Server-side proxy for the LI.FI /tokens endpoint.
 * - Keeps LIFI_API_KEY server-side only.
 * - Caches the response in a Cloudflare Cache API bucket for 10 minutes.
 * - Filters to ONLY the chains Elligentt supports.
 * - Returns { ok: true, tokens: { [chainId]: TokenObject[] } }
 */

const LIFI_BASE = 'https://li.quest/v1';
const CACHE_TTL_SECONDS = 600; // 10 min
const ALLOWED_CHAIN_IDS = new Set([5042, 1, 8453, 42161, 10, 137]);

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, headers || {}),
  });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);

  // Parse requested chain IDs from query param; default to all supported.
  const rawChains = url.searchParams.get('chainId') || '';
  let requestedChains;
  if (rawChains) {
    requestedChains = rawChains.split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n) && ALLOWED_CHAIN_IDS.has(n));
  } else {
    requestedChains = Array.from(ALLOWED_CHAIN_IDS);
  }
  if (!requestedChains.length) {
    return json({ ok: false, error: 'No supported chains in request' }, 400);
  }

  // Build a stable cache key from sorted chain IDs.
  const cacheKey = 'https://lifi-tokens-cache/' + requestedChains.slice().sort().join(',');
  const cache = caches.default;

  // Try cache first.
  const cached = await cache.match(cacheKey).catch(() => null);
  if (cached) {
    const body = await cached.json().catch(() => null);
    if (body && body.ok) return json(body);
  }

  // Fetch from LI.FI.
  const lifiUrl = new URL(LIFI_BASE + '/tokens');
  lifiUrl.searchParams.set('chainTypes', 'EVM');
  // We'll fetch all tokens and filter client-side by our allowed chains.
  const headers = { 'Accept': 'application/json', 'User-Agent': 'elligentt/1.0' };
  const key = (env && env.LIFI_API_KEY) || '';
  if (key) headers['x-lifi-api-key'] = key;

  let lifiResp;
  try {
    lifiResp = await fetch(lifiUrl.toString(), { headers, cf: { cacheTtl: 0 } });
  } catch (e) {
    return json({ ok: false, error: 'LI.FI request failed: ' + (e && e.message) }, 502);
  }

  if (!lifiResp.ok) {
    const errText = await lifiResp.text().catch(() => '');
    return json({ ok: false, error: 'LI.FI error ' + lifiResp.status, detail: errText.slice(0, 200) }, 502);
  }

  let data;
  try { data = await lifiResp.json(); } catch (_) {
    return json({ ok: false, error: 'LI.FI returned invalid JSON' }, 502);
  }

  // LI.FI returns: { tokens: { "1": [...], "8453": [...], ... } }
  const rawTokens = (data && data.tokens) ? data.tokens : {};
  const filtered = {};
  for (const chainId of requestedChains) {
    const arr = rawTokens[String(chainId)];
    if (!Array.isArray(arr)) continue;
    // Normalize + filter to essential fields only.
    filtered[chainId] = arr.map(t => ({
      chainId: Number(t.chainId || chainId),
      address: (t.address || '').toLowerCase(),
      symbol: t.symbol || '',
      name: t.name || t.symbol || '',
      decimals: Number(t.decimals) || 18,
      logoURI: t.logoURI || null,
      priceUSD: t.priceUSD ? String(t.priceUSD) : null,
    })).filter(t => t.symbol && t.address);
  }

  const result = { ok: true, tokens: filtered };

  // Cache the successful response.
  const cacheResp = new Response(JSON.stringify(result), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=' + CACHE_TTL_SECONDS,
    },
  });
  await cache.put(cacheKey, cacheResp).catch(() => null);

  return json(result);
}
