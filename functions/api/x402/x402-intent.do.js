/**
 * X402IntentStore — Durable Object for persistent x402 payment intents.
 * ═══════════════════════════════════════════════════════════════════════
 * Phase X402-2.1B — durable, replay-resistant financial intent foundation.
 *
 * COORDINATOR SCOPE (sharding proof):
 *   One DO instance per authenticated `userId`. Every intent belongs to exactly
 *   one user; the idempotency key is scoped to (user, wallet, requestDigest);
 *   and the EIP-3009 authorization-nonce namespace is (chainId, token, wallet,
 *   nonce) where `wallet → user` is a function. Therefore ALL operations that
 *   could conflict — same idempotency key, same nonce — reach the SAME DO and
 *   are serialized by the Cloudflare runtime. This avoids both an unbounded
 *   global singleton AND per-intent sharding (which would let two intents
 *   reserve the same nonce on different coordinators).
 *
 * STORAGE (durable, SQLite-backed on modern CF):
 *   intent:<intentId>    → full intent record (see INTENT_SHAPE)
 *   idem:<idempotencyKey>→ { intentId, requestDigest }
 *   nonce:<nonceKey>     → { intentId, reservedAt }
 *   index:intents        → JSON array of intentId (for alarm sweep + count cap)
 *
 * ATOMICITY:
 *   Every read-modify-write runs inside state.storage.transaction() so the
 *   get→check→put is a single atomic unit. fetch() and alarm() both wrap in
 *   state.blockConcurrencyWhile() so they cannot interleave.
 *
 * INTERNAL AUTH:
 *   Every request must carry the `X-DO-Internal-Secret` header matching
 *   env.DO_INTERNAL_SECRET (constant-time compare). Absent/wrong secret → 401.
 *   This DO is NEVER exposed as a public HTTP route.
 *
 * STATE MACHINE:
 *   Active (this phase): CREATED → PREPARED → AWAITING_AUTHORIZATION
 *                        (any active unsigned state → EXPIRED / CANCELLED)
 *   Reserved (future, NOT publicly callable): AUTHORIZED, SUBMITTING,
 *     SETTLEMENT_UNKNOWN, SETTLED, FAILED.
 *   Terminal: EXPIRED, CANCELLED, SETTLED, FAILED.
 *   SETTLED / FAILED / transactionHash may only ever be written by a future
 *   trusted reconciliation process — never by this phase's client surface.
 *
 * ── Activation (Cloudflare Pages, like GATEWAY_OP_LOCK / CPN_LOCK) ────────
 *   CF Pages cannot host DO classes inline. Required steps:
 *   1. Deploy a separate Worker that exports X402IntentStore from this file.
 *   2. CF Dashboard → Pages → elligentt → Settings → Functions → DO bindings:
 *        Variable name: X402_INTENT_LOCK
 *        Namespace:     (the namespace from step 1)
 *   3. Set DO_INTERNAL_SECRET in Pages → Environment variables.
 *   4. Re-deploy the Pages project.
 *   Until bound, the /api/x402/intent* routes fail closed (503) — see
 *   intent.js / intent-service.mjs.
 */

const SCHEMA_VERSION = 1;

const STATES = Object.freeze({
  CREATED:                 'CREATED',
  PREPARED:                'PREPARED',
  AWAITING_AUTHORIZATION:  'AWAITING_AUTHORIZATION',
  EXPIRED:                 'EXPIRED',
  CANCELLED:               'CANCELLED',
  // Reserved for future phases (signing / settlement). Not reachable here.
  AUTHORIZED:              'AUTHORIZED',
  SUBMITTING:              'SUBMITTING',
  SETTLEMENT_UNKNOWN:      'SETTLEMENT_UNKNOWN',
  SETTLED:                 'SETTLED',
  FAILED:                  'FAILED',
});

const TERMINAL_STATES = new Set(['EXPIRED', 'CANCELLED', 'SETTLED', 'FAILED']);

// Unsigned, still-mutable states. Only these may be expired (a future signed or
// submitted intent is NEVER auto-expired — see §10).
const ACTIVE_UNSIGNED = new Set(['CREATED', 'PREPARED', 'AWAITING_AUTHORIZATION']);

