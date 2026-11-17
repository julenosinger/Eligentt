# x402 Phase X402-2.1E — Arc Mainnet Certification, Circle Facilitator Validation & Controlled Activation Security

> Validates the remaining mainnet integration boundaries and strengthens
> operational safety. **NO REAL FINANCIAL EXECUTION.** No transfer, broadcast,
> deploy, or live authorization.

## 1. Baseline

| | Value |
|---|---|
| Initial HEAD | `e64aa1f` — `docs(x402): phase 2.1D.2B … report` |
| Final HEAD (code) | `3766510` — `feat(x402): Arc RPC/evidence validation + operator approval architecture` |
| Branch / tree | `main`, clean at start |
| Baseline x402 | 465 passing / 0 failing |

## 2. Exact files changed

- `functions/api/x402/x402-rpc.mjs` (new) — read-only Arc RPC primitives
  (chainId, receipt, authorizationState) + `Transfer`-event decoding + exact
  receipt-evidence validation.
- `functions/api/x402/x402-approval.mjs` (new) — operator settlement approval
  validation (HMAC-signed, one-time-use, revocable).
- `functions/api/x402/x402-settlement-orchestrator.mjs` — `settlementAuthorized`
  gate (live flag + operator approval).
- `tests/x402-rpc.test.js` (9), `tests/x402-approval.test.js` (9),
  `tests/x402-settlement-orchestrator.test.js` (+1).
- `docs/x402-live-certification-runbook.md` (updated), `docs/x402-phase-2.1e.md`.

## 3. Arc Mainnet RPC certification — UNVERIFIED (live), TESTED (logic)

No network access is available in this environment (Arc RPC and GitHub both fail
DNS), so live read-only RPC checks could not be performed and are **UNVERIFIED**.
The read-only RPC layer and on-chain evidence validation are implemented and
**TESTED** against realistic fixtures:

- `fetchChainId` / `fetchTransactionReceipt` / `fetchAuthorizationState` parse and
  error-classify (timeout, missing receipt, malformed) correctly.
- `decodeTransferEvent` extracts `from`/`to`/`value` from an ERC-20 `Transfer` log;
  the authorization nonce is NOT inferred from the log (it comes only from
  `authorizationState`).
- `validateReceiptEvidence` requires success + minimum confirmations + exact
  authorizer/recipient/atomic-amount binding, and rejects reverted/insufficient/
  mismatched/no-log receipts. It never returns `ok` on partial evidence.

## 4. On-chain evidence validation

A transaction hash alone, a provider reference alone, or a consumed EIP-3009
authorization alone is insufficient. `SETTLED` requires a successful receipt whose
`Transfer` event binds the exact authorizer → recipient → atomic amount, plus the
nonce-consumption, meeting confirmation policy. Unlinkable transactions stay
`SETTLEMENT_UNKNOWN`.

## 5. Circle Facilitator certification (re-confirmed)

`GET /supported` (no auth), `POST /verify` (non-settling), `POST /settle`
(disabled), `GET /status`. Arc `eip155:5042` / USDC `0x3600…0000` / `exact`
supported. A successful `/verify` is never treated as settlement; `/settle` is
never called.

## 6. Reconciliation hardening

`evaluateReconciliation` distinguishes provider confirmed/pending/rejected/
unavailable, on-chain confirmed/pending/reverted, authorization consumed/unused,
RPC unavailable, and contradictory evidence. No uncertain result becomes SETTLED;
no timeout becomes FAILED; no unknown outcome triggers automatic resubmission.

## 7. Operator approval architecture (new)

`buildApproval` / `validateApproval` enforce an explicit, cryptographically
authenticated (HMAC-SHA256) operator approval: unique id, operator identity,
chain, token, sender, recipient, max atomic amount, fee ceiling, attempt id,
expiry. One-time-use and revocation are enforced; a forged/tampered/expired/
revoked/reused/mismatched approval is rejected; no general-purpose API key
bypasses the approval. The settlement gate is `liveSettlementEnabled()` (hard
false) AND a valid approval. No live operator approval is created.

## 8. Durable Object production readiness

SQLite persistence across restart was certified in 2.1D.2B. The provisioning plan
(separate Worker + `X402_INTENT_LOCK` binding, migration tag `v1`, `DO_INTERNAL_SECRET`,
environment separation, rollback) is in `wrangler.jsonc` + the runbook. **Not
provisioned/deployed.**

## 9. Security

Signatures/credentials never leak through public interfaces; no generic
signing/settlement proxy; settlement actions trusted-internal; all gates off
(`SETTLEMENT_IMPLEMENTED`, `X402_ENABLED`, `X402_INTENT_PERSISTENCE`,
`X402_SIGNING_ENABLED`, `X402_FACILITATOR_VERIFY`, `X402_LIVE_SETTLEMENT_ENABLED`),
`/pay` = 503.

## 10. Test results & regression comparison

| Suite | Result |
|---|---|
| x402 (24 files incl. rpc + approval) | **484 passed / 0 failed** |
| CI `test` job + precision + Circle Wallet | 283 passed |
| Production build | success |
| Syntax (`node -c`) | clean |
| Lockfile (`utf-8-validate@5.0.10`) | intact |

Baseline 465 → **484** x402 passing; zero new failures in any touched file.

## 11. Status classification

- **IMPLEMENTED / TESTED:** RPC/evidence validation, operator approval, receipt
  binding, reconciliation, settlement orchestration, concurrency, replay safety.
- **CERTIFIED:** SQLite DO persistence across restart (2.1D.2B).
- **UNVERIFIED:** live Arc RPC / receipt certification (no network access);
  live facilitator `/verify`/`/settle`; live signing.
- **BLOCKED:** `X402_INTENT_LOCK` provisioning, Circle credentials/authorization.

## 12. Remaining blockers for controlled live settlement

1. Live Arc RPC + receipt certification (requires network access).
2. Owner + operator approval + Circle credentials (Level 3).
3. `X402_INTENT_LOCK` binding provisioning.
4. Live Circle `sign/typedData` certification.

**Verdict:** the certification and activation-safety layers are implemented and
tested; the system is NOT production-live and every financial execution path
remains disabled. Live certification requires a separate, explicitly-authorized
phase with network access and real credentials.
