/**
 * GET /api/core/v1/health — Component Health (Treasury Core API, Phase 2 + 4)
 * ═══════════════════════════════════════════════════════════════════════════
 * Real-time status of every component the Core depends on: Circle, RPC, Vault,
 * Treasury, Ledger, KV, Workers, Storage + Bridge Engine — plus Average Latency,
 * Error Rate, Circuit Breaker status and Application Count. Uses a SINGLE
 * lightweight RPC call (breaker-recorded) and is short-TTL cached.
 */
import { runCore, corePreflight } from '../../core/pipeline.mjs';
import { RELAYER_CONFIG } from '../../shared-config.mjs';
import { coreKv } from '../../core/store.mjs';
import { withCache } from '../../core/cache.mjs';
import { loadSamples, summarize } from '../../core/latency.mjs';
import { listApplications } from '../../core/registry.mjs';
import * as breaker from '../../core/circuit-breaker.mjs';
import { emitAlert, ALERT_TYPES } from '../../core/alerts.mjs';

export const onRequestOptions = corePreflight;

const RPC_SLOW_MS = 2500;

async function checkRpc(url) {
  const started = Date.now();
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      signal: controller.signal,
    });
    clearTimeout(t);
    const data = await resp.json();
    return { status: 'ok', blockNumber: parseInt(data.result, 16), latencyMs: Date.now() - started };
  } catch (e) {
    return { status: 'error', error: (e && e.message) || 'rpc_error', latencyMs: Date.now() - started };
  }
}

export function onRequestGet(context) {
  return runCore(context, {
    method: 'GET',
    endpoint: '/api/core/v1/health',
    rateKind: 'health',
    permission: 'health:read',
    public: true,
  }, async (ctx) => {
    const env = ctx.env;
    const { data } = await withCache(env, 'health', 'all', async () => {
      const rpcUrl = env.ARC_RPC_URL || RELAYER_CONFIG.ARC_RPC_URL;

      // Circuit-aware RPC probe: if the breaker is open, skip the call.
      const cb = ctx.flags.circuitBreaker ? await breaker.check(env, 'rpc') : { allowed: true, state: 'closed' };
      let rpc;
      if (!cb.allowed) {
        rpc = { status: 'circuit_open', state: cb.state };
      } else {
        rpc = await checkRpc(rpcUrl);
        if (ctx.flags.circuitBreaker) {
          if (rpc.status === 'ok') await breaker.recordSuccess(env, 'rpc');
          else await breaker.recordFailure(env, 'rpc', rpc.error);
        }
        if (rpc.status === 'ok' && rpc.latencyMs > RPC_SLOW_MS) emitAlert(ALERT_TYPES.RPC_SLOW, { latencyMs: rpc.latencyMs });
        if (rpc.status !== 'ok') emitAlert(ALERT_TYPES.RPC_SLOW, { error: rpc.error });
      }

      const cbSnapshot = ctx.flags.circuitBreaker ? await breaker.snapshot(env) : {};
      const latency = summarize(await loadSamples(env, 'global'));
      let appCount = 0;
      try { appCount = (await listApplications(env)).length; } catch (_) {}

      const kvBindings = [
        env.AUTH_KV ? 'AUTH_KV' : null,
        env.PAYMENT_LINKS ? 'PAYMENT_LINKS' : null,
        env.RATE_LIMIT_KV ? 'RATE_LIMIT_KV' : null,
        env.CORE_KV ? 'CORE_KV' : null,
      ].filter(Boolean);

      const rpcHealthy = rpc.status === 'ok';
      const components = {
        circle: { status: 'ok', messageTransmitter: RELAYER_CONFIG.MESSAGE_TRANSMITTER },
        rpc: { status: rpc.status, url: rpcUrl, blockNumber: rpc.blockNumber ?? null, latencyMs: rpc.latencyMs ?? null },
        vault: { status: rpcHealthy ? 'ok' : 'degraded', address: RELAYER_CONFIG.TREASURY_VAULT },
        treasury: { status: rpcHealthy ? 'ok' : 'degraded', address: RELAYER_CONFIG.TREASURY_VAULT },
        relayer: { status: env.TURBO_RELAYER_PRIVATE_KEY ? 'ok' : 'not_configured', circuit: (cbSnapshot.relayer && cbSnapshot.relayer.state) || 'closed' },
        ledger: { status: coreKv(env) ? 'ok' : 'not_configured' },
        kv: { status: kvBindings.length ? 'ok' : 'not_configured', bindings: kvBindings },
        storage: { status: coreKv(env) ? 'ok' : 'not_configured', type: 'cloudflare_kv' },
        workers: { status: 'ok', runtime: 'cloudflare_pages_functions' },
        bridgeEngine: { status: 'ok', provider: 'Circle CCTP v2', chainId: RELAYER_CONFIG.ARC_CHAIN_ID },
      };

      const anyOpen = Object.values(cbSnapshot).some(s => s && s.state === 'open');
      const overall = (!rpcHealthy || anyOpen) ? 'degraded' : 'ok';

      return {
        status: overall,
        network: 'Arc Testnet',
        chainId: RELAYER_CONFIG.ARC_CHAIN_ID,
        components,
        circuitBreaker: cbSnapshot,
        averageLatency: latency.averageLatency,
        errorRate: latency.errorRate,
        requestsPerMin: latency.requestsPerMin,
        p50: latency.p50,
        p95: latency.p95,
        p99: latency.p99,
        applicationCount: appCount,
        checkedAt: new Date().toISOString(),
      };
    });
    return { data };
  });
}
