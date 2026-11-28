/**
 * GatewayExecutionCoordinator — Durable Object for cross-salt Gateway financial
 * coordination.
 * ═══════════════════════════════════════════════════════════════════════════
 * Phase 1.0.1C (isolated development — NOT active in production).
 *
 * WHY THIS EXISTS
 *   GatewayOpLock keys by `idFromName(salt)` and therefore only deduplicates the
 *   SAME salt. Two concurrent submissions of the SAME financial intent with
 *   DIFFERENT salts each reserve cleanly and both forward — a cross-salt double
 *   submission. This DO coordinates by (depositor, environment) so a depositor
 *   cannot hold two conflicting in-flight intents in the same "payment slot",
 *   even when the salts differ.
 *
 * COORDINATOR SCOPE (sharding proof)
 *   One DO instance per `depositor:environment`. The idempotency key and payload
 *   hash are derived entirely from the burnIntent (see coordinator-util.js), so
 *   two conflicting submissions always reach the SAME DO instance and are
 *   serialized by the Cloudflare runtime.
 *
 *   GatewayOpLock REMAINS the per-salt authority. This DO is ADDITIVE: it adds a
 *   cross-salt dedup gate; it does not replace the salt lock, and it is not a
 *   parallel financial executor. Both gates must pass before a transfer forwards.
 *
 * STORAGE (durable, SQLite-backed on modern CF)
 *   op:<operationId>   → full operation record (see RECORD SHAPE)
 *   idem:<idemKey>     → { operationId, payloadHash }
 *   index:operations   → JSON array of operationId (audit + count cap)
 *
 * ATOMICITY
 *   Every read-modify-write runs inside `storage.transaction()` and every request
 *   runs inside `state.blockConcurrencyWhile()`, so the reserve/update/release
 *   check-then-write is atomic and race-free.
 *
 * INTERNAL AUTH
 *   Every request must carry `X-DO-Internal-Secret` matching env.DO_INTERNAL_SECRET
 *   (constant-time compare). Absent/wrong secret → 401. Never a public route.
 *
 * STATE MACHINE
 *   States: reserved | submitting | accepted | ambiguous | requires_review
 *         | confirmed | rejected | failed
 *
 *   reserved         reservation + signed intent persisted (nothing forwarded yet)
 *   submitting       forwarded to Circle (in-flight)
 *   accepted         Circle returned 2xx — attestation available (mint pending)
 *   ambiguous        Circle result unknown (timeout / 5xx / 429 / 408)
 *   requires_review  needs manual reconciliation (e.g. persistence failure after
 *                    response, contradictory evidence)
 *   confirmed        on-chain settlement verified          (TERMINAL)
 *   rejected         Circle definitively refused (4xx)     (TERMINAL)
 *   failed           verified failure / batch rollback     (TERMINAL)
 *
 *   Transitions:
 *     reserved        → submitting | rejected | failed(rollback only)
 *     submitting      → accepted | rejected | ambiguous
 *     accepted        → confirmed | failed | requires_review
 *     ambiguous       → accepted | rejected | confirmed | failed | requires_review
 *     requires_review → accepted | rejected | confirmed | failed
 *     confirmed/rejected/failed → (none)
 *
 *   A terminal transition may only be requested by the trusted caller (transfer.js),
 *   which performs the on-chain / Circle verification first. The DO additionally
 *   enforces monotonic versioning + fencing tokens and evidence requirements.
 *
 * ── Activation (Cloudflare Pages, isolated — like GATEWAY_OP_LOCK) ──────────
 *   1. Deploy a separate Worker exporting GatewayExecutionCoordinator from this
 *      file (wrangler.toml: durable_objects.bindings name = GATEWAY_EXECUTION_COORDINATOR,
 *      class_name = GatewayExecutionCoordinator, migrations tag = "v1").
 *   2. CF Dashboard → Pages → elligentt → Settings → Functions → DO bindings:
 *        Variable name: GATEWAY_EXECUTION_COORDINATOR
 *        Namespace:     (namespace from step 1)
 *   3. Set DO_INTERNAL_SECRET in Pages → Environment variables.
 *   4. Re-deploy the Pages project.
 *   The DO is INACTIVE in transfer.js unless BOTH the binding is present AND
 *   env.GATEWAY_EXECUTION_COORDINATOR_ENABLED === 'true'. When enabled but the DO
 *   is unavailable, transfer.js fails closed (503) — see transfer.js.
 */

import {
  canonicalPayloadHash,
  idempotencyKeyFor,
  depositorOf,
  environmentFor,
} from './coordinator-util.js';

const SCHEMA_VERSION = 1;

