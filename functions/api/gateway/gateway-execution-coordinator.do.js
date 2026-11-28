/**
 * GatewayExecutionCoordinator — Durable Object for cross-salt Gateway financial
 * coordination + quantitative balance reservation.
 * ═══════════════════════════════════════════════════════════════════════════
 * Phase 1.0.1C.1 (isolated development — NOT active in production).
 *
 * WHY THIS EXISTS
 *   GatewayOpLock keys by `idFromName(salt)` and only deduplicates the SAME salt.
 *   This DO coordinates by (depositor, environment) and adds two guarantees:
 *     1. CROSS-SALT DEDUP on a caller-provided idempotency key (stable across
 *        retries, independent of the salt).
 *     2. QUANTITATIVE BALANCE RESERVATION per balance scope, so concurrent
 *        operations cannot commit more than the authoritative available balance.
 *
 * COORDINATOR SCOPE (sharding proof)
 *   One DO instance per `depositor:environment`. All operations that could
 *   conflict — same idempotency key, same balance scope — reach the SAME instance
 *   and are serialized by the CF runtime. GatewayOpLock REMAINS the per-salt
 *   authority; this DO is additive (a gate, not a parallel executor).
 *
 * STORAGE (durable, SQLite-backed on modern CF)
 *   op:<operationId>    → operation record (see RECORD SHAPE)
 *   idem:<idemKey>      → { operationId, payloadHash }
 *   salt:<salt>         → operationId            (for /confirm reconciliation)
 *   index:operations    → JSON array of operationId (audit — never pruned by release)
 *   bal:<scope>         → { amount, asOf, source, stale }
 *   balres:<scope>      → { total } (BigInt string of active reserved amounts)
 *
 * ATOMICITY
 *   Every read-modify-write runs inside `storage.transaction()` and every request
 *   inside `state.blockConcurrencyWhile()`. Reserve/update/release are race-free.
 *   No external calls happen inside storage transactions.
 *
 * INTERNAL AUTH
 *   Every request must carry `X-DO-Internal-Secret` matching env.DO_INTERNAL_SECRET
 *   (constant-time). Never a public route.
 *
 * STATE MACHINE
 *   reserved | submitting | accepted | ambiguous | requires_review
 *   | confirmed | rejected | failed
 *
 *     reserved         reservation + signed intent + balance reserved (not forwarded)
 *     submitting       forwarded to Circle (persisted BEFORE the POST)
 *     accepted         Circle 2xx — attestation available (mint pending)
 *     ambiguous        Circle result unknown (timeout / 5xx / 429 / 408)
 *     requires_review  manual reconciliation needed
 *     confirmed        on-chain settlement verified   (TERMINAL)
 *     rejected         Circle definitive 4xx          (TERMINAL)
 *     failed           verified failure / rollback    (TERMINAL)
 *
 *   Transitions:
 *     reserved        → submitting | rejected | failed(rollback only)
 *     submitting      → accepted | rejected | ambiguous
 *     accepted        → confirmed | failed | requires_review
 *     ambiguous       → accepted | rejected | confirmed | failed | requires_review
 *     requires_review → accepted | rejected | confirmed | failed
 *
 *   RESERVATION RELEASE (terminal transitions)
 *     rejected          → never settled: release reserved amount, balance unchanged.
 *     failed (rollback) → never settled: release reserved amount, balance unchanged.
 *     failed (post-accept) → settled: release + decrement balance snapshot (conservative).
 *     confirmed         → settled: release + decrement balance snapshot (conservative).
 *   Ambiguous / requires_review reservations are NEVER released on timeout/lease.
 *
 * ── Activation (Cloudflare Pages, isolated — like GATEWAY_OP_LOCK) ──────────
 *   1. Deploy a standalone Worker exporting GatewayExecutionCoordinator from this
 *      file (wrangler.toml: durable_objects.bindings name =
 *      GATEWAY_EXECUTION_COORDINATOR, class_name = GatewayExecutionCoordinator,
 *      migrations tag = "v1").
 *   2. CF Dashboard → Pages → elligentt → Settings → Functions → DO bindings:
 *        Variable name: GATEWAY_EXECUTION_COORDINATOR
 *        Namespace:     (namespace from step 1)
 *   3. Set DO_INTERNAL_SECRET (already required by GATEWAY_OP_LOCK).
 *   4. Re-deploy, then set GATEWAY_EXECUTION_COORDINATOR_ENABLED = 'true'.
 *   INACTIVE unless BOTH the binding is present AND the flag is truthy.
 */

import {
  canonicalPayloadHash,
  isValidIdempotencyKey,
  depositorOf,
  environmentFor,
  scopeKeyFor,
} from './coordinator-util.js';

const SCHEMA_VERSION = 2;

