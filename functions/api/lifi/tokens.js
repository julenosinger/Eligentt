/**
 * GET /api/lifi/tokens?chainId=8453[,1,42161,...]&tags=rwa
 * Server-side proxy for the LI.FI /tokens endpoint.
 * - Keeps LIFI_API_KEY server-side only.
 * - Caches the response in a Cloudflare Cache API bucket.
 * - Filters to ONLY the chains Elligentt supports.
 * - Optional ?tags= param (comma-separated) forwarded to LI.FI so callers
 *   like rwaLoadMarkets can request ?tags=rwa and get only RWA tokens.
 *   Without ?tags, all tokens are returned (backward-compatible default).
 * - Cache is keyed by (chains + tags) so rwa and non-rwa responses are
 *   stored separately — no cross-contamination for Swap/Bridge callers.
 * - Returns { ok: true, tokens: { [chainId]: TokenObject[] } }
 */

const LIFI_BASE = 'https://li.quest/v1';
// RWA-tagged responses are smaller and short-lived; generic token lists cached longer.
const CACHE_TTL_RWA = 300;  // 5 min for tagged/filtered responses
const CACHE_TTL_ALL = 600;  // 10 min for full token catalog
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
  const rawChains = url.searchParams.get('chainId') || url.searchParams.get('chains') || '';
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

  // Parse optional tags filter (e.g. tags=rwa).
  // When present, forwarded to LI.FI so only matching tokens are returned.
  // Absent means return all tokens (backward-compatible for Swap/Bridge callers).
  const rawTags = url.searchParams.get('tags') || '';
  const tagsParam = rawTags.trim();

  // Cache key includes tags so rwa and non-rwa responses never collide.
  const cacheTtl = tagsParam ? CACHE_TTL_RWA : CACHE_TTL_ALL;
  const cacheKey = 'https://lifi-tokens-cache/'
    + requestedChains.slice().sort().join(',')
    + (tagsParam ? '/tags=' + tagsParam : '');
  const cache = caches.default;

  // Try cache first.
  const cached = await cache.match(cacheKey).catch(() => null);
  if (cached) {
    const body = await cached.json().catch(() => null);
    if (body && body.ok) return json(body);
  }

  // Fetch from LI.FI — filter to ONLY the requested chains. Pulling the entire
  // EVM token catalog (~4 MB) on a cold cache was the cause of the slow
  // token-selector load. `chains` shrinks the upstream payload to just the
  // chains we support (e.g. Base ≈400 KB, Arc ≈12 KB).
  // When tags= is set (e.g. tags=rwa), LI.FI returns only tokens with that
  // tag — drastically smaller response and the correct RWA token set.
  const lifiUrl = new URL(LIFI_BASE + '/tokens');
  lifiUrl.searchParams.set('chainTypes', 'EVM');
  lifiUrl.searchParams.set('chains', requestedChains.join(','));
  if (tagsParam) {
    // Forward the tags filter directly to LI.FI.
    // LI.FI accepts comma-separated tag values: ?tags=rwa or ?tags=rwa,defi
    lifiUrl.searchParams.set('tags', tagsParam);
  }
  // Forward integrator so Partner Portal policy resolves for this request.
  const integrator = (env && env.LIFI_INTEGRATOR) || 'elligentt';
  lifiUrl.searchParams.set('integrator', integrator);

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
    // `tags` is preserved because downstream consumers (e.g. rwaLoadMarkets) rely
    // on it to identify RWA tokens without a hardcoded list — dropping it would
    // make every token catalogue empty regardless of LI.FI coverage.
    filtered[chainId] = arr.map(t => ({
      chainId: Number(t.chainId || chainId),
      address: (t.address || '').toLowerCase(),
      symbol: t.symbol || '',
      name: t.name || t.symbol || '',
      decimals: Number(t.decimals) || 18,
      logoURI: t.logoURI || null,
      priceUSD: t.priceUSD ? String(t.priceUSD) : null,
      // Preserve classification tags (e.g. ['rwa', 'defi']) for downstream filtering.
      // Never fabricate: if the upstream field is absent we store an empty array.
      tags: Array.isArray(t.tags) ? t.tags.slice() : [],
    })).filter(t => t.symbol && t.address);
  }

  const result = { ok: true, tokens: filtered };

  // Cache the successful response (TTL differs: shorter for tagged/filtered sets).
  const cacheResp = new Response(JSON.stringify(result), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=' + cacheTtl,
    },
  });
  await cache.put(cacheKey, cacheResp).catch(() => null);

  return json(result);
}
