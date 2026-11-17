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

// Settlement-attempt states (kept SEPARATE from the intent state machine so the
// signed intent is never mutated by settlement tracking). Mirrors the pure model
// in x402-settlement.mjs (the DO is self-contained for standalone Worker deploy).
const SETTLEMENT_STATES = Object.freeze({
  SETTLEMENT_READY:   'SETTLEMENT_READY',
  SUBMITTING:         'SUBMITTING',
  SETTLEMENT_UNKNOWN: 'SETTLEMENT_UNKNOWN',
  SETTLED:            'SETTLED',
  FAILED:             'FAILED',
});
const SETTLEMENT_TRANSITIONS = Object.freeze({
  SETTLEMENT_READY:   ['SUBMITTING'],
  SUBMITTING:         ['SETTLEMENT_UNKNOWN', 'SETTLED', 'FAILED'],
  SETTLEMENT_UNKNOWN: ['SETTLED', 'FAILED'],
  SETTLED:            [],
  FAILED:             [],
});

async function _settlementFingerprint(intent) {
  const canon = JSON.stringify([
    String(intent.chainId),
    String(intent.assetAddress).toLowerCase(),
    String(intent.walletAddress).toLowerCase(),
    String(intent.amountAtomic),
    String(intent.payTo).toLowerCase(),
    String(intent.authorizationValidAfter),
    String(intent.authorizationValidBefore),
    String(intent.authorizationNonce).toLowerCase(),
    String(intent.authorizationSignature),
  ]);
  const data = new TextEncoder().encode(canon);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function _settlementNonceKey(intent) {
  return [
    String(intent.chainId),
    String(intent.assetAddress).toLowerCase(),
    String(intent.walletAddress).toLowerCase(),
    String(intent.authorizationNonce).toLowerCase(),
  ].join(':');
}

function _validateSettlementTransition(from, to, evidence) {
  if (!SETTLEMENT_STATES[to]) return { ok: false, reason: 'unknown_state' };
  const allowed = SETTLEMENT_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) return { ok: false, reason: 'invalid_transition', from, to, allowed };
  if (to === SETTLEMENT_STATES.SETTLED) {
    const hasTx = !!(evidence && evidence.transactionHash);
    const hasRef = !!(evidence && evidence.providerReference && evidence.finality === 'confirmed');
    if (!hasTx && !hasRef) return { ok: false, reason: 'settled_requires_evidence' };
  }
  if (to === SETTLEMENT_STATES.FAILED) {
    if (!(evidence && evidence.classification === 'definitive_rejection')) {
      return { ok: false, reason: 'failed_requires_definitive_rejection' };
    }
  }
  return { ok: true };
}

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

