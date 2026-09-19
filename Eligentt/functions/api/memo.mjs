/**
 * Elligentt On-Chain Memo Grammar — Phase 1 (Core Infrastructure)
 * ═══════════════════════════════════════════════════════════════
 * Single source of truth (server-side) for the ELLIGENTE transaction memo that
 * is emitted via the Arc Memo contract during settlement/reimbursement.
 *
 * MULTI-APPLICATION EXPANSION (backward compatible):
 *   Legacy: ELLIGENTE|REPAY|INT-XXXX|USDC|100
 *   New:    ELLIGENTE|REPAY|INT-XXXX|USDC|100|ELLIGENT|default
 *
 * The first FIVE positional fields are byte-for-byte identical to the legacy
 * format so every existing indexer/parser (browser + chain scanners) keeps
 * working; Application + Client are simply appended and ignored by legacy
 * readers. The format stays compact (pipe-delimited, positional).
 */

export const MEMO_PREFIX = 'ELLIGENTE';
export const VALID_ACTIONS = ['REPAY', 'BRIDGE', 'INVOICE', 'BATCH'];

/**
 * Build a memo string. Application + Client are appended when provided; when both
 * are omitted the exact legacy 5-field string is returned (zero behavioral drift
 * for any caller that does not supply them).
 */
export function generateMemo(action, intentId, asset, amount, application, client) {
  const base = `${MEMO_PREFIX}|${action}|${intentId}|${(asset ?? 'USDC').toUpperCase()}|${amount}`;
  if (application === undefined && client === undefined) return base;
  const app = String(application ?? 'ELLIGENT').toUpperCase();
  const cli = String(client ?? 'default');
  return `${base}|${app}|${cli}`;
}

/**
 * Parse a memo string. Backward compatible: legacy memos (no app/client) resolve
 * to the ELLIGENT / default attribution.
 */
export function parseMemo(memoStr) {
  if (!memoStr || typeof memoStr !== 'string') return null;
  if (!memoStr.startsWith(MEMO_PREFIX + '|')) return null;
  const parts = memoStr.split('|');
  if (parts.length < 4) return null;
  return {
    prefix: parts[0],
    action: parts[1],
    intentId: parts[2],
    asset: parts[3] ?? null,
    amount: parts[4] ? parseFloat(parts[4]) : null,
    application: parts[5] ? parts[5].toUpperCase() : 'ELLIGENT',
    client: parts[6] ?? 'default',
  };
}

/**
 * Validate a memo string. Requires the legacy 5-field core to be well-formed; the
 * appended app/client fields are optional.
 */
export function validateMemo(memoStr) {
  if (!memoStr || typeof memoStr !== 'string') return false;
  if (!memoStr.startsWith(MEMO_PREFIX + '|')) return false;
  const parts = memoStr.split('|');
  if (parts.length < 5) return false;
  if (!VALID_ACTIONS.includes(parts[1])) return false;
  if (!parts[2] || parts[2].trim().length === 0) return false;
  if (!parts[3] || parts[3].trim().length === 0) return false;
  const amt = parseFloat(parts[4]);
  if (isNaN(amt) || amt < 0) return false;
  return true;
}
