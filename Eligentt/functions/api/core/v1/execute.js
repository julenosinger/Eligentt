/**
 * POST /api/core/v1/execute — Execute Intent (Treasury Core API, Phase 2)
 * ═══════════════════════════════════════════════════════════════════════
 * Validates the intent + application, then executes the Turbo Bridge by
 * DELEGATING to the EXISTING operator relayer (/api/relayer) — no financial
 * logic is duplicated. Records the Ledger and returns the transaction hash.
 *
 * `dryRun: true` validates and previews without touching the chain.
 */
import { runCore, corePreflight } from '../../core/pipeline.mjs';
import { CoreError } from '../../core/response.mjs';
import { validateExecute } from '../../core/validation.mjs';
import { loadIntent, persistIntent, addTimeline, intentBytes32, INTENT_STATUS } from '../../core/intent-service.mjs';
import { recordLedgerEntry, LEDGER_STAGES, LEDGER_STATUS } from '../../ledger.mjs';
import { ledgerKv } from '../../core/store.mjs';
import { STAGES } from '../../core/logger.mjs';
import { onRequest as relayerOnRequest } from '../../relayer.js';
import { scheduleSettlement } from '../../core/settlement.mjs';

const BURN_TX_RE = /^0x[0-9a-fA-F]{64}$/;

export const onRequestOptions = corePreflight;

// Resolve the execution parameters from the stored intent (preferred) or the body.
function resolveParams(rec, body) {
  const asset = (rec && rec.asset) || body.asset;
  const grossAmount = (rec && rec.grossAmount != null) ? rec.grossAmount : body.grossAmount;
  const feeAmount = (rec && rec.feeAmount != null) ? rec.feeAmount : (body.feeAmount != null ? body.feeAmount : 0);
  const userAddress = (rec && rec.wallet) || body.userAddress;
  const bytes32 = (rec && rec.intentBytes32) || body.intentBytes32 || (body.intentId ? intentBytes32(body.intentId) : null);
  return { asset, grossAmount, feeAmount, userAddress, bytes32 };
}