// Allowlisted transitions (source of truth). AUTHORIZED is reachable ONLY via the
// trusted internal /authorize action (signature-verified). SETTLED / FAILED /
// SUBMITTING / SETTLEMENT_UNKNOWN remain reserved and unreachable in this phase.
const VALID_TRANSITIONS = Object.freeze({
  CREATED:                ['PREPARED', 'CANCELLED', 'EXPIRED'],
  PREPARED:               ['AWAITING_AUTHORIZATION', 'CANCELLED', 'EXPIRED'],
  AWAITING_AUTHORIZATION: ['AUTHORIZED', 'CANCELLED', 'EXPIRED'],
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
const KEY_SETTLEMENT = 'settlement:';
const KEY_CLAIM  = 'claim:';
const KEY_SETTLEMENT_IDEM = 'settlement-idem:';
const KEY_APPROVAL = 'approval:';
const KEY_APPROVAL_REVOKED = 'approval-revoked:';

// EIP-3009 authorization nonce is a `bytes32`. Canonical form is lowercase hex
// `0x` + exactly 64 hex characters (no sign, no decimal, no truncation).
const NONCE_RE = /^0x[0-9a-fA-F]{64}$/;
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
    const path = url.pathname.replace(/\/+$/, ''); // e.g. /create | /intent | /transition | /reserve-nonce | /authorize

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
        if (request.method === 'POST' && path === '/authorize') {
          return this._authorize(request);
        }
        if (request.method === 'POST' && path === '/record-verification') {
          return this._recordVerification(request);
        }
        if (request.method === 'POST' && path === '/claim-settlement') {
          return this._claimSettlement(request);
        }
        if (request.method === 'POST' && path === '/settlement-transition') {
          return this._settlementTransition(request);
        }
        if (request.method === 'POST' && path === '/settlement-evidence') {
          return this._settlementEvidence(request);
        }
        if (request.method === 'POST' && path === '/consume-approval') {
          return this._consumeApproval(request);
        }
        if (request.method === 'POST' && path === '/revoke-approval') {
          return this._revokeApproval(request);
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
    if (intent.authorizationSignature !== null) return 'invalid_terminal_fields';
    if (intent.facilitatorVerification !== null) return 'invalid_terminal_fields';
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
    const canonicalNonce = nonce.toLowerCase(); // normalize casing (bytes32 hex)

    const outcome = await this.storage.transaction(async (txn) => {
      const intent = await txn.get(KEY_INTENT + intentId);
      if (!intent) return { status: 404, body: { ok: false, error: 'not_found' } };

      const expiredNow = this._maybeExpire(txn, intent);
      if (expiredNow) return { status: 409, body: { ok: false, error: 'intent_expired', intent: expiredNow } };

      // Idempotent: same intent already reserved this nonce.
      if (intent.state === STATES.AWAITING_AUTHORIZATION && intent.authorizationNonce === canonicalNonce) {
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
      const nonceKey = [String(intent.chainId), intent.assetAddress.toLowerCase(), intent.walletAddress.toLowerCase(), canonicalNonce].join(':');
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
        authorizationNonce: canonicalNonce,
        stateVersion: intent.stateVersion + 1,
        updatedAt: iso(now),
      };
      await txn.put(KEY_INTENT + intentId, updated);
      return { status: 200, body: { ok: true, intent: updated } };
    });

    return X402IntentStore.json(outcome.body, outcome.status);
  }

  /* ── POST /authorize (trusted internal — signature-verified) ────────── */
  // Only the trusted service (DO_INTERNAL_SECRET) may call this. It persists an
  // already-locally-verified EIP-712 authorization and atomically transitions
  // AWAITING_AUTHORIZATION → AUTHORIZED, re-binding the signed terms to the
  // persisted intent. No client can set AUTHORIZED.
  async _authorize(request) {
    let body;
    try { body = await request.json(); } catch (_) {
      return X402IntentStore.json({ error: 'invalid_json' }, 400);
    }
    const { intentId, expectedVersion, authorization } = body || {};
    if (!INTENT_ID_RE.test(String(intentId || ''))) return X402IntentStore.json({ error: 'invalid_intent_id' }, 400);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) return X402IntentStore.json({ error: 'invalid_version' }, 400);
    if (!authorization || typeof authorization !== 'object') return X402IntentStore.json({ error: 'authorization_required' }, 400);

    const sig = authorization.signature;
    const nonce = authorization.nonce;
    const validAfter = authorization.validAfter;
    const validBefore = authorization.validBefore;
    // 65-byte EIP-712 signature (r||s||v) = 130 hex chars.
    if (typeof sig !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(sig)) return X402IntentStore.json({ error: 'invalid_signature' }, 400);
    if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return X402IntentStore.json({ error: 'invalid_nonce' }, 400);
    if (typeof validAfter !== 'string' || !/^\d{1,78}$/.test(validAfter)) return X402IntentStore.json({ error: 'invalid_valid_after' }, 400);
    if (typeof validBefore !== 'string' || !/^\d{1,78}$/.test(validBefore)) return X402IntentStore.json({ error: 'invalid_valid_before' }, 400);

    const outcome = await this.storage.transaction(async (txn) => {
      const intent = await txn.get(KEY_INTENT + intentId);
      if (!intent) return { status: 404, body: { ok: false, error: 'not_found' } };

      const expiredNow = this._maybeExpire(txn, intent);
      if (expiredNow) return { status: 409, body: { ok: false, error: 'intent_expired', intent: expiredNow } };

      // Idempotent re-entry: already authorized with the identical signature.
      if (intent.state === STATES.AUTHORIZED && intent.authorizationSignature === sig) {
        return { status: 200, body: { ok: true, idempotent: true, intent } };
      }

      const allowed = VALID_TRANSITIONS[intent.state] || [];
      if (!allowed.includes(STATES.AUTHORIZED)) {
        return { status: 400, body: { ok: false, error: 'invalid_transition', from: intent.state, to: STATES.AUTHORIZED, allowed } };
      }
      if (intent.stateVersion !== expectedVersion) {
        return { status: 409, body: { ok: false, error: 'stale_version', current: intent.stateVersion, expected: expectedVersion } };
      }

      // Binding: signed terms MUST equal the persisted intent (immutable terms).
      const canonNonce = nonce.toLowerCase();
      if (intent.authorizationNonce !== canonNonce) {
        return { status: 409, body: { ok: false, error: 'nonce_mismatch' } };
      }
      if (String(intent.amountAtomic) !== String(authorization.value)) {
        return { status: 409, body: { ok: false, error: 'amount_mismatch' } };
      }
      if (String(intent.payTo).toLowerCase() !== String(authorization.to).toLowerCase()) {
        return { status: 409, body: { ok: false, error: 'payto_mismatch' } };
      }
      if (String(intent.walletAddress).toLowerCase() !== String(authorization.from).toLowerCase()) {
        return { status: 409, body: { ok: false, error: 'from_mismatch' } };
      }

      // Validity-window sanity (server clock; no silent conversion).
      let va, vb;
      try { va = BigInt(validAfter); vb = BigInt(validBefore); } catch (_) {
        return { status: 400, body: { ok: false, error: 'invalid_validity_window' } };
      }
      if (va > vb) return { status: 400, body: { ok: false, error: 'invalid_validity_window' } };
      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      if (vb < nowSec) return { status: 400, body: { ok: false, error: 'authorization_expired' } };

      const now = Date.now();
      const updated = {
        ...intent,
        state: STATES.AUTHORIZED,
        stateVersion: intent.stateVersion + 1,
        updatedAt: iso(now),
        authorizedAt: iso(now),
        authorizationNonce: canonNonce,
        authorizationSignature: sig,
        authorizationValidAfter: validAfter,
        authorizationValidBefore: validBefore,
      };
      await txn.put(KEY_INTENT + intentId, updated);
      return { status: 200, body: { ok: true, intent: updated } };
    });

    return X402IntentStore.json(outcome.body, outcome.status);
  }

  /* ── POST /record-verification (trusted internal) ───────────────────── */
  // Records NON-destructive facilitator verification evidence on an AUTHORIZED
  // intent. Does NOT change the core state or stateVersion (verification is a
  // read-only observation, not a state transition); uses expectedVersion as an
  // optimistic guard against stale writes. Idempotent for identical results.
  async _recordVerification(request) {
    let body;
    try { body = await request.json(); } catch (_) {
      return X402IntentStore.json({ error: 'invalid_json' }, 400);
    }
    const { intentId, expectedVersion, verification } = body || {};
    if (!INTENT_ID_RE.test(String(intentId || ''))) return X402IntentStore.json({ error: 'invalid_intent_id' }, 400);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) return X402IntentStore.json({ error: 'invalid_version' }, 400);
    if (!verification || typeof verification !== 'object') return X402IntentStore.json({ error: 'verification_required' }, 400);
    const status = verification.status;
    if (!['verified', 'rejected', 'unknown'].includes(status)) return X402IntentStore.json({ error: 'invalid_verification_status' }, 400);
    if (typeof verification.isValid !== 'boolean') return X402IntentStore.json({ error: 'invalid_verification' }, 400);
    const checkedAt = typeof verification.checkedAt === 'string' ? verification.checkedAt : iso(Date.now());

    const outcome = await this.storage.transaction(async (txn) => {
      const intent = await txn.get(KEY_INTENT + intentId);
      if (!intent) return { status: 404, body: { ok: false, error: 'not_found' } };
      if (intent.state !== STATES.AUTHORIZED) {
        return { status: 409, body: { ok: false, error: 'not_authorized', state: intent.state } };
      }
      if (intent.stateVersion !== expectedVersion) {
        return { status: 409, body: { ok: false, error: 'stale_version', current: intent.stateVersion, expected: expectedVersion } };
      }
      // Idempotent: identical status + checkedAt → current record.
      if (intent.facilitatorVerification &&
          intent.facilitatorVerification.status === status &&
          intent.facilitatorVerification.checkedAt === checkedAt) {
        return { status: 200, body: { ok: true, idempotent: true, intent } };
      }
      const now = Date.now();
      // Bind the verification record to the exact authorization it evaluated.
      const fingerprint = await _settlementFingerprint(intent);
      const updated = {
        ...intent,
        facilitatorVerification: {
          status,
          isValid: verification.isValid,
          invalidReason: verification.invalidReason || null,
          checkedAt,
          authorizationFingerprint: fingerprint,
          intentVersion: intent.stateVersion,
        },
        updatedAt: iso(now),
      };
      await txn.put(KEY_INTENT + intentId, updated);
      return { status: 200, body: { ok: true, intent: updated } };
    });

    return X402IntentStore.json(outcome.body, outcome.status);
  }

  /* ── Settlement-attempt ledger (PREPARATION ONLY — no provider submission) ── */

  // Atomic settlement claim: exactly one active claim per authorization. The
  // fingerprint is derived from the persisted intent (never client input). The
  // idempotency key gives the caller a safe retry handle.
  async _claimSettlement(request) {
    let body;
    try { body = await request.json(); } catch (_) { return X402IntentStore.json({ error: 'invalid_json' }, 400); }
    const { intentId, expectedVersion, idempotencyKey, settlementAttemptId } = body || {};
    if (!INTENT_ID_RE.test(String(intentId || ''))) return X402IntentStore.json({ error: 'invalid_intent_id' }, 400);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) return X402IntentStore.json({ error: 'invalid_version' }, 400);
    if (typeof idempotencyKey !== 'string' || !IDEM_KEY_RE.test(idempotencyKey)) return X402IntentStore.json({ error: 'invalid_idempotency_key' }, 400);
    if (!INTENT_ID_RE.test(String(settlementAttemptId || ''))) return X402IntentStore.json({ error: 'invalid_attempt_id' }, 400);

    const intent = await this.storage.get(KEY_INTENT + intentId);
    if (!intent) return X402IntentStore.json({ error: 'not_found' }, 404);
    if (intent.state !== STATES.AUTHORIZED) {
      return X402IntentStore.json({ error: 'not_authorized', state: intent.state }, 409);
    }
    if (intent.stateVersion !== expectedVersion) {
      return X402IntentStore.json({ error: 'stale_version', current: intent.stateVersion, expected: expectedVersion }, 409);
    }

    const fingerprint = await _settlementFingerprint(intent);
    const nonceKey = _settlementNonceKey(intent);

    const outcome = await this.storage.transaction(async (txn) => {
      // Caller idempotency: same key → same attempt.
      const idem = await txn.get(KEY_SETTLEMENT_IDEM + idempotencyKey);
      if (idem) {
        const existing = await txn.get(KEY_SETTLEMENT + idem.settlementAttemptId);
        return { status: 200, body: { ok: true, claimed: false, idempotent: true, attempt: existing || null } };
      }
      // Authoritative claim: one active claim per authorization.
      const existingClaim = await txn.get(KEY_CLAIM + nonceKey);
      if (existingClaim) {
        if (existingClaim.authorizationFingerprint === fingerprint) {
          const existing = await txn.get(KEY_SETTLEMENT + existingClaim.settlementAttemptId);
          return { status: 200, body: { ok: true, claimed: false, idempotent: true, attempt: existing || null } };
        }
        return { status: 409, body: { ok: false, error: 'claim_conflict' } };
      }

      const now = new Date().toISOString();
      const attempt = {
        schemaVersion: 1,
        settlementAttemptId,
        intentId: intent.intentId,
        userId: intent.userId,
        walletAddress: intent.walletAddress,
        authorizationFingerprint: fingerprint,
        nonceKey,
        chainId: intent.chainId,
        tokenAddress: intent.assetAddress,
        amountAtomic: intent.amountAtomic,
        payTo: intent.payTo,
        state: SETTLEMENT_STATES.SETTLEMENT_READY,
        stateVersion: 1,
        idempotencyKey,
        providerReference: null,
        transactionHash: null,
        createdAt: now,
        updatedAt: now,
        evidence: [],
      };
      await txn.put(KEY_SETTLEMENT + settlementAttemptId, attempt);
      await txn.put(KEY_CLAIM + nonceKey, { settlementAttemptId, authorizationFingerprint: fingerprint, claimedAt: iso(Date.now()) });
      await txn.put(KEY_SETTLEMENT_IDEM + idempotencyKey, { settlementAttemptId });
      return { status: 201, body: { ok: true, claimed: true, attempt } };
    });

    return X402IntentStore.json(outcome.body, outcome.status);
  }

  // Trusted internal settlement transition. SETTLED/FAILED require evidence.
  async _settlementTransition(request) {
    let body;
    try { body = await request.json(); } catch (_) { return X402IntentStore.json({ error: 'invalid_json' }, 400); }
    const { attemptId, to, expectedVersion, evidence } = body || {};
    if (!INTENT_ID_RE.test(String(attemptId || ''))) return X402IntentStore.json({ error: 'invalid_attempt_id' }, 400);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) return X402IntentStore.json({ error: 'invalid_version' }, 400);
    if (typeof to !== 'string' || !SETTLEMENT_STATES[to]) return X402IntentStore.json({ error: 'unknown_state' }, 400);
    if (evidence != null && typeof evidence !== 'object') return X402IntentStore.json({ error: 'invalid_evidence' }, 400);

    const outcome = await this.storage.transaction(async (txn) => {
      const attempt = await txn.get(KEY_SETTLEMENT + attemptId);
      if (!attempt) return { status: 404, body: { ok: false, error: 'not_found' } };
      if (attempt.stateVersion !== expectedVersion) {
        return { status: 409, body: { ok: false, error: 'stale_version', current: attempt.stateVersion, expected: expectedVersion } };
      }
      if (attempt.state === to) return { status: 200, body: { ok: true, idempotent: true, attempt } };

      const v = _validateSettlementTransition(attempt.state, to, evidence || {});
      if (!v.ok) {
        return { status: 400, body: { ok: false, error: v.reason, from: attempt.state, to, allowed: SETTLEMENT_TRANSITIONS[attempt.state] || [] } };
      }

      const now = Date.now();
      const evidenceEntry = evidence ? { ...evidence, at: iso(now) } : null;
      const updated = {
        ...attempt,
        state: to,
        stateVersion: attempt.stateVersion + 1,
        updatedAt: iso(now),
        providerReference: (evidence && evidence.providerReference) || attempt.providerReference || null,
        transactionHash: (evidence && evidence.transactionHash) || attempt.transactionHash || null,
        evidence: evidenceEntry ? attempt.evidence.concat([evidenceEntry]) : attempt.evidence,
      };
      await txn.put(KEY_SETTLEMENT + attemptId, updated);
      return { status: 200, body: { ok: true, attempt: updated } };
    });

    return X402IntentStore.json(outcome.body, outcome.status);
  }

  // Append settlement evidence (trusted internal). Contradictory terminal
  // evidence is rejected rather than silently overwritten.
  async _settlementEvidence(request) {
    let body;
    try { body = await request.json(); } catch (_) { return X402IntentStore.json({ error: 'invalid_json' }, 400); }
    const { attemptId, expectedVersion, evidence } = body || {};
    if (!INTENT_ID_RE.test(String(attemptId || ''))) return X402IntentStore.json({ error: 'invalid_attempt_id' }, 400);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) return X402IntentStore.json({ error: 'invalid_version' }, 400);
    if (!evidence || typeof evidence !== 'object') return X402IntentStore.json({ error: 'evidence_required' }, 400);

    const outcome = await this.storage.transaction(async (txn) => {
      const attempt = await txn.get(KEY_SETTLEMENT + attemptId);
      if (!attempt) return { status: 404, body: { ok: false, error: 'not_found' } };
      if (attempt.stateVersion !== expectedVersion) {
        return { status: 409, body: { ok: false, error: 'stale_version', current: attempt.stateVersion, expected: expectedVersion } };
      }
      // Contradictory evidence: a new transactionHash that differs from a
      // previously recorded one must not silently replace it.
      if (evidence.transactionHash && attempt.transactionHash &&
          String(evidence.transactionHash).toLowerCase() !== String(attempt.transactionHash).toLowerCase()) {
        return { status: 409, body: { ok: false, error: 'contradictory_evidence' } };
      }
      const now = Date.now();
      const updated = {
        ...attempt,
        evidence: attempt.evidence.concat([{ ...evidence, at: iso(now) }]),
        updatedAt: iso(now),
      };
      await txn.put(KEY_SETTLEMENT + attemptId, updated);
      return { status: 200, body: { ok: true, attempt: updated } };
    });

    return X402IntentStore.json(outcome.body, outcome.status);
  }

  /* ── Durable operator approval consumption (P0.2) ───────────────────── */
  // Atomic one-time-use consumption. Exactly one caller may consume an approval;
  // a duplicate receives `consumed:false` (no new execution grant). The
  // fingerprint binds the consumption to the exact signed approval.
  async _consumeApproval(request) {
    let body;
    try { body = await request.json(); } catch (_) { return X402IntentStore.json({ error: 'invalid_json' }, 400); }
    const { approvalId, approvalFingerprint, expectedAttemptId } = body || {};
    if (!INTENT_ID_RE.test(String(approvalId || ''))) return X402IntentStore.json({ error: 'invalid_approval_id' }, 400);
    if (typeof approvalFingerprint !== 'string' || !DIGEST_RE.test(approvalFingerprint)) return X402IntentStore.json({ error: 'invalid_fingerprint' }, 400);
    if (!INTENT_ID_RE.test(String(expectedAttemptId || ''))) return X402IntentStore.json({ error: 'invalid_attempt_id' }, 400);

    const outcome = await this.storage.transaction(async (txn) => {
      const revoked = await txn.get(KEY_APPROVAL_REVOKED + approvalId);
      if (revoked) return { status: 403, body: { ok: false, error: 'approval_revoked' } };
      const existing = await txn.get(KEY_APPROVAL + approvalId);
      if (existing) {
        if (existing.approvalFingerprint === approvalFingerprint && existing.attemptId === expectedAttemptId) {
          return { status: 200, body: { ok: true, consumed: false, already: true } };
        }
        return { status: 409, body: { ok: false, error: 'approval_conflict' } };
      }
      await txn.put(KEY_APPROVAL + approvalId, { approvalFingerprint, attemptId: expectedAttemptId, consumedAt: iso(Date.now()) });
      return { status: 201, body: { ok: true, consumed: true } };
    });

    return X402IntentStore.json(outcome.body, outcome.status);
  }

  // Durable revocation (idempotent, terminal).
  async _revokeApproval(request) {
    let body;
    try { body = await request.json(); } catch (_) { return X402IntentStore.json({ error: 'invalid_json' }, 400); }
    const { approvalId } = body || {};
    if (!INTENT_ID_RE.test(String(approvalId || ''))) return X402IntentStore.json({ error: 'invalid_approval_id' }, 400);
    await this.storage.transaction(async (txn) => {
      await txn.put(KEY_APPROVAL_REVOKED + approvalId, { revokedAt: iso(Date.now()) });
    });
    return X402IntentStore.json({ ok: true });
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