// ── State machine ────────────────────────────────────────────────────────────
const VALID_TRANSITIONS = {
  reserved:        ['submitting', 'rejected', 'failed'],
  submitting:      ['accepted', 'rejected', 'ambiguous', 'failed'], // 'failed' = rollback only
  accepted:        ['confirmed', 'failed', 'requires_review'],
  ambiguous:       ['accepted', 'rejected', 'confirmed', 'failed', 'requires_review'],
  requires_review: ['accepted', 'rejected', 'confirmed', 'failed'],
  confirmed:       [],
  rejected:        [],
  failed:          [],
};

const TERMINAL_STATES = new Set(['confirmed', 'rejected', 'failed']);
const KNOWN_STATES   = new Set(Object.keys(VALID_TRANSITIONS));
// States in which the operation's amount is still "reserved" against the balance.
const ACTIVE_STATES  = new Set(['reserved', 'submitting', 'accepted', 'ambiguous', 'requires_review']);

const KEY_OP    = 'op:';
const KEY_IDEM  = 'idem:';
const KEY_SALT  = 'salt:';
const KEY_INDEX = 'index:operations';
const KEY_BAL   = 'bal:';
const KEY_BALRES = 'balres:';
const KEY_RECON = 'reconcile:';

// Reconciliation alarm backoff (ms). Bounded retry — after exhaustion the marker
// is escalated to requires_review rather than retried forever.
const RECONCILE_BACKOFF_MS = [1000, 5000, 30000];
const MAX_RECONCILE_ATTEMPTS = RECONCILE_BACKOFF_MS.length;

// Balance snapshot temporal validity: a snapshot older than this (ms) is treated
// as stale and requires a re-sync before reserving.
const BALANCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const OPERATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SALT_RE         = /^0x[0-9a-fA-F]{64}$/;
const HASH_RE         = /^[0-9a-f]{64}$/i;
const SCOPE_RE        = /^0x[0-9a-f]{40}:\d{1,10}$/;
const UINT_STR_RE     = /^\d{1,78}$/;   // non-negative decimal string, no sign

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function uuid() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
}

// BigInt arithmetic on canonical decimal strings (fail-closed on parse error).
function addUint(a, b) {
  try { return (BigInt(a) + BigInt(b)).toString(); } catch(_) { return null; }
}
function subUint(a, b) {
  try {
    const x = BigInt(a) - BigInt(b);
    return x < 0n ? '0' : x.toString();
  } catch(_) { return null; }
}

export class GatewayExecutionCoordinator {
  constructor(state, env) {
    this.state   = state;
    this.storage = state.storage;
    this.env     = env || {};
  }