// Allowlisted transitions (source of truth). Future financial states have NO
// outgoing transitions here — they are reserved and unreachable in this phase.
const VALID_TRANSITIONS = Object.freeze({
  CREATED:                ['PREPARED', 'CANCELLED', 'EXPIRED'],
  PREPARED:               ['AWAITING_AUTHORIZATION', 'CANCELLED', 'EXPIRED'],
  AWAITING_AUTHORIZATION: ['CANCELLED', 'EXPIRED'],
  EXPIRED:                [],
  CANCELLED:              [],
  AUTHORIZED:             [],
  SUBMITTING:             [],
  SETTLEMENT_UNKNOWN:     [],
  SETTLED:                [],
  FAILED:                 [],
});

// States the service-layer may request via /transition. SETTLED / FAILED /
// AUTHORIZED / SUBMITTING / SETTLEMENT_UNKNOWN are deliberately absent — a
// client can never set financial-execution state.
const CLIENT_TRANSITION_TARGETS = new Set(['PREPARED', 'CANCELLED']);

const KEY_INTENT = 'intent:';
const KEY_IDEM   = 'idem:';
const KEY_NONCE  = 'nonce:';
const KEY_INDEX  = 'index:intents';

// Nonce is an EIP-3009 authorization identifier (uint256). Canonical form is a
// decimal string of at most 78 digits (2^256 ≈ 1.15e77).
const NONCE_RE = /^\d{1,78}$/;
// Intent id is a UUID v4 string.
const INTENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Idempotency key: printable, no whitespace/control chars, bounded length.
const IDEM_KEY_RE = /^[A-Za-z0-9._-]{8,128}$/;
// Atomic amount is a canonical positive unsigned integer string (see _x402.mjs).
const AMOUNT_RE = /^\d{1,78}$/;
// Digest / fingerprint: 64 hex chars (SHA-256).
const DIGEST_RE = /^[0-9a-f]{64}$/i;

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function iso(ms) { return new Date(ms).toISOString(); }

export class X402IntentStore {
  constructor(state, env) {
    this.state   = state;
    this.storage = state.storage;
    this.env     = env || {};
  }

  /* ── Response helpers ──────────────────────────────────────────────── */
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

  /* ── Route entry ───────────────────────────────────────────────────── */
  async fetch(request) {
    if (!this._authorized(request)) {
      return X402IntentStore.json({ error: 'unauthorized' }, 401);
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, ''); // e.g. /create | /intent | /transition | /reserve-nonce

    try {
      return await this.state.blockConcurrencyWhile(async () => {
        if (request.method === 'POST' && path === '/create') {
          return this._create(request);
        }
        if (request.method === 'GET' && path === '/intent') {
          return this._get(url);
        }
        if (request.method === 'POST' && path === '/transition') {
          return this._transition(request);
        }
        if (request.method === 'POST' && path === '/reserve-nonce') {
          return this._reserveNonce(request);
        }
        return X402IntentStore.json({ error: 'not_found' }, 404);
      });
    } catch (e) {
      return X402IntentStore.json({ error: 'internal_error', detail: (e && e.message) || 'unknown' }, 500);
    }
  }