export function onRequestPost(context) {
  return runCore(context, {
    method: 'POST',
    endpoint: '/api/core/v1/execute',
    rateKind: 'execute',
    permission: 'execute:write',
    validate: validateExecute,
  }, async (ctx) => {
    const body = ctx.body;
    const rec = await loadIntent(ctx.env, body.intentId);
    const p = resolveParams(rec, body);

    if (!p.asset || p.grossAmount == null || !p.userAddress || !p.bytes32) {
      throw new CoreError('EXECUTE_INCOMPLETE',
        'Cannot execute: missing asset/amount/wallet/intentBytes32 (register the intent first or provide them)', 422);
    }

    // ── Dry run: validate + preview, no chain interaction ──
    if (body.dryRun) {
      return {
        data: {
          intentId: body.intentId,
          dryRun: true,
          wouldExecute: {
            bridge: (rec && rec.bridge) || 'Turbo',
            asset: p.asset,
            grossAmount: p.grossAmount,
            feeAmount: p.feeAmount,
            userAddress: p.userAddress,
            intentBytes32: p.bytes32,
          },
          application: ctx.application,
          client: ctx.client,
        },
      };
    }

    // ── Ledger: bridge attempt (accounting-only) ──
    await recordLedgerEntry(ledgerKv(ctx.env), {
      context: { application: ctx.application, client: ctx.client },
      intentId: body.intentId, stage: LEDGER_STAGES.BRIDGE,
      amount: p.grossAmount, asset: p.asset, status: LEDGER_STATUS.PENDING, bridge: (rec && rec.bridge) || 'Turbo',
    });

    if (rec) { addTimeline(rec, 'execute_requested'); rec.status = INTENT_STATUS.EXECUTING; await persistIntent(ctx.env, rec); }

    // ── Delegate to the EXISTING operator relayer (Treasury Engine) ──
    const relayerReq = new Request('https://internal/api/relayer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intentBytes32: p.bytes32,
        asset: p.asset,
        grossAmount: Number(p.grossAmount),
        feeAmount: Number(p.feeAmount || 0),
        userAddress: p.userAddress,
        applicationId: ctx.application,
        clientId: ctx.client,
        version: (ctx.appContext && ctx.appContext.version) || '1',
      }),
    });

    let relayerData;
    try {
      const relayerRes = await ctx.breaker.guard('relayer', () => relayerOnRequest({ request: relayerReq, env: ctx.env }));
      relayerData = await relayerRes.json();
    } catch (e) {
      if (e && e.circuitOpen) throw e; // pipeline returns standardized 503
      throw new CoreError('ENGINE_ERROR', 'Treasury engine error: ' + ((e && e.message) || 'unknown'), 502);
    }

    ctx.log.log(STAGES.TREASURY, { intentId: body.intentId, delegated: 'relayer', success: !!relayerData.success, skipped: !!relayerData.skipped });

    if (relayerData.success) {
      const txHash = relayerData.txHash || null;

      // Capture the source-chain CCTP burn tx + domain so the SHARED settlement
      // pipeline can poll Circle for the attestation and reimburse the Vault.
      // These are OPTIONAL: when the caller drives its own burn (like the Elligent
      // frontend), it passes burnTxHash/sourceChain so the server can finish the
      // exact same pipeline instead of stopping at Fulfill.
      const burnTxHash = (body.burnTxHash && BURN_TX_RE.test(body.burnTxHash)) ? body.burnTxHash : null;

      if (rec) {
        rec.txHashes = { ...(rec.txHashes || {}), fulfill: txHash };
        if (burnTxHash) rec.txHashes.burn = burnTxHash;
        if (body.sourceChain != null && rec.sourceChain == null) rec.sourceChain = String(body.sourceChain);
        if (body.sourceDomain != null && rec.sourceDomain == null) rec.sourceDomain = Number(body.sourceDomain);
        rec.status = INTENT_STATUS.FULFILLED;
        rec.fulfilledAt = Date.now();
        addTimeline(rec, 'treasury_fulfilled', { txHash });
        await persistIntent(ctx.env, rec);
      }
      await recordLedgerEntry(ledgerKv(ctx.env), {
        context: { application: ctx.application, client: ctx.client },
        intentId: body.intentId, stage: LEDGER_STAGES.TREASURY_PAYMENT,
        amount: p.grossAmount, asset: p.asset, status: LEDGER_STATUS.SUCCESS, txHash,
      });

      // ── Continue the SHARED Turbo Bridge pipeline (attestation → settlement →
      // reimbursement) in the background. Identical for EVERY application; the
      // only per-app difference is the attribution (application/client). No
      // separate pipeline for ExecDaat. ──
      let settlement = { scheduled: false, reason: 'missing_burn_tx' };
      const settleTxHash = burnTxHash || (rec && rec.txHashes && rec.txHashes.burn) || null;
      if (settleTxHash) {
        scheduleSettlement(ctx.execution || { env: ctx.env, waitUntil: ctx.waitUntil }, body.intentId, {
          log: (stage, fields) => ctx.log.log(STAGES.SETTLEMENT, fields),
        });
        settlement = { scheduled: true };
        ctx.log.log(STAGES.SETTLEMENT, { intentId: body.intentId, stage: 'scheduled' });
      } else {
        ctx.log.log(STAGES.SETTLEMENT, { intentId: body.intentId, stage: 'not_scheduled', reason: 'missing_burn_tx' });
      }

      return {
        data: {
          intentId: body.intentId,
          status: INTENT_STATUS.FULFILLED,
          transactionHash: txHash,
          blockNumber: relayerData.blockNumber ?? null,
          settlement,
          application: ctx.application,
          client: ctx.client,
        },
      };
    }

    if (relayerData.skipped) {
      return { data: { intentId: body.intentId, status: 'skipped', reason: relayerData.reason || 'already_fulfilled' } };
    }

    // Engine reported a failure — surface it as a standardized error.
    throw new CoreError('EXECUTION_FAILED', relayerData.error || 'Relayer execution failed', 502);
  });
}
