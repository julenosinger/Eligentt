# Capital Hub Phase 1.0.1D.2.6 — P0: second wallet call (gatewayMint) fix + recovery

> Branch `work/capital-hub-phase-1.0.1` (base `df4ccff`). Preview-only deployment. No merge to
> main, no production change, no automatic financial transaction.

## Root cause (P0)

During a real 0.1 USDC Withdraw, the wallet was called **only once**. The Circle Gateway
manual flow requires **two** wallet interactions:

1. EIP-712 signature of the `BurnIntent` (done by `saExecGateway`).
2. Confirmation of `GatewayMinter.gatewayMint(attestation, signature)` on the destination chain.

The Capital Hub native executor (`UI.qaExec` in `shared/capitalHubManage.js`) called
`saExecGateway()` and, on `status:'pending'`, only showed "submitted — awaiting mint" — it
**never called the mint step**. The reference Send Assets flow (`execSend` in `UBScreen`)
*does* call `_execGatewayMint` after the attestation; the Capital Hub path was missing that
second call. Result: the transfer stays `Processing` with a transferId + salt but no tx hash,
and the funds are never minted on the destination chain.

## Fix

### 1. The mint step now runs in the Capital Hub (Send / Cross-chain / Withdraw)
- `index.html`: the UBScreen closure exposes its mint executor as `gatewayMint: _execGatewayMint`
  (it was previously closure-scoped and unreachable from other scripts).
- `shared/capitalHub.js`: new `mintExecutor()`, `finishMint(opId, att, sig, destChainId)` and
  `recoverMint(opId)` — the mint + recovery live in the core module (exposed as
  `CapitalHub.finishMint` / `CapitalHub.recoverMint`), so `capitalHubManage.js` stays free of
  low-level network/signing code (preserves its characterization contract).
- `shared/capitalHubManage.js`: `UI.qaExec` now, on a valid attestation, persists the recovery
  material and calls `CH.finishMint(...)` — the **second wallet interaction**.

### 2. Attestation extraction and persistence (server)
- `functions/api/gateway/transfer.js` legacy POST path now persists `transferId`,
  `attestation` and `signature` (the Circle recovery material) in the per-salt record at accept
  time — previously only `status`/`httpStatus` were stored.
- `functions/api/gateway/gateway-op-lock.do.js`: `/update` persists those three fields; the
  reserve record initialises them to `null`.

### 3. Recovery of an interrupted mint (no re-sign, no re-submit)
- `GET /api/gateway/transfer?salt=…&depositor=…&recover=1[&transferId=…]` returns the
  attestation + operator signature (from the persisted record, or re-fetched from Circle
  `GET /v1/transfer/{id}` for pre-fix operations). Depositor isolation is enforced against the
  per-salt DO record (the authoritative identity source — Circle's transfer summary has no
  `sourceSigner`).
- `shared/capitalHubUI.js`: a **"Complete mint"** action appears on Processing/Requires-Review
  transfer/withdraw rows (only when no tx hash is recorded yet — no duplicate mint).
- `shared/capitalHub.js` `recoverMint` runs the SAME mint executor against the recovered
  attestation, guarding against duplicate mint (`op.txHash` blocks re-minting).

## Live evidence (Preview `work-capital-hub-phase-1-0-1.elligentttest.pages.dev`)

```
GET /api/gateway/health
HTTP 200  {"ok":true,"persistence":"do","detail":"GATEWAY_OP_LOCK is reachable."}

GET /api/gateway/transfer?salt=0x…0&depositor=0x1111…1111
HTTP 404  {"error":"not_found",…}            # DO read + secret match

GET /api/gateway/transfer?recover=1&depositor=0x1111…1111
HTTP 400  {"error":"salt_required"}
```

Deployed bundle confirms the fix is live:
- `/bundles/inline-1.6785d15b.js` contains `gatewayMint: _execGatewayMint`.
- `/shared/capitalHub.js` contains `finishMint` / `recoverMint`.
- `/shared/capitalHubManage.js` contains `CH.finishMint`.
- `/shared/capitalHubUI.js` contains the "Complete mint" action.

Worker redeployed (`elligentt-gateway-op-lock`, Version `8d9c00e3…`); Pages redeployed
(deployment `997a99b8`, alias as above).

## Tests
- `gateway-execution-coordinator.test.js` — 57 pass (added 3 recovery tests: persisted-attestation
  recovery, Circle re-fetch recovery, depositor-isolation 404).
- `gateway-execution-coordinator.runtime.test.js` — pass.
- `capital-hub-native-execution.test.js` — 13 pass (added 7 mint-completion/recovery guards).
- `capital-hub-phase-1.0.1.test.js` — pass.
- **Zero new failures.** Pre-existing unchanged: `gateway-balance` UI6.3, `capital-hub` "native
  execution is not enabled yet" (confirmed failing on base `df4ccff`), `gateway-ub-fase29`,
  `send-assets-mainnet-source`, `treasury-restoration`, and the Windows-path
  `gateway-spend-service`.

## Operator guidance (recovering the existing 0.1 USDC Withdraw)
The stuck operation (has transferId + salt, `Processing`, no tx hash) will now show a
**"Complete mint"** button in the Operations list. Clicking it:

1. Re-fetches the attestation from the server (persisted record or Circle `GET /v1/transfer/{id}`).
2. Prompts the wallet for the **gatewayMint** confirmation (the second interaction).
3. Never re-signs the BurnIntent, never re-submits to Circle, never mints twice.

> Note: Circle attestations expire after ~10 minutes. If the attestation has already expired,
> the recovery returns `attestation_not_available` (fail-closed, no false success); the funds
> remain in the Gateway balance and a fresh transfer (new BurnIntent) is the safe path.

## Security
- No private keys or raw signing material are stored; only the Circle attestation payload +
  operator signature + transferId (which can only mint to the burn intent's own recipient).
- Recovery isolation is enforced server-side against the per-salt DO record.
- The coordinator and its experimental limits remain disabled; the legacy path is unchanged
  except for the additive attestation persistence.
