/**
 * Treasury Ledger — Phase 1 (Core Infrastructure)
 * ═══════════════════════════════════════════════
 * An internal, ACCOUNTING-ONLY ledger for the shared Liquidity Core. It records
 * every stage of a Treasury operation attributed to an Application + Client so
 * volume can be segregated per consumer application (ELLIGENT, EXECDAAT, ...).
 *
 * IMPORTANT:
 *   - This ledger NEVER moves funds and NEVER touches Smart Contracts, the Vault,
 *     the Treasury, CCTP, Settlement or Reimbursement flows. It is purely a
 *     bookkeeping side-channel.
 *   - It is KV-OPTIONAL and best-effort: if no KV binding is provided (or a write
 *     fails) the caller's flow is UNAFFECTED. Recording must never throw into the
 *     hot path of the bridge/settlement.
 *   - It NEVER stores private keys, signatures, attestations or auth material.
 *
 * The lifecycle mirrors the existing (unchanged) money flow:
 *   Vault → Treasury → Bridge → Circle Settlement → Treasury → Vault Reimbursed
 */

export const LEDGER_STAGES = Object.freeze({
  INTENT:          'INTENT',           // intent created / attributed
  VAULT_DEBIT:     'VAULT_DEBIT',      // liquidity leaves the Vault
  TREASURY_PAYMENT:'TREASURY_PAYMENT', // Treasury pays the user (fulfillAndPayWithFee)
  BRIDGE:          'BRIDGE',           // CCTP burn / bridge initiated
  SETTLEMENT:      'SETTLEMENT',       // Circle attestation settled
  VAULT_CREDIT:    'VAULT_CREDIT',     // reimbursement mints back to the Vault
});

export const LEDGER_STATUS = Object.freeze({
  PENDING:  'Pending',
  SUCCESS:  'Success',
  FAILED:   'Failed',
  SKIPPED:  'Skipped',
});

const KEY_PREFIX = 'ledger:';
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days retention

function safeRand() {
  try {
    return Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, '0')).join('');
  } catch (_) {
    return Math.random().toString(16).slice(2, 14);
  }
}

/**
 * Build a normalized ledger entry (pure — no I/O). Unknown fields are dropped so
 * secrets can never leak into the ledger.
 */
export function buildLedgerEntry(fields) {
  const f = fields || {};
  const ctx = f.context || {};
  const ts = Number.isFinite(f.timestamp) ? f.timestamp : Date.now();
  return {
    id:          f.id || (ts + '-' + safeRand()),
    application: f.application || ctx.application || 'ELLIGENT',
    client:      f.client || ctx.client || 'default',
    version:     f.version || ctx.version || '1',
    environment: f.environment || ctx.environment || 'production',
    intentId:    f.intentId || null,
    stage:       f.stage || LEDGER_STAGES.INTENT,
    amount:      (typeof f.amount === 'number' && isFinite(f.amount)) ? f.amount : null,
    asset:       f.asset ? String(f.asset).toLowerCase() : null,
    status:      f.status || LEDGER_STATUS.PENDING,
    txHash:      f.txHash || null,
    memo:        f.memo || null,
    bridge:      f.bridge || null,
    timestamp:   ts,
  };
}

function _kvKey(entry) {
  // Sortable-ish key namespaced by application for cheap per-app listing.
  return KEY_PREFIX + entry.application + ':' + String(entry.timestamp).padStart(16, '0') + ':' + entry.id;
}

/**
 * Persist a ledger entry. Best-effort and KV-optional.
 * @returns {Promise<{recorded:boolean, entry:object, reason?:string}>}
 */
export async function recordLedgerEntry(kv, fields) {
  const entry = buildLedgerEntry(fields);
  if (!kv || typeof kv.put !== 'function') {
    return { recorded: false, entry, reason: 'no_kv' };
  }
  try {
    await kv.put(_kvKey(entry), JSON.stringify(entry), { expirationTtl: DEFAULT_TTL_SECONDS });
    return { recorded: true, entry };
  } catch (e) {
    return { recorded: false, entry, reason: (e && e.message) || 'kv_error' };
  }
}

/**
 * Record several stages at once (best-effort). Never throws.
 * @returns {Promise<object[]>} the normalized entries (recorded or not)
 */
export async function recordLedgerEntries(kv, list) {
  const out = [];
  for (const fields of (Array.isArray(list) ? list : [])) {
    try {
      const r = await recordLedgerEntry(kv, fields);
      out.push(r.entry);
    } catch (_) {
      out.push(buildLedgerEntry(fields));
    }
  }
  return out;
}

/**
 * Read ledger entries, optionally filtered by application. KV-optional.
 * @returns {Promise<object[]>}
 */
export async function readLedger(kv, opts) {
  const o = opts || {};
  if (!kv || typeof kv.list !== 'function' || typeof kv.get !== 'function') return [];
  const prefix = o.application ? (KEY_PREFIX + o.application + ':') : KEY_PREFIX;
  const limit = Number.isFinite(o.limit) ? o.limit : 1000;
  const entries = [];
  try {
    const listed = await kv.list({ prefix, limit });
    for (const k of (listed.keys || [])) {
      try {
        const raw = await kv.get(k.name);
        if (raw) entries.push(JSON.parse(raw));
      } catch (_) {}
    }
  } catch (_) {}
  return entries;
}

/**
 * Aggregate ledger entries into per-application accounting metrics (pure).
 */
export function aggregateLedger(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const byApp = {};
  for (const e of list) {
    const app = e.application || 'ELLIGENT';
    if (!byApp[app]) {
      byApp[app] = {
        application: app,
        clients: new Set(),
        intents: new Set(),
        totalVolume: 0,
        treasuryPaid: 0,
        vaultCredited: 0,
        entryCount: 0,
        successCount: 0,
        failedCount: 0,
      };
    }
    const a = byApp[app];
    a.entryCount++;
    if (e.client) a.clients.add(e.client);
    if (e.intentId) a.intents.add(e.intentId);
    if (e.status === LEDGER_STATUS.SUCCESS) a.successCount++;
    if (e.status === LEDGER_STATUS.FAILED) a.failedCount++;
    const amt = typeof e.amount === 'number' ? e.amount : 0;
    if (e.stage === LEDGER_STAGES.TREASURY_PAYMENT) a.treasuryPaid += amt;
    if (e.stage === LEDGER_STAGES.VAULT_CREDIT) a.vaultCredited += amt;
    if (e.stage === LEDGER_STAGES.VAULT_DEBIT || e.stage === LEDGER_STAGES.TREASURY_PAYMENT) a.totalVolume += amt;
  }
  return Object.values(byApp).map(a => ({
    application: a.application,
    clientCount: a.clients.size,
    intentCount: a.intents.size,
    entryCount: a.entryCount,
    totalVolume: a.totalVolume,
    treasuryPaid: a.treasuryPaid,
    vaultCredited: a.vaultCredited,
    treasuryOutstanding: a.treasuryPaid - a.vaultCredited,
    successCount: a.successCount,
    failedCount: a.failedCount,
  }));
}
