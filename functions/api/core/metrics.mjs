/**
 * Treasury Core API — Metrics (Phase 2)
 * ══════════════════════════════════════
 * Aggregates the EXISTING Ledger (Phase 1 ledger.mjs) plus the Core intent store
 * into platform metrics. It does NOT perform on-chain reads (no extra RPC) — all
 * figures are derived from recorded accounting data, mirroring the frontend's
 * ApplicationLedger metric set.
 */
import { readLedger, aggregateLedger, LEDGER_STAGES } from '../ledger.mjs';
import { ledgerKv, listStoredIntents } from './store.mjs';
import { loadSamples, summarize } from './latency.mjs';

function avg(list) {
  if (!list.length) return 0;
  return Math.round(list.reduce((a, b) => a + b, 0) / list.length);
}

function isSettled(i) {
  return i.status === 'Settled' || i.status === 'settled' || !!i._treasuryReimbursed;
}

/**
 * Compute the full metric set. Optionally scoped to one application.
 * @returns metrics object (see fields below)
 */
export async function computeMetrics(env, opts) {
  const application = opts && opts.application ? String(opts.application).toUpperCase() : null;

  const ledgerEntries = await readLedger(ledgerKv(env), { application, limit: 5000 });
  const intents = await listStoredIntents(env, 5000);
  const scopedIntents = application ? intents.filter(i => String(i.application || 'ELLIGENT').toUpperCase() === application) : intents;

  const breakdownRaw = aggregateLedger(ledgerEntries);

  let totalVolume = 0;
  let outstanding = 0;
  let vaultCredited = 0;
  for (const a of breakdownRaw) {
    totalVolume += a.totalVolume || 0;
    outstanding += a.treasuryOutstanding || 0;
    vaultCredited += a.vaultCredited || 0;
  }

  // Timeline-derived durations (ms) from the Core intent store.
  const settlementDurations = [];
  const bridgeDurations = [];
  const reimbursementDurations = [];
  let pendingSettlement = 0;
  let settledCount = 0;
  let failedCount = 0;

  for (const i of scopedIntents) {
    const created = Number(i.createdAt) || null;
    const fulfilledAt = Number(i.fulfilledAt || i.executedAt) || null;
    const settledAt = Number(i.settledAt) || null;

    if (isSettled(i)) settledCount++;
    else if (i.status === 'Failed' || i.status === 'failed') failedCount++;
    else pendingSettlement += Number(i.amount) || 0;

    if (settledAt && created && settledAt >= created) settlementDurations.push(settledAt - created);
    if (fulfilledAt && created && fulfilledAt >= created) bridgeDurations.push(fulfilledAt - created);
    if (settledAt && fulfilledAt && settledAt >= fulfilledAt) reimbursementDurations.push(settledAt - fulfilledAt);
  }

  const settlementEntries = ledgerEntries.filter(e => e.stage === LEDGER_STAGES.SETTLEMENT);
  const intentCount = scopedIntents.length;
  const successRate = intentCount > 0 ? round((settledCount / intentCount) * 100, 2) : 0;

  // Throughput (last 60s) from the ledger.
  const now = Date.now();
  const lastMin = (stage) => ledgerEntries.filter(e => e.stage === stage && (now - (e.timestamp || 0)) <= 60000).length;
  const bridgeThroughput = lastMin(LEDGER_STAGES.BRIDGE);
  const settlementThroughput = lastMin(LEDGER_STAGES.SETTLEMENT);

  // Latency percentiles / error rate / requests-per-min / retries.
  const perf = summarize(await loadSamples(env, 'global'));

  return {
    scope: application || 'ALL',
    totalVolume: round(totalVolume, 6),
    tvl: round(vaultCredited, 6),                    // reimbursed liquidity back in the Vault
    outstandingLiquidity: round(outstanding, 6),     // paid, not yet reimbursed
    pendingSettlement: round(pendingSettlement, 6),
    averageSettlementTime: avg(settlementDurations), // ms
    averageBridgeTime: avg(bridgeDurations),         // ms
    reimbursementTime: avg(reimbursementDurations),  // ms
    bridgeSuccessRate: successRate,                  // %
    // Phase 4 performance metrics
    p50: perf.p50,
    p95: perf.p95,
    p99: perf.p99,
    averageLatency: perf.averageLatency,             // ms
    requestsPerMin: perf.requestsPerMin,
    errorRate: perf.errorRate,                       // %
    retryCount: perf.retryCount,
    bridgeThroughput,                                // ops in last 60s
    settlementThroughput,                            // ops in last 60s
    intentCount,
    settledCount,
    failedCount,
    settlementEvents: settlementEntries.length,
    applicationBreakdown: breakdownRaw,
    generatedAt: new Date().toISOString(),
  };
}

function round(n, dp) {
  const f = Math.pow(10, dp);
  return Math.round((n + Number.EPSILON) * f) / f;
}
