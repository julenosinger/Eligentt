/**
 * CF Pages Function — GET /api/gateway/balances?address=0x...
 *
 * Server-side proxy to the Circle Gateway /v1/balances API.
 * Fetches USDC, EURC, and cirBTC balances for a wallet address
 * across all Gateway-supported domains, without exposing any
 * secret credentials (the Gateway API is permissionless — no auth header).
 *
 * Domain IDs (matches CCTP domain identifiers):
 *   0=Ethereum  1=Avalanche  2=OP  3=Arbitrum  6=Base
 *   7=Polygon   10=Unichain  13=Sonic  14=World Chain  16=Sei
 *   19=HyperEVM  26=Arc
 *
 * USDC  — all Gateway domains
 * EURC  — Arc(26), Ethereum(0), Avalanche(1), Base(6), World Chain(14)
 * cirBTC — Arc(26), Ethereum(0)
 */

const GATEWAY_API = 'https://gateway-api.circle.com';

// Domains where each asset is supported on Gateway mainnet.
const ASSET_DOMAINS = {
  USDC:   [0, 1, 2, 3, 6, 7, 10, 13, 14, 16, 19, 26],
  EURC:   [0, 1, 6, 14, 26],
  cirBTC: [0, 26],
};

// Domain ID → human-readable name (for the UI chain chips).
const DOMAIN_NAMES = {
  0:  'Ethereum',
  1:  'Avalanche',
  2:  'Optimism',
  3:  'Arbitrum',
  6:  'Base',
  7:  'Polygon',
  10: 'Unichain',
  13: 'Sonic',
  14: 'World Chain',
  16: 'Sei',
  19: 'HyperEVM',
  26: 'Arc',
};

/**
 * Fetch balances for one token across all its supported domains.
 * Returns array: [{ domain, domainName, balance }]  — zero-balance entries included.
 */
async function fetchToken(token, depositor, signal) {
  const domains = ASSET_DOMAINS[token];
  const body = {
    token,
    sources: domains.map(d => ({ domain: d, depositor })),
  };

  const res = await fetch(`${GATEWAY_API}/v1/balances`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gateway API ${res.status}: ${text}`);
  }

  const data = await res.json();
  // data.balances is an array of { domain, depositor, balance }
  const byDomain = {};
  if (Array.isArray(data.balances)) {
    for (const entry of data.balances) {
      byDomain[entry.domain] = entry.balance ?? '0';
    }
  }

  return domains.map(d => ({
    domain:     d,
    domainName: DOMAIN_NAMES[d] ?? String(d),
    balance:    byDomain[d] ?? '0',
  }));
}

export async function onRequestGet(ctx) {
  const url    = new URL(ctx.request.url);
  const address = url.searchParams.get('address') || '';

  // Basic address validation — must be 0x + 40 hex chars.
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return new Response(
      JSON.stringify({ error: 'Invalid address' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const controller = new AbortController();
  // 13 s — CF must abort before the 14 s frontend timeout so the
  // client receives a clean 502 instead of a hanging connection.
  const timeout = setTimeout(() => controller.abort(), 13000);

  try {
    // Fetch all three assets in parallel.
    const [usdc, eurc, cirBTC] = await Promise.allSettled([
      fetchToken('USDC',   address, controller.signal),
      fetchToken('EURC',   address, controller.signal),
      fetchToken('cirBTC', address, controller.signal),
    ]);

    const result = {
      address,
      USDC:   usdc.status   === 'fulfilled' ? usdc.value   : null,
      EURC:   eurc.status   === 'fulfilled' ? eurc.value   : null,
      cirBTC: cirBTC.status === 'fulfilled' ? cirBTC.value : null,
      errors: {},
    };

    if (usdc.status   !== 'fulfilled') result.errors.USDC   = usdc.reason?.message   ?? 'fetch failed';
    if (eurc.status   !== 'fulfilled') result.errors.EURC   = eurc.reason?.message   ?? 'fetch failed';
    if (cirBTC.status !== 'fulfilled') result.errors.cirBTC = cirBTC.reason?.message ?? 'fetch failed';

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        'Content-Type':  'application/json',
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message ?? 'Unknown error' }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  } finally {
    clearTimeout(timeout);
  }
}
