import { RELAYER_CONFIG } from './shared-config.mjs';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const { label, amount, type, desc, recipient, token, chain, expiry } = body;

    if (!recipient || !/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
      return new Response(JSON.stringify({ error: 'Invalid recipient address' }), { status: 400, headers: CORS_HEADERS });
    }
    if (type !== 'open' && (!amount || amount <= 0)) {
      return new Response(JSON.stringify({ error: 'Invalid amount' }), { status: 400, headers: CORS_HEADERS });
    }

    const feeBps = RELAYER_CONFIG.PAYLINK_FEE_BPS || 200;
    const feeAmount = type === 'open' ? 0 : parseFloat((amount * feeBps / 10000).toFixed(6));
    const totalAmount = type === 'open' ? 0 : parseFloat((amount + feeAmount).toFixed(6));

    const id = 'pl-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    let expiresAt = null;
    if (expiry && expiry !== 'never') {
      const map = { '24h': 86400000, '7d': 604800000, '30d': 2592000000 };
      if (map[expiry]) expiresAt = new Date(Date.now() + map[expiry]).toISOString();
    }

    const link = {
      id,
      label: label || 'Payment',
      amount: parseFloat(amount) || 0,
      feeAmount,
      totalAmount,
      feeBps,
      feeReceiver: RELAYER_CONFIG.TREASURY_VAULT,
      type: type || 'fixed',
      desc: desc || '',
      recipient,
      token: token || 'USDC',
      chain: chain || 'Arc Testnet',
      chainId: RELAYER_CONFIG.ARC_CHAIN_ID,
      expiry: expiry || 'never',
      expiresAt,
      status: 'Active',
      payments: 0,
      scans: 0,
      created: new Date().toISOString(),
      paidTx: null,
      paidBy: null,
      paidAt: null,
    };

    const KV = context.env.PAYMENT_LINKS;
    if (KV) {
      const ttl = expiresAt ? Math.max(Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000) + 86400, 86400) : undefined;
      await KV.put(id, JSON.stringify(link), ttl ? { expirationTtl: ttl } : undefined);
    }

    return new Response(JSON.stringify({ ok: true, link }), { status: 201, headers: CORS_HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Server error: ' + (e.message || '') }), { status: 500, headers: CORS_HEADERS });
  }
}
