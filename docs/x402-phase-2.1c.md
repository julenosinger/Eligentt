# x402 Phase X402-2.1C — Circle EIP-712 Signing Certification + CI/CD Recovery

> Two isolated workstreams: (A) restore the global CI `test` job; (B) certify the
> Circle Wallet EIP-712 signing foundation for x402 **without enabling settlement**.
> No signing-to-broadcast, no facilitator, no transfer, no deploy, no real payments.

## 1. Baseline

| | Value |
|---|---|
| Initial HEAD | `0ea8e1f` — `docs(x402): phase 2.1B … report` |
| Final HEAD (code) | `e0278d1` — `feat(x402): EIP-712 signing cert + bytes32 nonce + wallet sharding; fix npm ci (X402-2.1C)` |
| Branch / tree | `main`, clean at start |
| Baseline full suite | 4671 passed / 149 pre-existing failed / 4 skipped |

## 2. Exact files changed

- `package-lock.json` — CI repair (see `docs/ci-npm-lockfile-recovery.md`): +14 lines.
- `functions/api/x402/x402-intent.do.js` — bytes32 nonce, `/authorize` action, AUTHORIZED transition, casing normalization, new null-checked fields.
- `functions/api/x402/intent-service.mjs` — bytes32 nonce regex + CSPRNG generator, wallet-address sharding, ownership guard, signature redaction, `doAuthorize`, new record fields.
- `functions/api/x402/intent.js` — pass wallet shard key + userId, redact signatures.
- `functions/api/x402/x402-eip712.mjs` (new) — pure EIP-3009 typed-data construction + verification.
- `functions/api/x402/x402-signing.mjs` (new) — gated Circle signing adapter + authorize orchestration.
- `functions/api/agent-signer/_circle.js` — export `encryptEntitySecret` (additive).
- `tests/x402-eip712.test.js` (new), `tests/x402-signing.test.js` (new), `tests/x402-intent-do.test.js`, `tests/x402-intent.test.js`.
- `.dev.vars.example` — `X402_SIGNING_ENABLED`, `X402_AUTH_WINDOW_SECONDS`.
- `docs/ci-npm-lockfile-recovery.md`, `docs/x402-phase-2.1c.md` (this file).

## 3. Workstream A — CI recovery

Root cause, minimal lockfile diff, and verification are in
`docs/ci-npm-lockfile-recovery.md`. Summary: `jayson`'s `ws@7.5.13` requires the
optional peer `utf-8-validate@^5.0.2`, but the lockfile wrongly deduped it to
`6.0.6`; npm 10.8.2 `ci` therefore reports `Missing: utf-8-validate@5.0.10`.
Fixed by adding the single nested `jayson/node_modules/utf-8-validate@5.0.10`.
Verified: `npm ci` (npm 10.8.2) 283→284 packages, `npm ls` clean, CI `test` job
(213 tests) green, production build succeeds. No remote run was triggered from
this environment (documented, not claimed).

## 4. P0 security audit (Workstream B, Checkpoint C)

### A. Wallet→user sharding

The 2.1B `X402IntentStore` sharded by `userId`, assuming one wallet → one user.
Audit of the Circle wallet lifecycle (`_circle.js createUserWallet`, `agent/provision.js`,
`agent/[[path]].js`, `auth/verify.js`): each user is provisioned a **unique**
wallet (`accountType: EOA`, `metadata.refId = userId`); a stale wallet is cleared
and recreated, never reassigned; `resolveUserWallet` (x402) requires a per-user
wallet and never falls back to the platform wallet. So wallet→user is 1:1 by
construction — but the guarantee is **implicit, not enforced**.

**Correction:** the coordinator now shards by the **lowercase wallet address**
(the authoritative nonce namespace), not the user id. Every intent and every
EIP-3009 nonce reservation for a wallet serialize in one DO regardless of any
user-mapping assumption. The service additionally re-checks `intent.userId ===
auth.userId` (ownership guard) — tested for the shared-wallet edge case.

### B. EIP-3009 nonce representation

The 2.1B nonce was a decimal string (`/^\d{1,78}$/`). EIP-3009 nonces are
`bytes32`. **Correction:** canonical form is now lowercase hex `0x` + exactly 64
hex chars; generated with the Web Crypto CSPRNG (`generateAuthorizationNonce`);
normalized to lowercase for storage/comparison. Truncated, duplicated, cased, and
decimal forms are rejected. Since the persistence gate is off by default and no
production intents exist, there are no legacy persisted decimal nonces to migrate;
the schema guard (`schemaVersion`) remains the future migration boundary.

### C. Durable Object runtime

The DO uses `state.storage` (SQLite-backed on modern CF) + `storage.transaction()`
+ `blockConcurrencyWhile()` + a re-arming alarm, matching the shipped `CpnLock`/
`GatewayOpLock` pattern. **Not integration-verified:** Miniflare/workerd is not
available in this repository, so real restart/eviction durability and true
SQLite persistence are carried by the Cloudflare runtime and are documented as
**UNVERIFIED** (not claimed from mocked tests).

## 5. EIP-712 typed-data schema

Domain (certified offline — the computed separator equals the on-chain value):