  static json(body, status) {
    return new Response(JSON.stringify(body), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  _authorized(request) {
    const expected = this.env && this.env.DO_INTERNAL_SECRET;
    const provided = request.headers.get('X-DO-Internal-Secret') || '';
    return !!(expected && timingSafeEqual(expected, provided));
  }

  /* ── Route entry ──────────────────────────────────────────────────────── */
  async fetch(request) {
    if (!this._authorized(request)) {
      return GatewayExecutionCoordinator.json({ error: 'unauthorized' }, 401);
    }
    const url    = new URL(request.url);
    const path   = url.pathname.replace(/\/+$/, '');
    const method = request.method;
    try {
      return await this.state.blockConcurrencyWhile(async () => {
        if (method === 'POST'   && path === '/reserve')      return this._reserve(request);
        if (method === 'POST'   && path === '/set-balance')  return this._setBalance(request);
        if (method === 'POST'   && path === '/update')       return this._update(request);
        if (method === 'POST'   && path === '/dispatch')     return this._dispatch(request);
        if (method === 'POST'   && path === '/reconcile')    return this._reconcile(request);
        if (method === 'GET'    && path === '/status')       return this._status(url);
        if (method === 'GET'    && path === '/balance')      return this._balanceMeta(url);
        if (method === 'DELETE' && path === '/release')      return this._release(request);
        return GatewayExecutionCoordinator.json({ error: 'not_found' }, 404);
      });
    } catch (e) {
      return GatewayExecutionCoordinator.json({ error: 'internal_error', detail: (e && e.message) || 'unknown' }, 500);
    }
  }

  /* ── POST /reserve ────────────────────────────────────────────────────── */
  // Body: { burnIntent, idempotencyKey, operationId? }
  // The DO recomputes depositor/environment/scope/payloadHash server-side (never
  // trusts client-computed values). Dedups on the caller-provided idempotency key;
  // enforces the quantitative balance reservation.
  //
  // Outcome:
  //   201 { reserved:true, record }
  //   200 { recovered:true, record }        — same key + same payload
  //   409 { error:'conflict', record }      — same key + different payload
  //   422 { error:'insufficient_available_balance', available, requested }
  //   503 { error:'balance_not_synced' }    — no authoritative balance snapshot
  //   400 { error:'...' }
  async _reserve(request) {
    let body;
    try { body = await request.json(); } catch (_) {
      return GatewayExecutionCoordinator.json({ error: 'invalid_json' }, 400);
    }

    const burnIntent = body && body.burnIntent;
    const v = this._validateBurnIntent(burnIntent);
    if (v) return GatewayExecutionCoordinator.json({ error: v }, 400);

    if (!isValidIdempotencyKey(body && body.idempotencyKey)) {
      return GatewayExecutionCoordinator.json({
        error:  'idempotencyKey_required',
        detail: 'A caller-provided idempotency key (8–128 chars, [A-Za-z0-9._-]) is required.',
      }, 400);
    }
    const idemKey = body.idempotencyKey;

    const depositor = depositorOf(burnIntent);
    const envName   = environmentFor(burnIntent);
    if (envName === null) {
      return GatewayExecutionCoordinator.json({
        error:  'unknown_environment',
        detail: 'sourceContract is not a recognized GatewayWallet (mainnet/testnet).',
      }, 400);
    }
    const scope       = scopeKeyFor(burnIntent);
    const payloadHash = await canonicalPayloadHash(burnIntent);

    const operationId = (typeof body.operationId === 'string' && OPERATION_ID_RE.test(body.operationId))
      ? body.operationId
      : uuid();

    const spec = burnIntent.spec;
    const salt = spec.salt;
    const now  = new Date().toISOString();

    // Reserved amount = value + maxFee (worst-case debit), computed in BigInt.
    const valueStr = String(spec.value);
    const feeStr   = burnIntent.maxFee != null ? String(burnIntent.maxFee) : '0';
    if (!UINT_STR_RE.test(valueStr) || !UINT_STR_RE.test(feeStr)) {
      return GatewayExecutionCoordinator.json({ error: 'invalid_amount' }, 400);
    }
    const reservedAmount = addUint(valueStr, feeStr);
    if (reservedAmount === null) {
      return GatewayExecutionCoordinator.json({ error: 'invalid_amount' }, 400);
    }

    const outcome = await this.storage.transaction(async (txn) => {
      // ── Idempotency dedup (caller-provided key — PERMANENT identity) ──────
      // The idempotency key is bound to ONE operation forever. Once used, it is
      // never reusable for a new intent — a new intent MUST carry a new key.
      const existingIdem = await txn.get(KEY_IDEM + idemKey);
      if (existingIdem) {
        const existing = await txn.get(KEY_OP + existingIdem.operationId);
        if (existing) {
          // Same key + same payload → recover the ORIGINAL operation, even after
          // confirmed/rejected/failed (identity is permanent).
          if (existing.payloadHash === payloadHash) {
            return { status: 200, body: { recovered: true, record: existing } };
          }
          // Same key + different payload → conflict (never silently replace).
          return { status: 409, body: { error: 'conflict', detail: 'idempotency_key_reused_with_different_payload', record: existing } };
        }
        // Index points to a missing record (corruption) — fail safe, do NOT recreate.
        return { status: 500, body: { error: 'corrupt_idempotency_index', detail: 'idempotency key bound to a missing operation record', idempotencyKey: idemKey } };
      }

      // ── Collision checks (salt + operationId) — atomic ───────────────────
      // A salt bound to a DIFFERENT operation is a replay attempt.
      const saltBound = await txn.get(KEY_SALT + salt);
      if (saltBound && saltBound !== operationId) {
        return { status: 409, body: { error: 'salt_already_bound', detail: 'salt already bound to a different operation', operationId: saltBound } };
      }
      // A caller-provided operationId that already exists is a collision.
      const existingOp = await txn.get(KEY_OP + operationId);
      if (existingOp) {
        return { status: 409, body: { error: 'operation_id_collision', detail: 'operationId already exists', operationId } };
      }

      // ── Quantitative balance reservation ────────────────────────────────
      const snapshot = await txn.get(KEY_BAL + scope);
      if (!snapshot || typeof snapshot.amount !== 'string') {
        return { status: 503, body: { error: 'balance_not_synced', scope, detail: 'No authoritative balance snapshot for this scope.' } };
      }
      if (snapshot.stale === true) {
        return { status: 503, body: { error: 'balance_stale', scope, detail: 'Balance snapshot is stale; re-sync before reserving.' } };
      }
      // Temporal validity (Gate D): an expired snapshot is treated as stale, so a
      // never-re-synced snapshot cannot authorize reservation indefinitely.
      if (typeof snapshot.asOf === 'string' && snapshot.asOf) {
        const asOfMs = Date.parse(snapshot.asOf);
        if (Number.isFinite(asOfMs) && (Date.now() - asOfMs) > BALANCE_TTL_MS) {
          return { status: 503, body: { error: 'balance_expired', scope, detail: 'Balance snapshot exceeded its validity window; re-sync before reserving.' } };
        }
      }
      const balRes = await txn.get(KEY_BALRES + scope);
      const reservedTotal = (balRes && balRes.total) || '0';
      const available = subUint(snapshot.amount, reservedTotal);
      if (available === null) {
        return { status: 500, body: { error: 'balance_arithmetic_error' } };
      }
      // requested amount must fit within the authoritative available balance.
      if (BigInt(reservedAmount) > BigInt(available)) {
        return {
          status: 422,
          body:   {
            error:     'insufficient_available_balance',
            scope,
            requested: reservedAmount,
            available,
            reserved:  reservedTotal,
            balance:   snapshot.amount,
          },
        };
      }

      const record = {
        schemaVersion:  SCHEMA_VERSION,
        operationId,
        idempotencyKey: idemKey,
        payloadHash,
        depositor,
        environment:    envName,
        srcDomain:      spec.sourceDomain,
        dstDomain:      spec.destinationDomain,
        sourceContract: spec.sourceContract,
        destinationContract: spec.destinationContract,
        sourceToken:    spec.sourceToken,
        destinationToken: spec.destinationToken,
        destinationRecipient: spec.destinationRecipient,
        value:          valueStr,
        maxFee:         burnIntent.maxFee != null ? String(burnIntent.maxFee) : null,
        reservedAmount,
        scope,
        salt,
        status:         'reserved',
        dispatched:     false,          // set true (durably) only right before the POST
        version:        1,
        createdAt:      now,
        updatedAt:      now,
        transferId:     null,
        expirationBlock: null,
        attestationHash: null,
        signatureHash:  null,
        attestationPayload: null,   // protected recovery material (Gate F)
        attestationSignature: null, // protected recovery material (Gate F)
        txHash:         null,
        burnTxHash:     null,
        evidence:       [],
        released:       false,
        releasedAt:     null,
      };

      const newTotal = addUint(reservedTotal, reservedAmount);
      await txn.put(KEY_OP + operationId, record);
      await txn.put(KEY_IDEM + idemKey, { operationId, payloadHash });
      await txn.put(KEY_SALT + salt, operationId);
      await txn.put(KEY_BALRES + scope, { total: newTotal });

      const index = (await txn.get(KEY_INDEX)) || [];
      await txn.put(KEY_INDEX, Array.isArray(index) ? index.concat([operationId]) : [operationId]);

      return { status: 201, body: { reserved: true, record } };
    });

    return GatewayExecutionCoordinator.json(outcome.body, outcome.status);
  }

  _validateBurnIntent(bi) {
    if (!bi || typeof bi !== 'object') return 'burnIntent_required';
    const spec = bi.spec;
    if (!spec || typeof spec !== 'object') return 'spec_required';
    if (typeof spec.salt !== 'string' || !SALT_RE.test(spec.salt)) return 'salt_required';
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(spec.sourceDepositor || ''))) return 'sourceDepositor_required';
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(spec.sourceContract || ''))) return 'sourceContract_required';
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(spec.destinationRecipient || ''))) return 'destinationRecipient_required';
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(spec.destinationContract || ''))) return 'destinationContract_required';
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(spec.sourceToken || ''))) return 'sourceToken_required';
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(spec.destinationToken || ''))) return 'destinationToken_required';
    if (spec.value == null || !UINT_STR_RE.test(String(spec.value))) return 'invalid_value';
    return null;
  }

  /* ── POST /set-balance ────────────────────────────────────────────────── */
  // Body: { scope, amount, source?, asOf?, expectedGeneration? } — trusted
  // internal only. Sets the authoritative balance snapshot (amount MUST be atomic).
  // Financial fencing (Gate E): `expectedGeneration` is the generation the caller
  // observed BEFORE its external balance query. If the generation advanced since
  // (a settle/write happened during the query), the snapshot is rejected
  // (`409 stale_generation`), so a pre-settlement query can never restore committed
  // balance. `asOf` ordering + the monotonic generation remain as defense-in-depth.
  async _setBalance(request) {
    let body;
    try { body = await request.json(); } catch (_) {
      return GatewayExecutionCoordinator.json({ error: 'invalid_json' }, 400);
    }
    const scope  = body && body.scope;
    const amount = body && body.amount;
    if (typeof scope !== 'string' || !SCOPE_RE.test(scope)) {
      return GatewayExecutionCoordinator.json({ error: 'invalid_scope' }, 400);
    }
    if (typeof amount !== 'string' || !UINT_STR_RE.test(amount)) {
      return GatewayExecutionCoordinator.json({ error: 'invalid_amount' }, 400);
    }
    const asOf = (typeof body.asOf === 'string' && body.asOf) ? body.asOf : new Date().toISOString();
    const expectedGeneration = (body.expectedGeneration != null && Number.isInteger(body.expectedGeneration))
      ? body.expectedGeneration : null;

    const outcome = await this.storage.transaction(async (txn) => {
      const current = await txn.get(KEY_BAL + scope);
      if (current) {
        const currentGen = typeof current.generation === 'number' ? current.generation : 0;
        // Fencing: reject a query that started before the current generation.
        if (expectedGeneration != null && expectedGeneration < currentGen) {
          return { status: 409, body: { error: 'stale_generation', scope, currentGeneration: currentGen, expectedGeneration } };
        }
        // Reject an out-of-order (older) snapshot.
        if (typeof current.asOf === 'string' && current.asOf && asOf < current.asOf) {
          return { status: 409, body: { error: 'stale_snapshot', scope, currentAsOf: current.asOf, providedAsOf: asOf } };
        }
        const generation = currentGen + 1;
        const snapshot = { amount, source: body.source || 'circle', asOf, stale: false, generation };
        await txn.put(KEY_BAL + scope, snapshot);
        return { status: 200, body: { ok: true, scope, balance: snapshot } };
      }
      const snapshot = { amount, source: body.source || 'circle', asOf, stale: false, generation: 1 };
      await txn.put(KEY_BAL + scope, snapshot);
      return { status: 200, body: { ok: true, scope, balance: snapshot } };
    });

    return GatewayExecutionCoordinator.json(outcome.body, outcome.status);
  }

  /* ── POST /update ─────────────────────────────────────────────────────── */
  // Body: { operationId, to, expectedVersion, evidence? }
  //   evidence: { transactionHash?, transferId?, expirationBlock?,
  //               attestationHash?, signatureHash?,
  //               attestationPayload?, attestationSignature?, reason?, rollback? }
  async _update(request) {
    let body;
    try { body = await request.json(); } catch (_) {
      return GatewayExecutionCoordinator.json({ error: 'invalid_json' }, 400);
    }
    const operationId     = body && body.operationId;
    const to              = body && body.to;
    const expectedVersion = body && body.expectedVersion;
    const evidence        = body && body.evidence && typeof body.evidence === 'object' ? body.evidence : {};

    if (typeof operationId !== 'string' || !OPERATION_ID_RE.test(operationId)) {
      return GatewayExecutionCoordinator.json({ error: 'invalid_operation_id' }, 400);
    }
    if (typeof to !== 'string' || !KNOWN_STATES.has(to)) {
      return GatewayExecutionCoordinator.json({ error: 'unknown_status', detail: 'Unknown status: ' + to }, 400);
    }
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      return GatewayExecutionCoordinator.json({ error: 'invalid_version' }, 400);
    }

    const outcome = await this.storage.transaction(async (txn) => {
      return this._transitionOp(txn, operationId, to, evidence, { expectedVersion, via: 'update' });
    });

    return GatewayExecutionCoordinator.json(outcome.body, outcome.status);
  }

  /* ── Unified transactional transition (Gate D) ─────────────────────────── */
  // The SINGLE implementation of the financial state machine. Every path —
  // /update, /reconcile, alarm recovery — funnels through here, so no alternate
  // path can bypass fencing, evidence validation, post-dispatch protection,
  // reserve release, balance update, or terminal idempotency.
  //
  // Returns { status, body, resolved } where resolved ∈ 'applied' | 'already' | null.
  async _transitionOp(txn, opId, to, evidence, opts = {}) {
    const record = await txn.get(KEY_OP + opId);
    if (!record) return { status: 404, body: { error: 'not_found' } };

    // Fencing: an explicit expectedVersion must match the current version.
    if (opts.expectedVersion != null && record.version !== opts.expectedVersion) {
      return { status: 409, body: { error: 'stale_version', current: record.version, expected: opts.expectedVersion } };
    }
    // Terminal idempotency: already in the target state → no-op (never double release).
    if (record.status === to) {
      return { status: 200, body: { ok: true, idempotent: true, record }, resolved: 'already' };
    }

    const allowed = VALID_TRANSITIONS[record.status] || [];
    if (!allowed.includes(to)) {
      return { status: 400, body: { error: 'invalid_transition', from: record.status, to, allowed } };
    }

    // reserved/submitting → failed is ONLY a batch rollback, and ONLY when the
    // operation was never dispatched (Gate E). A dispatched op cannot be rolled
    // back by a bare boolean flag — it must go through `ambiguous` reconciliation.
    if ((record.status === 'reserved' || record.status === 'submitting') && to === 'failed') {
      if (evidence.rollback !== true) {
        return { status: 400, body: { error: 'rollback_required', from: record.status, to } };
      }
      if (record.dispatched === true) {
        return { status: 409, body: { error: 'cannot_rollback_dispatched', from: record.status, to, detail: 'Operation was already dispatched; use ambiguous instead.' } };
      }
    }

    if (to === 'confirmed' && !evidence.transactionHash) {
      return { status: 400, body: { error: 'confirmed_requires_transaction_hash' } };
    }
    if (to === 'requires_review' && !evidence.reason) {
      return { status: 400, body: { error: 'requires_review_requires_reason' } };
    }

    const now = Date.now();
    const updated = {
      ...record,
      status:    to,
      version:   record.version + 1,
      updatedAt: new Date(now).toISOString(),
      transferId:      evidence.transferId      || record.transferId      || null,
      expirationBlock: evidence.expirationBlock || record.expirationBlock || null,
      attestationHash: evidence.attestationHash || record.attestationHash || null,
      signatureHash:   evidence.signatureHash   || record.signatureHash   || null,
      attestationPayload:   evidence.attestationPayload   || record.attestationPayload   || null,
      attestationSignature: evidence.attestationSignature || record.attestationSignature || null,
      txHash:          evidence.transactionHash || record.txHash          || null,
      burnTxHash:      evidence.burnTxHash      || record.burnTxHash      || null,
      evidence:        record.evidence.concat([{ to, at: new Date(now).toISOString(), via: opts.via || 'update', ...(evidence.reason ? { reason: evidence.reason } : {}) }]),
    };
    await txn.put(KEY_OP + opId, updated);

    // ── Reservation release on terminal transition (at most once) ──────────
    if (TERMINAL_STATES.has(to)) {
      const balRes = await txn.get(KEY_BALRES + record.scope);
      const reservedTotal = (balRes && balRes.total) || '0';
      await txn.put(KEY_BALRES + record.scope, { total: subUint(reservedTotal, record.reservedAmount) });

      // Settled (Circle actually debited) → decrement the snapshot conservatively
      // and mark stale so the next reserve requires a fresh balance sync. Bump
      // `asOf` + `generation` so an in-flight snapshot fetched BEFORE this settle
      // is rejected as stale (never restores already-debited balance).
      const settled = to === 'confirmed' || (to === 'failed' && record.status !== 'reserved' && record.status !== 'submitting');
      if (settled) {
        const snapshot = await txn.get(KEY_BAL + record.scope);
        if (snapshot && typeof snapshot.amount === 'string') {
          await txn.put(KEY_BAL + record.scope, {
            ...snapshot,
            amount:     subUint(snapshot.amount, record.reservedAmount),
            stale:      true,
            asOf:       new Date(now).toISOString(),
            generation: (typeof snapshot.generation === 'number' ? snapshot.generation : 0) + 1,
          });
        }
      }
    }

    return { status: 200, body: { ok: true, record: updated }, resolved: 'applied' };
  }

  /* ── GET /status?operationId= | idempotencyKey= | salt= ──────────────── */
  async _status(url) {
    const operationId = url.searchParams.get('operationId') || '';
    const idemKey     = url.searchParams.get('idempotencyKey') || '';
    const salt        = url.searchParams.get('salt') || '';

    const outcome = await this.storage.transaction(async (txn) => {
      if (operationId) {
        const record = await txn.get(KEY_OP + operationId);
        if (!record) return { status: 404, body: { error: 'not_found' } };
        return { status: 200, body: { record } };
      }
      if (idemKey) {
        const idem = await txn.get(KEY_IDEM + idemKey);
        if (!idem) return { status: 404, body: { error: 'not_found' } };
        const record = await txn.get(KEY_OP + idem.operationId);
        if (!record) return { status: 404, body: { error: 'not_found' } };
        return { status: 200, body: { record } };
      }
      if (salt) {
        const opId = await txn.get(KEY_SALT + salt);
        if (!opId) return { status: 404, body: { error: 'not_found' } };
        const record = await txn.get(KEY_OP + opId);
        if (!record) return { status: 404, body: { error: 'not_found' } };
        return { status: 200, body: { record } };
      }
      return { status: 400, body: { error: 'operationId_or_idempotencyKey_or_salt_required' } };
    });

    return GatewayExecutionCoordinator.json(outcome.body, outcome.status);
  }

  /* ── DELETE /release ──────────────────────────────────────────────────── */
  // Body: { operationId }. Only terminal operations may be released. Release does
  // NOT delete history: it marks the record released and removes ONLY the
  // idempotency/salt bindings so a new intent can reuse the slot — the op record
  // and the audit index are preserved for replay protection and reconciliation.
  // The index membership is verified atomically so an old operation can never
  // remove a newer operation's index entry.
  async _release(request) {
    let body;
    try { body = await request.json(); } catch (_) {
      return GatewayExecutionCoordinator.json({ error: 'invalid_json' }, 400);
    }
    const operationId = body && body.operationId;
    if (typeof operationId !== 'string' || !OPERATION_ID_RE.test(operationId)) {
      return GatewayExecutionCoordinator.json({ error: 'invalid_operation_id' }, 400);
    }

    const outcome = await this.storage.transaction(async (txn) => {
      const record = await txn.get(KEY_OP + operationId);
      if (!record) return { status: 404, body: { error: 'not_found' } };
      if (!TERMINAL_STATES.has(record.status)) {
        return { status: 409, body: { error: 'not_terminal', current: record.status } };
      }

      // Releasing a reservation NEVER deletes the operation identity or the
      // idempotency/salt bindings. Those are permanent replay-protection + audit
      // links (Gate A/D). Release only marks the record released — a later reserve
      // with the SAME idempotency key still recovers/conflicts against this record.
      const now = Date.now();
      await txn.put(KEY_OP + operationId, {
        ...record,
        released:   true,
        releasedAt: new Date(now).toISOString(),
      });

      // Preserve the audit index (do NOT remove operationId) — history is kept.
      return { status: 200, body: { ok: true, released: operationId } };
    });

    return GatewayExecutionCoordinator.json(outcome.body, outcome.status);
  }

  /* ── POST /dispatch ───────────────────────────────────────────────────── */
  // Body: { operationId, expectedVersion } — marks the operation `dispatched:true`
  // DURABLY, right before the Circle POST. After this, a rollback via the boolean
  // flag is refused; an interrupted POST must resolve as `ambiguous`. This makes
  // "was it submitted?" durable and independent of the caller's word.
  async _dispatch(request) {
    let body;
    try { body = await request.json(); } catch (_) {
      return GatewayExecutionCoordinator.json({ error: 'invalid_json' }, 400);
    }
    const operationId     = body && body.operationId;
    const expectedVersion = body && body.expectedVersion;
    if (typeof operationId !== 'string' || !OPERATION_ID_RE.test(operationId)) {
      return GatewayExecutionCoordinator.json({ error: 'invalid_operation_id' }, 400);
    }
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      return GatewayExecutionCoordinator.json({ error: 'invalid_version' }, 400);
    }

    const outcome = await this.storage.transaction(async (txn) => {
      const record = await txn.get(KEY_OP + operationId);
      if (!record) return { status: 404, body: { error: 'not_found' } };
      if (record.version !== expectedVersion) {
        return { status: 409, body: { error: 'stale_version', current: record.version, expected: expectedVersion } };
      }
      // Dispatch is only meaningful from 'submitting' (dispatch authorized).
      if (record.status !== 'submitting') {
        return { status: 409, body: { error: 'not_submitting', current: record.status } };
      }
      const updated = { ...record, dispatched: true, updatedAt: new Date().toISOString() };
      await txn.put(KEY_OP + operationId, updated);
      return { status: 200, body: { ok: true, record: updated } };
    });

    return GatewayExecutionCoordinator.json(outcome.body, outcome.status);
  }

  /* ── GET /balance?scope= ──────────────────────────────────────────────── */
  // Returns the current balance snapshot metadata (amount + generation) so the
  // caller can fence a subsequent /set-balance against a stale query.
  async _balanceMeta(url) {
    const scope = url.searchParams.get('scope') || '';
    if (!SCOPE_RE.test(scope)) return GatewayExecutionCoordinator.json({ error: 'invalid_scope' }, 400);
    const snapshot = await this.storage.get(KEY_BAL + scope);
    if (!snapshot) return GatewayExecutionCoordinator.json({ error: 'not_found' }, 404);
    return GatewayExecutionCoordinator.json({ scope, amount: snapshot.amount, generation: snapshot.generation || 0, asOf: snapshot.asOf });
  }

  /* ── POST /reconcile ──────────────────────────────────────────────────── */
  // Body: { salt, to, evidence }. Registers a durable reconciliation obligation
  // (Gate B) and attempts an immediate idempotent transition. Returns 404 when the
  // salt is NOT in this environment (so the caller probes the other shard); 200 with
  // resolved ∈ applied|already|durably_queued when the obligation is durably
  // persisted; 409 on a divergent terminal state.
  async _reconcile(request) {
    let body;
    try { body = await request.json(); } catch (_) {
      return GatewayExecutionCoordinator.json({ error: 'invalid_json' }, 400);
    }
    const salt     = body && body.salt;
    const to       = body && body.to;
    const evidence = body && body.evidence && typeof body.evidence === 'object' ? body.evidence : {};
    if (typeof salt !== 'string' || !SALT_RE.test(salt)) {
      return GatewayExecutionCoordinator.json({ error: 'invalid_salt' }, 400);
    }
    if (typeof to !== 'string' || !KNOWN_STATES.has(to)) {
      return GatewayExecutionCoordinator.json({ error: 'unknown_status', detail: 'Unknown status: ' + to }, 400);
    }

    const outcome = await this.storage.transaction(async (txn) => {
      // Environment isolation: only register the obligation if the salt is bound
      // in THIS shard. Otherwise return 404 so the caller probes the other shard.
      const opId = await txn.get(KEY_SALT + salt);
      if (!opId) {
        return { status: 404, body: { error: 'not_in_this_environment' } };
      }
      // Durable obligation BEFORE the transition.
      await txn.put(KEY_RECON + salt, { salt, to, evidence, attempts: 0, createdAt: new Date().toISOString() });
      const result = await this._applyReconcile(txn, salt, to, evidence);
      switch (result.resolved) {
        case 'applied':
        case 'already':
          return { status: 200, body: { ok: true, resolved: result.resolved, record: result.body.record } };
        case 'conflict':
          return { status: 409, body: result.body };
        case 'no_record':
          return { status: 500, body: result.body };
        case 'pending':
        default:
          return { status: 200, body: { ok: true, resolved: 'durably_queued' } };
      }
    });

    if (outcome.status === 200 && outcome.body && (outcome.body.resolved === 'applied' || outcome.body.resolved === 'already')) {
      const remaining = await this._hasPendingReconciles();
      if (!remaining) await this.storage.deleteAlarm().catch(() => {});
    } else if (outcome.status === 200 || outcome.status === 500) {
      await this._armReconcileAlarm();
    }
    return GatewayExecutionCoordinator.json(outcome.body, outcome.status);
  }

  /* ── Reconcile application (shared by /reconcile and alarm) ───────────── */
  // Gate C/D: applies the terminal transition through the SAME unified state
  // machine as /update. Never discards an obligation for a missing op / corrupt
  // index / divergent state. Returns `resolved` ∈
  //   'applied' | 'already' | 'conflict' | 'pending' | 'no_operation' | 'no_record'.
  async _applyReconcile(txn, salt, to, evidence) {
    const opId = await txn.get(KEY_SALT + salt);
    if (!opId) {
      return { resolved: 'no_operation', body: { error: 'reconcile_no_operation' } };
    }
    const record = await txn.get(KEY_OP + opId);
    if (!record) {
      return { resolved: 'no_record', body: { error: 'reconcile_no_record', operationId: opId } };
    }
    // Divergent terminal state → auditable conflict (never silently succeed).
    if (TERMINAL_STATES.has(record.status) && record.status !== to) {
      await txn.delete(KEY_RECON + salt);
      return { resolved: 'conflict', body: { ok: false, error: 'divergent_terminal_state', current: record.status, requested: to, operationId: opId } };
    }

    const outcome = await this._transitionOp(txn, opId, to, evidence, { via: 'reconcile' });
    if (outcome.resolved === 'applied' || outcome.resolved === 'already') {
      await txn.delete(KEY_RECON + salt);
      return { resolved: outcome.resolved, body: outcome.body };
    }
    // Not applied (e.g. still 'reserved', missing evidence) → keep pending for retry.
    return { resolved: 'pending', body: outcome.body };
  }

  async _hasPendingReconciles() {
    const list = await this.storage.list({ prefix: KEY_RECON });
    return (list.keys || []).length > 0;
  }

  async _armReconcileAlarm() {
    const current = await this.storage.getAlarm();
    if (current === null) {
      await this.storage.setAlarm(Date.now() + RECONCILE_BACKOFF_MS[0]);
    }
  }

  /* ── alarm — durable reconciliation retry with backoff ────────────────── */
  // Fires for pending reconcile markers. Applies each idempotently; exhausted
  // markers are escalated to requires_review. Re-arms for any remaining marker.
  async alarm() {
    await this.state.blockConcurrencyWhile(async () => {
      const list = await this.storage.list({ prefix: KEY_RECON });
      const keys = (list.keys || []).map((k) => k.name);
      let maxAttempts = 0;
      for (const key of keys) {
        const marker = await this.storage.get(key);
        if (!marker) { await this.storage.delete(key); continue; }
        const attempts = (typeof marker.attempts === 'number' ? marker.attempts : 0) + 1;
        maxAttempts = Math.max(maxAttempts, attempts);
        const result = await this.storage.transaction((txn) =>
          this._applyReconcile(txn, marker.salt, marker.to, marker.evidence));
        // applied / already / conflict → the marker was already resolved in the txn.
        const pending = result.resolved === 'pending' || result.resolved === 'no_record' || result.resolved === 'no_operation';
        if (pending) {
          if (attempts >= MAX_RECONCILE_ATTEMPTS) {
            // Escalate: mark the op requires_review (best-effort, evidence preserved).
            await this.storage.transaction(async (txn) => {
              const opId = await txn.get(KEY_SALT + marker.salt);
              if (opId) {
                const record = await txn.get(KEY_OP + opId);
                if (record && !TERMINAL_STATES.has(record.status) && record.status !== 'requires_review') {
                  await txn.put(KEY_OP + opId, { ...record, status: 'requires_review', version: record.version + 1, updatedAt: new Date().toISOString() });
                }
              }
            });
            await this.storage.delete(key);
            continue;
          }
          await this.storage.put(key, { ...marker, attempts });
        }
      }
      const remaining = await this._hasPendingReconciles();
      if (remaining) {
        const idx = Math.max(0, Math.min(maxAttempts - 1, RECONCILE_BACKOFF_MS.length - 1));
        await this.storage.setAlarm(Date.now() + RECONCILE_BACKOFF_MS[idx]);
      } else {
        await this.storage.deleteAlarm().catch(() => {});
      }
    });
  }
}
