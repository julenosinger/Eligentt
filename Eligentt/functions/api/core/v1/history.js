/**
 * GET /api/core/v1/history — Intent History (Treasury Core API, Phase 2)
 * ══════════════════════════════════════════════════════════════════════
 * Lists Core intents with filters (application, client, status, asset, source/
 * destination chain, wallet, intent, date range), pagination and sorting.
 * Reads from the Core intent store — real data only.
 */
import { runCore, corePreflight } from '../../core/pipeline.mjs';
import { validateHistoryQuery } from '../../core/validation.mjs';
import { listStoredIntents } from '../../core/store.mjs';

export const onRequestOptions = corePreflight;

function toRow(rec) {
  const h = rec.txHashes || {};
  return {
    intentId: rec.intentId,
    application: rec.application || 'ELLIGENT',
    client: rec.client || 'default',
    bridge: rec.bridge || null,
    asset: rec.asset,
    amount: rec.amount,
    wallet: rec.wallet,
    sourceChain: rec.sourceChain,
    destChain: rec.destChain,
    status: rec.status,
    settlement: rec.settledAt ? 'settled' : (rec.fulfilledAt ? 'pending' : 'not_started'),
    reimbursement: rec.settledAt ? 'reimbursed' : 'pending',
    transactionHashes: h,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    settledAt: rec.settledAt || null,
    correlationId: rec.correlationId || null,
  };
}

function applyFilters(rows, f) {
  return rows.filter(r => {
    if (f.application && String(r.application).toUpperCase() !== f.application) return false;
    if (f.client && r.client !== f.client) return false;
    if (f.status && String(r.status).toLowerCase() !== String(f.status).toLowerCase()) return false;
    if (f.asset && String(r.asset).toLowerCase() !== f.asset) return false;
    if (f.sourceChain && String(r.sourceChain) !== String(f.sourceChain)) return false;
    if (f.destChain && String(r.destChain) !== String(f.destChain)) return false;
    if (f.wallet && String(r.wallet || '').toLowerCase() !== f.wallet) return false;
    if (f.intentId && r.intentId !== f.intentId) return false;
    if (f.dateFrom && new Date(r.createdAt).getTime() < new Date(f.dateFrom).getTime()) return false;
    if (f.dateTo && new Date(r.createdAt).getTime() > new Date(f.dateTo).getTime()) return false;
    return true;
  });
}

export function onRequestGet(context) {
  return runCore(context, {
    method: 'GET',
    endpoint: '/api/core/v1/history',
    rateKind: 'history',
    permission: 'history:read',
    validate: (params) => validateHistoryQuery(params),
  }, async (ctx) => {
    const f = ctx.body; // validateHistoryQuery returns normalized value
    const all = await listStoredIntents(ctx.env, 5000);
    let rows = all.map(toRow);
    rows = applyFilters(rows, f);

    // Sort
    const dir = f.order === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      const av = a[f.sort] ?? a.createdAt ?? 0;
      const bv = b[f.sort] ?? b.createdAt ?? 0;
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });

    const total = rows.length;
    const start = (f.page - 1) * f.limit;
    const paged = rows.slice(start, start + f.limit);

    return {
      data: {
        items: paged,
        pagination: {
          page: f.page,
          limit: f.limit,
          total,
          totalPages: Math.max(1, Math.ceil(total / f.limit)),
          hasNext: start + f.limit < total,
          hasPrev: f.page > 1,
        },
        sort: { field: f.sort, order: f.order },
        filters: {
          application: f.application, client: f.client, status: f.status, asset: f.asset,
          sourceChain: f.sourceChain, destChain: f.destChain, wallet: f.wallet,
          intentId: f.intentId, dateFrom: f.dateFrom, dateTo: f.dateTo,
        },
      },
    };
  });
}
