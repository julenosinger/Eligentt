/**
 * Autonoma 1.2 — Server-side tool-call schema validation.
 * ═══════════════════════════════════════════════════════════════════════════════
 * Model-generated tool calls are UNTRUSTED input. Before any future AI-driven
 * execution is enabled, operation names, token addresses, chains, amounts and
 * recipients MUST be validated here (server-side), never trusted from the model.
 *
 * This module is a foundation primitive — it does NOT execute anything.
 */

const WRITE_TOOLS = new Set(['send', 'swap', 'bridge', 'create_invoice', 'create_schedule', 'create_payment_link', 'batch_send']);
const READ_TOOLS = new Set(['balance', 'history', 'wallet_info', 'routes', 'schedules']);
const ALLOWED_TOOLS = new Set([...WRITE_TOOLS, ...READ_TOOLS]);

const KNOWN_CHAIN_IDS = new Set([5042, 1, 8453, 42161, 10, 137]);
const KNOWN_TOKENS = new Set(['USDC', 'EURC', 'CIRBTC']);

function isAddress(a) { return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a); }

function isPositiveAmount(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0;
}

/**
 * Validate a normalized tool call { name, arguments }.
 * Returns { ok:true, type:'read'|'write' } or { ok:false, reason }.
 */
export function validateToolCall(name, args) {
  if (typeof name !== 'string' || !ALLOWED_TOOLS.has(name)) {
    return { ok: false, reason: 'unknown_tool:' + name };
  }
  const a = (args && typeof args === 'object') ? args : {};

  switch (name) {
    case 'send':
      if (!isAddress(a.to)) return { ok: false, reason: 'send:invalid_recipient' };
      if (!isPositiveAmount(a.amount)) return { ok: false, reason: 'send:invalid_amount' };
      if (a.token && !KNOWN_TOKENS.has(String(a.token).toUpperCase())) return { ok: false, reason: 'send:invalid_token' };
      break;
    case 'swap':
      if (!isPositiveAmount(a.amount)) return { ok: false, reason: 'swap:invalid_amount' };
      if (!KNOWN_TOKENS.has(String(a.fromToken || '').toUpperCase()) || !KNOWN_TOKENS.has(String(a.toToken || '').toUpperCase())) {
        return { ok: false, reason: 'swap:invalid_token' };
      }
      break;
    case 'bridge':
      if (!isPositiveAmount(a.amount)) return { ok: false, reason: 'bridge:invalid_amount' };
      if (!_validChain(a.fromChain) || !_validChain(a.toChain)) return { ok: false, reason: 'bridge:invalid_chain' };
      break;
    case 'batch_send':
      if (!Array.isArray(a.recipients) || !a.recipients.length) return { ok: false, reason: 'batch_send:no_recipients' };
      for (const r of a.recipients) {
        if (!r || !isAddress(r.address) || !isPositiveAmount(r.amount)) return { ok: false, reason: 'batch_send:invalid_recipient' };
      }
      break;
    case 'create_invoice':
    case 'create_schedule':
    case 'create_payment_link':
      if (!isPositiveAmount(a.amount) && name !== 'create_payment_link') return { ok: false, reason: name + ':invalid_amount' };
      break;
    default:
      break; // read tools take no critical params
  }

  return { ok: true, type: WRITE_TOOLS.has(name) ? 'write' : 'read' };
}

function _validChain(c) {
  if (c == null) return false;
  if (Number.isFinite(Number(c))) return KNOWN_CHAIN_IDS.has(Number(c));
  const map = { arc: 5042, ethereum: 1, eth: 1, base: 8453, arbitrum: 42161, arb: 42161, optimism: 10, op: 10, polygon: 137, matic: 137 };
  return map[String(c).toLowerCase()] != null;
}

export { ALLOWED_TOOLS, WRITE_TOOLS, READ_TOOLS, KNOWN_CHAIN_IDS, KNOWN_TOKENS };
