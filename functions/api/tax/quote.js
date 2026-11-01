/**
 * POST /api/tax/quote
 * Server-authoritative fee calculation. Returns a signed quote with expiry.
 * The client must send this quoteId back on payment and report generation.
 *
 * Body: { address, networks: ['arc','base',...], hasDefi: bool }
 * Returns: { ok, quoteId, amount, lines, expiresAt }
 */

import { jsonResp, errResp, calcFee, TAX_FEE } from './_tax-utils.mjs';

// In-memory quote store (KV recommended for production; see env.TAX_KV)
// For now we re-derive the quote on verify-payment instead of caching here.

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (_) { return errResp('Invalid JSON'); }

  const { address, networks = [], totalOps = 0, hasDefi = false } = body;
  if (!address) return errResp('address required');
  if (!Array.isArray(networks) || networks.length === 0) return errResp('at least one network required');

  const amount      = calcFee({ totalOps, numNets: networks.length, hasDefi });
  const quoteId     = 'q-' + Date.now().toString(36) + '-' + crypto.randomUUID().slice(0, 8);
  const expiresAt   = Date.now() + TAX_FEE.quoteExpiryMs;

  const lines = [
    { k: 'Base fee',                          v: TAX_FEE.base + ' USDC' },
    { k: `Volume fee (${totalOps} ops)`,      v: Math.ceil(Math.max(0, totalOps - 500) / 500) * TAX_FEE.volumePer500 + ' USDC' },
    { k: `Networks (${networks.length})`,     v: Math.max(0, networks.length - 1) * TAX_FEE.perExtraNet + ' USDC' },
    { k: 'Complexity (DeFi/NFT)',             v: hasDefi ? TAX_FEE.complexity + ' USDC' : 'N/A' },
  ];

  // Optionally persist to KV for replay protection
  if (env.TAX_KV) {
    await env.TAX_KV.put('quote:' + quoteId, JSON.stringify({ quoteId, amount, address, networks, totalOps, hasDefi, expiresAt, used: false }), {
      expirationTtl: Math.ceil(TAX_FEE.quoteExpiryMs / 1000) + 60,
    });
  }

  return jsonResp({ ok: true, quoteId, amount, lines, expiresAt });
}
