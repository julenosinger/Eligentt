/**
 * POST /api/tax/report
 * Generates a classified tax report for a wallet / contract.
 * Fetches transactions, prices, classifies events, runs country rules.
 *
 * Body: { address, targetType, networks, country, quoteId, txHash, hasDefi }
 * Returns: { ok, country, address, period, metrics, ops }
 *
 * Env vars:
 *   ALCHEMY_API_KEY, ARC_RPC_URL, SOLANA_RPC_URL (same as scan)
 *   COINGECKO_API_KEY  — optional, for historical prices
 *   TAX_KV             — KV for caching (optional)
 */

import { jsonResp, errResp, classifyOp, calcCountry, isSafeUrl } from './_tax-utils.mjs';

const COUNTRY_META = {
  BR: { name: 'Brazil',        currency: 'BRL', method: 'Average cost', period: 'Monthly'  },
  PT: { name: 'Portugal',      currency: 'EUR', method: 'FIFO',         period: 'Annual'   },
  US: { name: 'United States', currency: 'USD', method: 'FIFO',         period: 'Annual'   },
  DE: { name: 'Germany',       currency: 'EUR', method: 'FIFO',         period: 'Annual'   },
  GB: { name: 'United Kingdom',currency: 'GBP', method: 'Section 104',  period: 'Annual'   },
};

/**
 * Fetch transaction list from Alchemy for an EVM address.
 * Returns a lightweight array of { hash, ts, isIncoming, rawType, assetId, qty, price, fees }.
 * For a real implementation, use getAssetTransfers with pagination + backoff.
 */
async function fetchEvmTxs(address, network, env) {
  const ak = env.ALCHEMY_API_KEY;
  if (!ak) return []; // no key → no data

  const rpcUrlMap = { // arc-studio-allow-onchain-literal
    ethereum: `https://eth-mainnet.g.alchemy.com/v2/${ak}`,
    base:     `https://base-mainnet.g.alchemy.com/v2/${ak}`,
    arbitrum: `https://arb-mainnet.g.alchemy.com/v2/${ak}`,
    optimism: `https://opt-mainnet.g.alchemy.com/v2/${ak}`,
    polygon:  `https://polygon-mainnet.g.alchemy.com/v2/${ak}`,
    arc:      env.ARC_RPC_URL || null,
  };
  const url = rpcUrlMap[network];
  if (!url || !isSafeUrl(url)) return [];

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'alchemy_getAssetTransfers',
        params: [{ fromAddress: address, category: ['erc20','external','internal'], maxCount: '0x3e8', withMetadata: true }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await resp.json();
    return (data.result?.transfers || []).map(t => ({
      hash:       t.hash,
      ts:         new Date(t.metadata?.blockTimestamp || 0).getTime(),
      isIncoming: t.to?.toLowerCase() === address.toLowerCase(),
      rawType:    t.category,
      assetId:    t.asset || 'ETH',
      qty:        parseFloat(t.value || 0),
      price:      0, // will be enriched with historical price
      fees:       0,
    }));
  } catch (_) {
    return [];
  }
}

/** Fetch historical USD price for an asset at a given date (CoinGecko). */
async function fetchPrice(assetId, ts, env) {
  const key = env.COINGECKO_API_KEY;
  if (!key) return 1; // no key → assume $1 (stablecoin default)
  const date = new Date(ts).toLocaleDateString('en-GB').replace(/\//g, '-');
  const idMap = { USDC: 'usd-coin', ETH: 'ethereum', BTC: 'bitcoin', MATIC: 'matic-network' };
  const cgId = idMap[assetId] || assetId.toLowerCase();
  try {
    const resp = await fetch(
      `https://api.coingecko.com/api/v3/coins/${cgId}/history?date=${date}&localization=false`, // arc-studio-allow-onchain-literal
      { headers: { 'x-cg-pro-api-key': key }, signal: AbortSignal.timeout(5000) }
    );
    const data = await resp.json();
    return data.market_data?.current_price?.usd || 1;
  } catch (_) {
    return 1;
  }
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (_) { return errResp('Invalid JSON'); }

  const { address, targetType, networks = [], country = 'US', quoteId, txHash, hasDefi } = body;
  if (!address)  return errResp('address required');
  if (!quoteId)  return errResp('quoteId required');

  const isEvm = /^0x[0-9a-fA-F]{40}$/.test(address);

  // Fetch all transactions across selected networks (parallel, best-effort)
  const txArrays = await Promise.allSettled(
    networks.filter(n => n !== 'solana' || !isEvm).map(net => fetchEvmTxs(address, net, env))
  );
  let allTxs = txArrays.flatMap(r => r.status === 'fulfilled' ? r.value : []);

  // Enrich with prices (serial to avoid rate-limit; cache by assetId+date)
  const priceCache = {};
  for (const tx of allTxs) {
    const key = tx.assetId + ':' + tx.ts;
    if (priceCache[key] === undefined) {
      priceCache[key] = await fetchPrice(tx.assetId, tx.ts, env);
    }
    tx.price = priceCache[key];
    tx.fees  = 0; // gas fees would require separate lookup
  }

  // Classify
  const classified = allTxs.map(classifyOp);
  const ops = classified.filter(op => op.type !== 'ignored');
  const ignored = classified.filter(op => op.type === 'ignored').length;

  // Run country rules
  const metrics = calcCountry(country, ops);
  metrics.classifiedOps       = ops.length;
  metrics.ignoredSelfTransfer = ignored;

  // If no real data, use demo scaffold
  const hasData = ops.length > 0;

  const countryMeta = COUNTRY_META[country] || COUNTRY_META['US'];

  const period = (() => {
    if (allTxs.length === 0) return '2023–2024 (demo)';
    const sorted = allTxs.map(t => t.ts).sort((a, b) => a - b);
    const y0 = new Date(sorted[0]).getFullYear();
    const y1 = new Date(sorted[sorted.length - 1]).getFullYear();
    return y0 === y1 ? String(y0) : y0 + '–' + y1;
  })();

  return jsonResp({
    ok:      true,
    address, country: countryMeta,
    period,
    metrics,
    ops:     hasData ? ops.slice(0, 500).map(op => ({
      date:  op.ts ? new Date(op.ts).toISOString().slice(0, 10) : '—',
      chain: op.network || '—',
      type:  op.type,
      in:    op.isIncoming ? (op.qty.toFixed(4) + ' ' + op.assetId) : '—',
      out:   !op.isIncoming ? (op.qty.toFixed(4) + ' ' + op.assetId) : '—',
      usd:   (op.qty * op.price).toFixed(2),
      gas:   (op.fees || 0).toFixed(4),
      pl:    op.type === 'sell' ? parseFloat(((op.price - (op._costBasis || op.price)) * op.qty).toFixed(2)) : 0,
      hash:  op.hash || null,
    })) : null,
    demo:    !hasData,
  });
}
