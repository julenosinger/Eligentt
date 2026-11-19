# Gateway Send 3.1 — Unified Execution Path, Durable Idempotency & Safe Mainnet Validation

> Surgical fix of the direct-to-Circle submission bypass found in Phase 3.0.
> **No real transfers, no merge to main, no deploy.**

## 1. Baseline

| | Value |
|---|---|
| Baseline (Gateway Send 3.0) | `6024d2e` |
| Branch | `fix/gateway-send-3.1` (isolated; NOT pushed to `main`) |
| Working tree | clean at start |

## 2. Root cause of the bypass

`saExecGateway` (the Send Assets → Gateway executor in `index.html`) built and
signed the BurnIntent, then posted the request **directly to
`gateway-api.circle.com/v1/transfer`**, bypassing the Cloudflare proxy
`/api/gateway/transfer` that provides the atomic Durable Object salt reservation,
cross-session replay protection and durable operation record. The direct path
relied only on the random salt + EIP-712 signature, with no server-side
idempotency/record for ambiguous-outcome reconciliation.

## 3. Exact files changed

- `index.html` — `saExecGateway` now computes `_gwTransferUrl`:
  - **mainnet** → `/api/gateway/transfer` (protected CF proxy).
  - **testnet** → `https://gateway-api-testnet.circle.com/v1/transfer` (dev only).
- `tests/gateway-send-unified-path.test.js` (new, 4 tests).
- `docs/gateway-send-phase-3.1.md` (this file).

## 4. Before / after execution diagram

```
BEFORE (bypass):
  saExecGateway → sign BurnIntent → POST gateway-api.circle.com/v1/transfer → attestation

AFTER (protected):
  saExecGateway → sign BurnIntent → POST /api/gateway/transfer
                    → DO salt reservation (atomic)
                    → Circle /v1/transfer
                    → durable state update (accepted/rejected/ambiguous)
                    → return raw Circle response (object shape preserved)
                    → attestation → gatewayMint → /confirm (on-chain salt binding)
```

The proxy returns the **raw Circle response object**
(`{ transferId, attestation, signature, fees, expirationBlock }`) with the same
status, so `saExecGateway`'s response handling is unchanged and correct.

## 5. Durable idempotency

- Salt reservation (`GATEWAY_OP_LOCK` DO, one instance per salt) runs **before**
  Circle submission; a conflicting salt returns `already_submitted` (409).
- The proxy never treats 5xx/429/408 as definitive rejection — they become
  `ambiguous`, blocking auto-resubmission.
- Only `/confirm` (server-side RPC + on-chain salt binding) can reach `confirmed`
  or `failed`; no client-writable terminal transition.

## 6. Compatibility

- Unified Balance deposits: unchanged (deposit-params + balances untouched).
- Gateway sends: same BurnIntent build + signature + response shape.
- Swap / Bridge / Treasury / contracts / fees: untouched.

## 7. Test results

| Suite | Result |
|---|---|
| `tests/gateway-send-unified-path.test.js` (new) | 4 passed / 0 failed |
| `tests/gateway-attestation-binding.test.js` (3.0) | 8 passed / 0 failed |
| Gateway suites (balance/deposit/fase18/fase2/ub-fase29/ub-fase291/ub-integration) | 277 passed / 1 pre-existing (`gateway-balance.test.js` UI6.3 — `ubRefresh` ordering, unrelated) |
| Production build | success |
| Syntax | clean |

**New failures: ZERO.** The single failure is pre-existing and untouched.

## 8. Mainnet test-readiness (manual, requires explicit approval)

A real Gateway USDC balance exists for later controlled testing. A manual 1-USDC
test procedure (NOT automated, NOT executed here) must require a separate explicit
user approval and follow:

1. Read the Gateway USDC balance for the connected wallet (Unified Balance).
2. Confirm the balance belongs to the selected wallet and the source domain is Arc (26).
3. Confirm the destination chain/domain is supported and the recipient is valid.
4. Confirm the amount + `maxFee` (conservative ceiling) is covered by the balance.
5. Verify persistence (`GATEWAY_OP_LOCK` / `DO_INTERNAL_SECRET` / `GATEWAY_RPC_URLS`)
   is configured; otherwise the proxy fails closed.
6. Submit via Send Assets (Gateway source) — which now routes through the proxy.
7. Sign the BurnIntent in the wallet, confirm the attestation, mint, and await
   `/confirm` (on-chain salt binding) before reporting success.
8. Verify the net amount and balance refresh; never assume 1 USDC covers every route.

## 9. Remaining risks

- Live mainnet transfer/confirm certification requires real credentials (not authorized).
- `GATEWAY_OP_LOCK` / `GATEWAY_OPS_KV` / `GATEWAY_RPC_URLS` must be provisioned in CF.
- Testnet still uses the direct Circle testnet API (dev only — no server-side record).

**Verdict:** the direct-submission bypass in the audited Gateway send path is
closed; mainnet sends now flow through the protected proxy with durable salt
reservation. Zero new regressions.