  /* ── POST /create ──────────────────────────────────────────────────── */
  async _create(request) {
    let body;
    try { body = await request.json(); } catch (_) {
      return X402IntentStore.json({ error: 'invalid_json' }, 400);
    }
    const intent = body && body.intent;
    const requestDigest = body && body.requestDigest;

    if (!intent || typeof intent !== 'object') {
      return X402IntentStore.json({ error: 'intent_required' }, 400);
    }
    if (typeof requestDigest !== 'string' || !DIGEST_RE.test(requestDigest)) {
      return X402IntentStore.json({ error: 'invalid_request_digest' }, 400);
    }

    // Defense-in-depth validation of the canonical record (the trusted service
    // already validated; this guards against a misbehaving caller / corruption).
    const verr = this._validateNewIntent(intent);
    if (verr) return X402IntentStore.json({ error: verr }, 400);

    const idemKey = intent.idempotencyKey;
    const intentKey = KEY_INTENT + intent.intentId;

    const outcome = await this.storage.transaction(async (txn) => {
      const existingIdem = await txn.get(KEY_IDEM + idemKey);
      if (existingIdem) {
        if (existingIdem.requestDigest === requestDigest) {
          const existing = await txn.get(KEY_INTENT + existingIdem.intentId);
          if (existing) {
            return { status: 200, body: { ok: true, created: false, idempotent: true, intent: existing } };
          }
          // Index points to a missing record (corruption) — fall through to recreate.
        }
        // Same key, different payload → hard conflict (never silently replace).
        return { status: 409, body: { ok: false, error: 'idempotency_conflict', existingIntentId: existingIdem.intentId } };
      }

      if (await txn.get(intentKey)) {
        return { status: 409, body: { ok: false, error: 'intent_id_collision' } };
      }

      // Bound stored records per user (record-count limit; no auto-deletion).
      const index = (await txn.get(KEY_INDEX)) || [];
      const maxPerUser = Number(this.env && this.env.X402_INTENT_MAX_PER_USER) || 200;
      if (!Array.isArray(index) || index.length >= maxPerUser) {
        return { status: 429, body: { ok: false, error: 'too_many_intents' } };
      }

      await txn.put(intentKey, intent);
      await txn.put(KEY_IDEM + idemKey, { intentId: intent.intentId, requestDigest });
      await txn.put(KEY_INDEX, index.concat([intent.intentId]));
      return { status: 201, body: { ok: true, created: true, intent } };
    });

    // Re-arm the alarm to the earliest expiry (alarm bookkeeping is outside txn).
    if (outcome.status === 201) {
      const expiresMs = Date.parse(intent.expiresAt);
      if (Number.isFinite(expiresMs)) {
        const current = await this.storage.getAlarm();
        if (current === null || expiresMs < current) {
          await this.storage.setAlarm(expiresMs);
        }
      }
    }

    return X402IntentStore.json(outcome.body, outcome.status);
  }

  _validateNewIntent(intent) {
    if (intent.schemaVersion !== SCHEMA_VERSION) return 'unknown_schema_version';
    if (typeof intent.intentId !== 'string' || !INTENT_ID_RE.test(intent.intentId)) return 'invalid_intent_id';
    if (intent.state !== STATES.CREATED) return 'invalid_initial_state';
    if (typeof intent.idempotencyKey !== 'string' || !IDEM_KEY_RE.test(intent.idempotencyKey)) return 'invalid_idempotency_key';
    if (typeof intent.amountAtomic !== 'string' || !AMOUNT_RE.test(intent.amountAtomic) || intent.amountAtomic === '0') return 'invalid_amount';
    if (typeof intent.requirementDigest !== 'string' || !DIGEST_RE.test(intent.requirementDigest)) return 'invalid_requirement_digest';
    if (typeof intent.resourceFingerprint !== 'string' || !DIGEST_RE.test(intent.resourceFingerprint)) return 'invalid_resource_fingerprint';
    if (typeof intent.walletAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(intent.walletAddress)) return 'invalid_wallet';
    if (typeof intent.payTo !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(intent.payTo)) return 'invalid_payto';
    if (typeof intent.assetAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(intent.assetAddress)) return 'invalid_asset';
    if (!Number.isInteger(intent.chainId) || intent.chainId <= 0) return 'invalid_chain';
    if (!Number.isInteger(intent.tokenDecimals) || intent.tokenDecimals < 0 || intent.tokenDecimals > 77) return 'invalid_decimals';
    if (!Number.isInteger(intent.maxTimeoutSeconds) || intent.maxTimeoutSeconds <= 0) return 'invalid_timeout';
    if (typeof intent.expiresAt !== 'string' || !Number.isFinite(Date.parse(intent.expiresAt))) return 'invalid_expiry';
    // Future financial fields must be inactive (null) at creation time.
    if (intent.transactionHash !== null || intent.settlementStatus !== null) return 'invalid_terminal_fields';
    return null;
  }

