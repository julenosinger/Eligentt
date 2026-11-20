/**
 * Autonoma 3.0 — Read-only tool executor (server-side).
 * ═══════════════════════════════════════════════════════════════════════════════
 * Executes READ-ONLY tools against the authenticated user's own data. Read-only
 * tools NEVER write, NEVER sign, NEVER trigger approvals or transactions.
 *
 * - Server-side tools (balance / history / wallet_info) read the user's Circle
 *   Agent Wallet via the Circle W3S API (env.CIRCLE_API_KEY), resolving the
 *   per-user wallet from AUTH_KV (`user:{email}`) — never the platform wallet,
 *   never another user. No wallet → an explicit needsProvision marker (never a
 *   fabricated empty balance that looks real).
 * - Client-side tools (contacts / queue / invoices / paymentLinks) resolve in the
 *   browser (localStorage) and return a `clientSide` marker so the caller hands
 *   them to the frontend.
 */

import { SERVER_READ_TOOLS, CLIENT_READ_TOOLS } from '../_ai/capabilities.js';

const CIRCLE_BASE = 'https://api.circle.com/v1/w3s';

/** Resolve the authenticated user's KV record (server-authoritative ownership). */
async function resolveUser(env, user) {
  if (!env || !env.AUTH_KV || !user || !user.email) return null;
  try {
    const raw = await env.AUTH_KV.get('user:' + user.email);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

async function circleGet(env, path) {
  const key = env && env.CIRCLE_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch(CIRCLE_BASE + path, {
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    });
    if (!r.ok) return null;
    return r.json().catch(() => null);
  } catch (_) { return null; }
}

export function isServerReadTool(name) { return SERVER_READ_TOOLS.indexOf(name) !== -1; }
export function isClientReadTool(name) { return CLIENT_READ_TOOLS.indexOf(name) !== -1; }

/**
 * Execute a read-only tool. Returns:
 *   { clientSide:true, tool, args } for client-resolved tools;
 *   { ok:true, data }             for server-resolved tools;
 *   { ok:false, error }           for unknown tools.
 */
export async function executeReadTool(name, args, user, env) {
  if (isClientReadTool(name)) {
    return { clientSide: true, tool: name, args: args || {} };
  }

  switch (name) {
    case 'balance': {
      const u = await resolveUser(env, user);
      const walletId = u && u.circleWalletId;
      if (!walletId) return { ok: true, data: { needsProvision: true, balances: [] } };
      const bal = await circleGet(env, '/wallets/' + walletId + '/balances');
      return { ok: true, data: { needsProvision: false, balances: (bal && bal.data && bal.data.tokenBalances) || [] } };
    }
    case 'history': {
      const u = await resolveUser(env, user);
      const walletId = u && u.circleWalletId;
      if (!walletId) return { ok: true, data: { needsProvision: true, transactions: [] } };
      const txs = await circleGet(env, '/transactions?walletIds=' + walletId + '&pageSize=20');
      return { ok: true, data: { needsProvision: false, transactions: (txs && txs.data && txs.data.transactions) || [] } };
    }
    case 'wallet_info': {
      const u = await resolveUser(env, user);
      return {
        ok: true,
        data: {
          walletId: (u && u.circleWalletId) || null,
          address: (u && u.circleWalletAddress) || null,
          needsProvision: !(u && u.circleWalletId),
        },
      };
    }
    default:
      return { ok: false, error: 'unknown_read_tool: ' + name };
  }
}
