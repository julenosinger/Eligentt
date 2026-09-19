/**
 * POST /api/core/v1/intents — Create Intent (Treasury Core API, Phase 2)
 * ══════════════════════════════════════════════════════════════════════
 * Validates the request, generates an intent, attributes Application/Client/
 * Version, records it in the Ledger + Core store with a timestamp, and returns
 * the Intent ID. This endpoint does NOT execute the bridge — it only registers
 * the intention.
 */
import { runCore, corePreflight } from '../../core/pipeline.mjs';
import { validateCreateIntent } from '../../core/validation.mjs';
import { buildIntentRecord, persistIntent } from '../../core/intent-service.mjs';
import { recordLedgerEntry, LEDGER_STAGES, LEDGER_STATUS } from '../../ledger.mjs';
import { ledgerKv } from '../../core/store.mjs';
import { STAGES } from '../../core/logger.mjs';

export const onRequestOptions = corePreflight;

export function onRequestPost(context) {
  return runCore(context, {
    method: 'POST',
    endpoint: '/api/core/v1/intents',
    rateKind: 'intent',
    permission: 'intents:create',
    validate: validateCreateIntent,
  }, async (ctx) => {
    const record = buildIntentRecord(ctx, ctx.body);
    await persistIntent(ctx.env, record);

    // Ledger (accounting-only, reuses Phase 1 ledger.mjs).
    await recordLedgerEntry(ledgerKv(ctx.env), {
      context: { application: ctx.application, client: ctx.client, version: record.version },
      intentId: record.intentId,
      stage: LEDGER_STAGES.INTENT,
      amount: record.grossAmount,
      asset: record.asset,
      status: LEDGER_STATUS.PENDING,
    });
    ctx.log.log(STAGES.LEDGER, { intentId: record.intentId, stage: LEDGER_STAGES.INTENT });

    return {
      status: 201,
      data: {
        intentId: record.intentId,
        intentBytes32: record.intentBytes32,
        application: record.application,
        client: record.client,
        version: record.version,
        status: record.status,
        asset: record.asset,
        amount: record.amount,
        grossAmount: record.grossAmount,
        feeAmount: record.feeAmount,
        netAmount: record.netAmount,
        bridge: record.bridge,
        quote: record.quote,
        correlationId: record.correlationId,
        createdAt: record.createdAt,
      },
    };
  });
}