  /* ── GET /intent?id= ───────────────────────────────────────────────── */
  async _get(url) {
    const intentId = url.searchParams.get('id') || '';
    if (!INTENT_ID_RE.test(intentId)) {
      return X402IntentStore.json({ error: 'invalid_intent_id' }, 400);
    }
    const outcome = await this.storage.transaction(async (txn) => {
      const intent = await txn.get(KEY_INTENT + intentId);
      if (!intent) return { status: 404, body: { ok: false, error: 'not_found' } };
      // Lazy expiration: expired, unsigned intents become EXPIRED on read.
      const expired = this._maybeExpire(txn, intent);
      return { status: 200, body: { ok: true, intent: expired || intent } };
    });
    return X402IntentStore.json(outcome.body, outcome.status);
  }

  /* ── POST /transition ──────────────────────────────────────────────── */
  async _transition(request) {
    let body;
    try { body = await request.json(); } catch (_) {
      return X402IntentStore.json({ error: 'invalid_json' }, 400);
    }
    const { intentId, to, expectedVersion } = body || {};
    if (!INTENT_ID_RE.test(String(intentId || ''))) return X402IntentStore.json({ error: 'invalid_intent_id' }, 400);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) return X402IntentStore.json({ error: 'invalid_version' }, 400);
    if (typeof to !== 'string' || !CLIENT_TRANSITION_TARGETS.has(to)) {
      return X402IntentStore.json({ error: 'forbidden_transition', to: to || null }, 403);
    }

    const outcome = await this.storage.transaction(async (txn) => {
      const intent = await txn.get(KEY_INTENT + intentId);
      if (!intent) return { status: 404, body: { ok: false, error: 'not_found' } };

      // Expiry check first: an expired unsigned intent can no longer transition.
      const expiredNow = this._maybeExpire(txn, intent);
      if (expiredNow) {
        return { status: 409, body: { ok: false, error: 'intent_expired', intent: expiredNow } };
      }

      if (intent.state === to) {
        // Idempotent: already in the target state → return current record.
        return { status: 200, body: { ok: true, idempotent: true, intent } };
      }

      const allowed = VALID_TRANSITIONS[intent.state] || [];
      if (!allowed.includes(to)) {
        return { status: 400, body: { ok: false, error: 'invalid_transition', from: intent.state, to, allowed } };
      }

      if (intent.stateVersion !== expectedVersion) {
        return { status: 409, body: { ok: false, error: 'stale_version', current: intent.stateVersion, expected: expectedVersion } };
      }

      const now = Date.now();
      const updated = {
        ...intent,
        state: to,
        stateVersion: intent.stateVersion + 1,
        updatedAt: iso(now),
      };
      await txn.put(KEY_INTENT + intentId, updated);
      return { status: 200, body: { ok: true, intent: updated } };
    });