// ── State machine ────────────────────────────────────────────────────────────
const VALID_TRANSITIONS = {
  reserved:        ['submitting', 'accepted', 'rejected', 'ambiguous', 'failed'],
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

const KEY_OP    = 'op:';
const KEY_IDEM  = 'idem:';
const KEY_INDEX = 'index:operations';

// operationId is a UUID v4 (generated by transfer.js or here).
const OPERATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SALT_RE         = /^0x[0-9a-fA-F]{64}$/;
const DEPOSITOR_RE    = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE         = /^[0-9a-f]{64}$/i;

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function uuid() {
  // RFC4122 v4 — sufficient uniqueness for an operation id within a DO instance.
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
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
        if (method === 'POST'   && path === '/reserve') return this._reserve(request);
        if (method === 'POST'   && path === '/update')  return this._update(request);
        if (method === 'GET'    && path === '/status')  return this._status(url);
        if (method === 'DELETE' && path === '/release') return this._release(request);
        return GatewayExecutionCoordinator.json({ error: 'not_found' }, 404);
      });
    } catch (e) {
      return GatewayExecutionCoordinator.json({ error: 'internal_error', detail: (e && e.message) || 'unknown' }, 500);
    }
  }

  /* ── POST /reserve ────────────────────────────────────────────────────── */
  // Body: { burnIntent, operationId? }
  // The DO recomputes depositor/environment/idempotencyKey/payloadHash server-side
  // (single source of truth — never trusts a client-computed hash).
  //
  // Outcome:
  //   201 { reserved:true, record }                        — new operation
  //   200 { recovered:true, record }                       — duplicate (same slot+hash)
  //   409 { error:'conflict', record }                     — same slot, different hash
  //   400 { error:'...' }                                  — invalid input
  async _reserve(request) {
    let body;
    try { body = await request.json(); } catch (_) {
      return GatewayExecutionCoordinator.json({ error: 'invalid_json' }, 400);
    }

    const burnIntent = body && body.burnIntent;
    const v = this._validateBurnIntent(burnIntent);
    if (v) return GatewayExecutionCoordinator.json({ error: v }, 400);

    // Server-side canonical derivation (single source of truth).
    const depositor = depositorOf(burnIntent);
    const envName   = environmentFor(burnIntent);
    if (envName === null) {
      return GatewayExecutionCoordinator.json({
        error:  'unknown_environment',
        detail: 'sourceContract is not a recognized GatewayWallet (mainnet/testnet).',
      }, 400);
    }
    const idemKey     = await idempotencyKeyFor(burnIntent);
    const payloadHash = await canonicalPayloadHash(burnIntent);

    const operationId = (typeof body.operationId === 'string' && OPERATION_ID_RE.test(body.operationId))
      ? body.operationId
      : uuid();

    const spec    = burnIntent.spec;
    const salt    = spec.salt;
    const now     = new Date().toISOString();

    const outcome = await this.storage.transaction(async (txn) => {
      const existingIdem = await txn.get(KEY_IDEM + idemKey);
      if (existingIdem) {
        const existing = await txn.get(KEY_OP + existingIdem.operationId);
        if (existing) {
          // Terminal → allow a NEW operation in this slot (freed).
          if (TERMINAL_STATES.has(existing.status)) {
            // fall through to (re)create below
          } else if (existing.payloadHash === payloadHash) {
            return { status: 200, body: { recovered: true, record: existing } };
          } else {
            return {
              status: 409,
              body:   { error: 'conflict', detail: 'same_payment_slot_different_payload', record: existing },
            };
          }
        }
        // Index points to a missing record (corruption) — recreate below.
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
        value:          String(spec.value),
        maxFee:         burnIntent.maxFee != null ? String(burnIntent.maxFee) : null,
        salt,
        status:         'reserved',
        version:        1,
        createdAt:      now,
        updatedAt:      now,
        transferId:     null,
        expirationBlock: null,
        attestationHash: null,   // SHA-256 of attestation payload (NOT raw payload)
        signatureHash:  null,    // SHA-256 of operator signature (NOT raw signature)
        txHash:         null,
        evidence:       [],
      };

      await txn.put(KEY_OP + operationId, record);
      await txn.put(KEY_IDEM + idemKey, { operationId, payloadHash });

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
    if (spec.value == null || !/^\d{1,78}$/.test(String(spec.value))) return 'invalid_value';
    return null;
  }

  /* ── POST /update ─────────────────────────────────────────────────────── */
  // Body: { operationId, to, expectedVersion, evidence? }
  //   evidence: { transactionHash?, transferId?, expirationBlock?,
  //               attestationHash?, signatureHash?, reason? }
  //
  // Monotonic versioning + fencing: expectedVersion MUST equal record.version
  // (else 409 stale_version). Terminal transitions require evidence (see below).
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

      // Fencing: stale version is rejected outright.
      if (record.version !== expectedVersion) {
        return { status: 409, body: { error: 'stale_version', current: record.version, expected: expectedVersion } };
      }

      // Idempotent re-entry: already in the target state → current record.
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

      // Terminal transition evidence requirements:
      //   confirmed → must carry an on-chain settlement hash.
      //   requires_review → must carry a reason.
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
        txHash:          evidence.transactionHash || record.txHash          || null,
        evidence:        record.evidence.concat([{ to, at: new Date(now).toISOString(), ...(evidence.reason ? { reason: evidence.reason } : {}) }]),
      };
      await txn.put(KEY_OP + operationId, updated);
      return { status: 200, body: { ok: true, record: updated } };
    });

    return GatewayExecutionCoordinator.json(outcome.body, outcome.status);
  }

  /* ── GET /status?operationId= | idempotencyKey= ───────────────────────── */
  async _status(url) {
    const operationId = url.searchParams.get('operationId') || '';
    const idemKey     = url.searchParams.get('idempotencyKey') || '';

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
      return { status: 400, body: { error: 'operationId_or_idempotencyKey_required' } };
    });

    return GatewayExecutionCoordinator.json(outcome.body, outcome.status);
  }

  /* ── DELETE /release ──────────────────────────────────────────────────── */
  // Body: { operationId }. Only terminal operations may be released. Preserves the
  // audit trail up to release; the idem mapping is freed for a new operation.
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
      await txn.delete(KEY_OP + operationId);
      await txn.delete(KEY_IDEM + record.idempotencyKey);
      const index = (await txn.get(KEY_INDEX)) || [];
      await txn.put(KEY_INDEX, Array.isArray(index) ? index.filter((id) => id !== operationId) : []);
      return { status: 200, body: { ok: true, released: operationId } };
    });

    return GatewayExecutionCoordinator.json(outcome.body, outcome.status);
  }
}
