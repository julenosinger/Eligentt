# Gateway Send 3.0 — Critical Security Audit & End-to-End Transfer Integrity

> Surgical security audit of the existing Circle Gateway transfer infrastructure
> used by Send Assets and Unified Balance. **No real transfers, no deployment, no
> contract/fee changes.**

## 1. Baseline

| | Value |
|---|---|
| Initial HEAD | `0ff56f0` — `docs(x402): phase 2.1F … report` |
| Final HEAD (code) | `cc500f0` — `fix(gateway): bind attestation to BurnIntent + dual-shape balance resolution` |
| Branch / tree | `main`, clean at start |
| Baseline x402 | 496 passing / 0 failing |

## 2. Files audited

`shared/GatewaySpendService.js`, `functions/api/gateway/transfer.js` (incl.
`/confirm`), `functions/api/gateway/balances.js`, `functions/api/gateway/deposit-params.js`,
`functions/api/gateway/gateway-op-lock.do.js` (GatewayOpLock DO), `index.html`
(`saExecGateway`, Unified Balance/Send Assets wiring), plus the gateway test suite.

## 3. Files modified

- `shared/GatewaySpendService.js` — two surgical corrections (below).
- `tests/gateway-attestation-binding.test.js` (new, 8 tests).
- `docs/gateway-send-phase-3.0.md` (this file).

## 4. Findings and corrections

### P0.1 — BurnIntent integrity — VERIFIED SOLID (no change)
`buildBurnIntent` correctly binds maxBlockHeight=maxUint256, conservative maxFee,
spec.version=1, sourceSigner=depositor, destinationCaller=0, BigInt atomic value,
random 32-byte salt, and freezes the intent before signing. `GatewaySpendService`
verifies the EIP-712 signature recover === depositor (fail-closed).

### P0.2 — Circle attestation binding — CONFIRMED GAP, FIXED
The client extracted `attestation.payload`/`signature` from the Circle `/v1/transfer`
response and proceeded to `gatewayMint` WITHOUT verifying the attestation belonged
to the submitted BurnIntent. A mismatched/malicious response could mint an
attestation for a different operation (the server `/confirm` would later reject it,
but only after gas was spent / a wrong mint attempted).

**Fix:** added `verifyEchoedBurnIntent(echoed, submitted)` — the response echoes the
`burnIntent`; its `salt` (the unique, signature-committed operation identifier) and
every authorization-critical field (domains, contracts, tokens, depositor,
recipient, signer, caller, value) MUST match the submitted intent, or execution
throws `attestation_intent_mismatch` (fatal). No-op when the response is opaque
(server `/confirm` re-verifies the salt on-chain).

### P0.3 — GatewayMint confirmation — VERIFIED SOLID (no change)
`POST /api/gateway/transfer/confirm` independently verifies chainId, transaction
hash, `tx.to === GatewayMinter`, receipt status, block-number consistency, calldata
selector, ABI bounds (BigInt), attestation magic, and the salt at the documented
fixed offset — the exact operation-to-transaction linkage.

### P0.4 — Durable operation ledger — VERIFIED SOLID (no change)
`/api/gateway/transfer` uses atomic salt reservation via `GATEWAY_OP_LOCK` DO
(fail-closed in production), a state machine (`submitting/accepted/rejected/
ambiguous/confirmed/failed`), and no client-writable terminal transitions.

### P0.5 — Reconciliation / ambiguity — VERIFIED SOLID (no change)
HTTP classification (2xx=accepted, 4xx=rejected, 429/408/5xx=ambiguous) never
treats a timeout as failure and never auto-retries an ambiguous submission.

### P0.6 — Balance response shape — CONFIRMED GAP, FIXED
`GatewaySpendService.fetchGatewayBalance` expected `{ assets:[{token,balances}] }`,
but `/api/gateway/balances` returns `{ USDC:[{domain,balance}], EURC:[...], cirBTC:[...] }`
— so the balance check would always fail (`null` → `rpc_unavailable_balance_check`),
blocking the shared service. **Fix:** accept both response shapes.

### Finding (documented, future phase) — production Send Assets bypasses the proxy
`saExecGateway` (in `index.html`) posts DIRECTLY to `gateway-api.circle.com/v1/transfer`,
bypassing the CF proxy `/api/gateway/transfer` (which provides the atomic salt
reservation + durable operation record). The direct path works (random salt + EIP-712
signature provide protocol-level uniqueness), but it lacks the server-side durable
record / cross-session replay protection the proxy offers. Rewiring `saExecGateway`
through the proxy is a larger change that risks the currently-working send path; it
is documented as a P0 item for a dedicated follow-up rather than implemented
speculatively here (per "do not rebuild what already works").

## 5. Test results

| Suite | Result |
|---|---|
| `tests/gateway-attestation-binding.test.js` (new) | 8 passed / 0 failed |
| Gateway suites (balance/deposit/fase18/fase2/ub-fase29/ub-fase291/ub-integration) | 277 passed / 1 pre-existing UI-ordering failure (`gateway-balance.test.js` UI6.3 — unrelated to GatewaySpendService) |
| `tests/gateway-spend-service.test.js` | pre-existing Windows path bug (`new URL(...).pathname` → `C:\C:\…`), not runnable on this machine — unrelated |
| Production build | success |
| Syntax (`node -c`) | clean |

Zero new regressions in the touched module (`shared/GatewaySpendService.js` is not
imported by the failing UI-ordering test or the broken-path test).

## 6. Status classification

- **IMPLEMENTED / TESTED:** `verifyEchoedBurnIntent` (attestation binding),
  dual-shape balance resolution.
- **CERTIFIED:** server-side salt reservation, state machine, HTTP classification,
  on-chain salt binding, receipt cross-checks (audited; no change).
- **UNVERIFIED:** live Circle `/v1/transfer`/`/confirm` (no real transfer authorized).
- **BLOCKED (future phase):** routing `saExecGateway` through the CF proxy.

## 7. Remaining risks

1. `saExecGateway` direct-to-Circle path (no server-side durable record) — follow-up.
2. Live attestation/confirm certification requires real credentials (not authorized).
3. `GATEWAY_OP_LOCK` / `GATEWAY_OPS_KV` / `GATEWAY_RPC_URLS` provisioning in CF.

**Verdict:** the shared GatewaySpendService is strengthened (attestation binding +
balance-shape robustness) with zero regressions. Existing deposits and transfers
remain intact; no financial execution occurred.