    // If the intent reached a terminal state, clear the alarm if nothing else is
    // pending is handled by the alarm itself on next fire (idempotent no-op).
    return X402IntentStore.json(outcome.body, outcome.status);
  }

  /* ── POST /reserve-nonce ───────────────────────────────────────────── */
  async _reserveNonce(request) {
    let body;
    try { body = await request.json(); } catch (_) {
      return X402IntentStore.json({ error: 'invalid_json' }, 400);
    }
    const { intentId, nonce, expectedVersion } = body || {};
    if (!INTENT_ID_RE.test(String(intentId || ''))) return X402IntentStore.json({ error: 'invalid_intent_id' }, 400);
    if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return X402IntentStore.json({ error: 'invalid_nonce' }, 400);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) return X402IntentStore.json({ error: 'invalid_version' }, 400);

    const outcome = await this.storage.transaction(async (txn) => {
      const intent = await txn.get(KEY_INTENT + intentId);
      if (!intent) return { status: 404, body: { ok: false, error: 'not_found' } };

      const expiredNow = this._maybeExpire(txn, intent);
      if (expiredNow) return { status: 409, body: { ok: false, error: 'intent_expired', intent: expiredNow } };

      // Idempotent: same intent already reserved this nonce.
      if (intent.state === STATES.AWAITING_AUTHORIZATION && intent.authorizationNonce === nonce) {
        return { status: 200, body: { ok: true, idempotent: true, intent } };
      }

      const allowed = VALID_TRANSITIONS[intent.state] || [];
      if (!allowed.includes(STATES.AWAITING_AUTHORIZATION)) {
        return { status: 400, body: { ok: false, error: 'invalid_transition', from: intent.state, to: STATES.AWAITING_AUTHORIZATION, allowed } };
      }
      if (intent.stateVersion !== expectedVersion) {
        return { status: 409, body: { ok: false, error: 'stale_version', current: intent.stateVersion, expected: expectedVersion } };
      }

      // Authoritative nonce namespace: (chainId, token, wallet, nonce).
      const nonceKey = [String(intent.chainId), intent.assetAddress.toLowerCase(), intent.walletAddress.toLowerCase(), nonce].join(':');
      const existingNonce = await txn.get(KEY_NONCE + nonceKey);
      if (existingNonce) {
        if (existingNonce.intentId === intentId) {
          return { status: 200, body: { ok: true, idempotent: true, intent } };
        }
        return { status: 409, body: { ok: false, error: 'nonce_already_reserved', ownerIntentId: existingNonce.intentId } };
      }

      const now = Date.now();
      await txn.put(KEY_NONCE + nonceKey, { intentId, reservedAt: iso(now) });
      const updated = {
        ...intent,
        state: STATES.AWAITING_AUTHORIZATION,
        authorizationNonce: nonce,
        stateVersion: intent.stateVersion + 1,
        updatedAt: iso(now),
      };
      await txn.put(KEY_INTENT + intentId, updated);
      return { status: 200, body: { ok: true, intent: updated } };
    });

    return X402IntentStore.json(outcome.body, outcome.status);
  }

  /* ── Lazy / alarm expiration ───────────────────────────────────────── */
  // Mutates intent in-place conceptually but returns the UPDATED record (or null
  // when no expiry applies). MUST be called inside a storage transaction.
  _maybeExpire(txn, intent) {
    if (!ACTIVE_UNSIGNED.has(intent.state)) return null;
    const expiresMs = Date.parse(intent.expiresAt);
    if (!Number.isFinite(expiresMs) || Date.now() < expiresMs) return null;
    const updated = {
      ...intent,
      state: STATES.EXPIRED,
      stateVersion: intent.stateVersion + 1,
      updatedAt: iso(Date.now()),
    };
    // Note: nonce reservations are intentionally NOT released on expiry (§8).
    return updated;
  }

  // Idempotent sweep: transition every expired, unsigned intent → EXPIRED and
  // re-arm for the next earliest expiry. Retains all records (no deletion).
  async alarm() {
    await this.state.blockConcurrencyWhile(async () => {
      const sweep = await this.storage.transaction(async (txn) => {
        const index = (await txn.get(KEY_INDEX)) || [];
        const now = Date.now();
        let nextExpiry = null;
        if (!Array.isArray(index)) return { nextExpiry: null };

        for (const intentId of index) {
          const intent = await txn.get(KEY_INTENT + intentId);
          if (!intent) continue;
          if (ACTIVE_UNSIGNED.has(intent.state)) {
            const expiresMs = Date.parse(intent.expiresAt);
            if (!Number.isFinite(expiresMs)) continue;
            if (now >= expiresMs) {
              const updated = {
                ...intent,
                state: STATES.EXPIRED,
                stateVersion: intent.stateVersion + 1,
                updatedAt: iso(now),
              };
              await txn.put(KEY_INTENT + intentId, updated);
            } else if (nextExpiry === null || expiresMs < nextExpiry) {
              nextExpiry = expiresMs;
            }
          }
        }
        return { nextExpiry };
      });

      if (sweep.nextExpiry === null) {
        await this.storage.deleteAlarm();
      } else {
        await this.storage.setAlarm(sweep.nextExpiry);
      }
    });
  }
}