```
name: "USDC", version: "2", chainId: 5042,
verifyingContract: 0x3600000000000000000000000000000000000000
```

`TransferWithAuthorization` struct (EIP-3009): `from (address)`, `to (address)`,
`value (uint256)`, `validAfter (uint256)`, `validBefore (uint256)`, `nonce (bytes32)`.

**Offline certification result:** `TypedDataEncoder.hashDomain(domain) ===
0x940506929bba468048a19b567f4f0d534714bc06604b5c3017e5d16785ccdf84` (the
on-chain `DOMAIN_SEPARATOR` confirmed in X402-2.0.1). `value` is the exact BigInt
atomic amount as a decimal string — never `Number`. Digest, recovery, signer
binding, wrong-signer rejection, malformed-length rejection, and high-s
malleability rejection are all covered by `tests/x402-eip712.test.js`.

## 6. Circle signing adapter

- Endpoint: `POST https://api.circle.com/v1/w3s/developer/sign/typedData`
  (`{ walletId, data (EIP-712 JSON string), entitySecretCiphertext, memo }`
  → `{ data: { signature } }`) — confirmed against Circle's documented API.
- Gate: `X402_SIGNING_ENABLED=false` by default AND `CIRCLE_API_KEY`/
  `CIRCLE_ENTITY_SECRET` present. Without both, every call fails closed.
- Split: pure typed-data (`x402-eip712.mjs`) → offline verification → Circle
  provider adapter (`x402-signing.mjs`) → durable authorization (`doAuthorize`).
- `authorizeIntent` builds typed data **only** from the persisted intent, verifies
  the signature locally (recovered signer must equal the wallet), then persists
  AUTHORIZED through the trusted internal DO transition. Circle returning 200 is
  never treated as validity; the signature is re-verified and re-bound.

## 7. Durable intent authorization (state machine)

```
CREATED → PREPARED → AWAITING_AUTHORIZATION → AUTHORIZED
   └──────────────┬────────── (cancel/expire) ─────────────┘
```

- `AUTHORIZED` is reachable **only** via `/authorize` (internal, `DO_INTERNAL_SECRET`),
  never via a client. `SETTLED`/`FAILED`/`SUBMITTING`/`SETTLEMENT_UNKNOWN` remain
  unreachable.
- `/authorize` re-binds the signed terms (from/to/value/nonce) to the persisted
  intent, enforces `stateVersion`, checks the validity window, is idempotent on
  re-entry, and never auto-expires a signed intent.
- The executable signature is stored in DO storage but **redacted** from every
  browser-facing response (`redactIntent`).

## 8. Test evidence

| Suite | Result |
|---|---|
| x402 (16 files incl. eip712 + signing) | **410 passed / 0 failed** |
| CI `test` job (10 files) + precision + circle-wallet | 283 passed |
| `npm ci` (npm 10.8.2) | success |
| Production build | success |
| Syntax (`node -c`) on new/changed files | clean |

Adversarial coverage: wrong chain/token/domain/wallet/payTo/amount/nonce,
expired window, invalid validAfter/validBefore, wrong signer, wrong-length and
high-s signatures, cross-user + shared-wallet access, duplicate/concurrent
signing, Circle 401/403/429/5xx/missing-signature, signing-disabled gate,
stale stateVersion, cancel/sign race, nonce reuse, `/pay` (503) and no `/settle`
route.

## 9. Baseline vs final

x402 scope: 322 (2.1A) → 382 (2.1B) → **410 (2.1C)** passing tests, 0 failures; the
2.1B pre-existing phase126 brittle string-match is now fixed (test-only), and 28
new tests were added (EIP-712 offline, signing adapter, DO authorize, shared-wallet
ownership). The full-repository run still reports pre-existing failures only in
unrelated modules (agent/autonoma/gateway/tax/swap/unified-portfolio/wallet-provision),
with small run-to-run variance (149–151 failed) from flaky timeout tests and
environmental unhandled-output noise (`Error: write UNKNOWN`) — none attributable
to any file changed by this phase. Zero new regressions. Level 3 live Circle
signing is **BLOCKED** (no credentials / no authorization) — not claimed.

## 10. Unresolved risks / readiness

1. **Live Circle signing not certified** (Level 3 BLOCKED — no explicit approval).
2. **DO restart/eviction durability not integration-verified** (no Miniflare/workerd).
3. **`X402_INTENT_LOCK` binding not provisioned** — persistence is gated off.
4. On-chain `authorizationState` verification + settlement reconciliation remain
   future work (X402-2.1D), along with `/settle` and broadcast.

Preserved: `SETTLEMENT_IMPLEMENTED=false`, `X402_ENABLED=false`,
`X402_INTENT_PERSISTENCE=false`, `X402_SIGNING_ENABLED=false`, `/api/x402/pay`
= 503. No signing-to-broadcast, no facilitator, no transfer, no deploy.

**Verdict for X402-2.1D:** the offline cryptographic foundation (exact typed
data, certified domain separator, local verification) and the durable, replay-safe
authorization path are implemented and tested; live provider signing and real DO
provisioning are the explicit remaining blockers.
