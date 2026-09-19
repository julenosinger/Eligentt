import { RELAYER_CONFIG } from '../shared-config.mjs';

function getCorsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || 'https://elligente.pages.dev').split(',').map(s => s.trim());
  const origin = request.headers.get('Origin') || '';
  const corsOrigin = allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: getCorsHeaders(context.request, context.env) });
}

export async function onRequestGet(context) {
  const headers = getCorsHeaders(context.request, context.env);
  try {
    const KV = context.env.PAYMENT_LINKS;
    const result = {
      totalFees: 0,
      byModule: {
        paymentLinks: 0,
        invoices: 0,
        sendAssets: 0,
        multisend: 0,
        crosschain: 0
      },
      feeConfig: {
        paylink: RELAYER_CONFIG.PAYLINK_FEE_BPS || 200,
        invoice: RELAYER_CONFIG.INVOICE_FEE_BPS || 200,
        sendAssets: RELAYER_CONFIG.SEND_ASSETS_FEE_BPS || 20,
        multisend: RELAYER_CONFIG.MULTISEND_FEE_BPS || 20
      },
      treasury: RELAYER_CONFIG.TREASURY_VAULT
    };

    if (KV) {
      const list = await KV.list({ limit: 1000 });
      for (const key of list.keys) {
        try {
          const raw = await KV.get(key.name);
          if (!raw) continue;
          const link = JSON.parse(raw);
          if (link.status === 'Paid' && link.feeAmount) {
            result.byModule.paymentLinks += parseFloat(link.feeAmount) || 0;
          }
        } catch (_) {}
      }
    }

    result.totalFees = Object.values(result.byModule).reduce((a, b) => a + b, 0);

    return new Response(JSON.stringify({ ok: true, ...result }), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Server error: ' + (e.message || '') }), { status: 500, headers });
  }
}
