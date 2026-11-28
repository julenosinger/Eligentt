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
  submitting:      ['accepted', 'rejected', 'ambiguous'],
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
        if (method === 'GET'    && path === '/status')       return this._status(url);
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
      // ── Idempotency dedup (caller-provided key) ─────────────────────────
      const existingIdem = await txn.get(KEY_IDEM + idemKey);
      if (existingIdem) {
        const existing = await txn.get(KEY_OP + existingIdem.operationId);
        if (existing) {
          if (TERMINAL_STATES.has(existing.status)) {
            // terminal → slot freed; fall through to (re)create below.
          } else if (existing.payloadHash === payloadHash) {
            return { status: 200, body: { recovered: true, record: existing } };
          } else {
            return { status: 409, body: { error: 'conflict', detail: 'idempotency_key_reused_with_different_payload', record: existing } };
          }
        }
      }

      // ── Quantitative balance reservation ────────────────────────────────
      const snapshot = await txn.get(KEY_BAL + scope);
      if (!snapshot || typeof snapshot.amount !== 'string') {
        return { status: 503, body: { error: 'balance_not_synced', scope, detail: 'No authoritative balance snapshot for this scope.' } };
      }
      if (snapshot.stale === true) {
        return { status: 503, body: { error: 'balance_stale', scope, detail: 'Balance snapshot is stale; re-sync before reserving.' } };
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
  // Body: { scope, amount, source?, asOf? } — trusted internal only. Sets the
  // authoritative balance snapshot for a scope. Replaces any stale flag.
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
    const snapshot = {
      amount,
      source: body.source || 'circle',
      asOf:   body.asOf   || new Date().toISOString(),
      stale:  false,
    };
    await this.storage.put(KEY_BAL + scope, snapshot);
    return GatewayExecutionCoordinator.json({ ok: true, scope, balance: snapshot });
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
      const record = await txn.get(KEY_OP + operationId);
      if (!record) return { status: 404, body: { error: 'not_found' } };

      if (record.version !== expectedVersion) {
        return { status: 409, body: { error: 'stale_version', current: record.version, expected: expectedVersion } };
      }
      if (record.status === to) {
        return { status: 200, body: { ok: true, idempotent: true, record } };
      }

      const allowed = VALID_TRANSITIONS[record.status] || [];
      if (!allowed.includes(to)) {
        return { status: 400, body: { error: 'invalid_transition', from: record.status, to, allowed } };
      }

      // reserved/submitting → failed is ONLY a batch rollback.
      if ((record.status === 'reserved' || record.status === 'submitting') &&
          to === 'failed' && evidence.rollback !== true) {
        return { status: 400, body: { error: 'rollback_required', from: record.status, to } };
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
        evidence:        record.evidence.concat([{ to, at: new Date(now).toISOString(), ...(evidence.reason ? { reason: evidence.reason } : {}) }]),
      };
      await txn.put(KEY_OP + operationId, updated);

      // ── Reservation release on terminal transition ──────────────────────
      if (TERMINAL_STATES.has(to)) {
        const balRes = await txn.get(KEY_BALRES + record.scope);
        const reservedTotal = (balRes && balRes.total) || '0';
        const newTotal = subUint(reservedTotal, record.reservedAmount);
        await txn.put(KEY_BALRES + record.scope, { total: newTotal });

        // Settled (Circle actually debited) → decrement the snapshot conservatively
        // and mark stale so the next reserve requires a fresh balance sync.
        const settled = to === 'confirmed' || (to === 'failed' && record.status !== 'reserved' && record.status !== 'submitting');
        if (settled) {
          const snapshot = await txn.get(KEY_BAL + record.scope);
          if (snapshot && typeof snapshot.amount === 'string') {
            await txn.put(KEY_BAL + record.scope, {
              ...snapshot,
              amount: subUint(snapshot.amount, record.reservedAmount),
              stale:  true,
            });
          }
        }
      }

      return { status: 200, body: { ok: true, record: updated } };
    });

    return GatewayExecutionCoordinator.json(outcome.body, outcome.status);
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

      // Only unbind if the binding still points to THIS operation (idempotent +
      // protects against an old op unbinding a newer op that reused the slot).
      const idem = await txn.get(KEY_IDEM + record.idempotencyKey);
      if (idem && idem.operationId === operationId) {
        await txn.delete(KEY_IDEM + record.idempotencyKey);
      }
      const saltOp = await txn.get(KEY_SALT + record.salt);
      if (saltOp === operationId) {
        await txn.delete(KEY_SALT + record.salt);
      }

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
}
