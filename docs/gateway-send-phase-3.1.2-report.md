# Gateway Send 3.1.2 — Circle Gateway Compliance Audit & Send Assets Execution Recovery

> Investigation + surgical correction. No real transfer, no merge, no deploy, no push to `main`.

## A. Repository and deployment

| Item | Value |
|---|---|
| Initial HEAD | `3d26e66` (`fix/gateway-send-3.1`) |
| Final HEAD | *(this commit)* |
| Branch | `fix/gateway-send-3.1` |
| PR #1 | **OPEN, not merged** (`mergeCommit: null`) — `fix/gateway-send-3.1` → `main` |
| Deployed commit | **UNVERIFIED** — Cloudflare Pages production build commit is not exposed via the repo; the deployed artifact is regenerated from `index.html` by the Pages build (`npm run build`), so `public/index.html` is a build byproduct and is **not** committed here. |
| `main` HEAD | `6024d2e` |

## B. Circle documentation compliance

Protocol references are the four Circle Gateway docs (Gateway Overview, Technical Guide,
Unified Balance EVM Quickstart, Gateway API Reference). The definitive conformance evidence
in this repo is the **working Unified Balance path**, which already completed a real mainnet
`gatewayMint` of 0.01 USDC (tx `0xf5852c36…`, Arc GatewayMinter, status success).

The confirmed failure is **not** a protocol-spec deviation — it is a code-path parity defect
(see C). Compliance matrix of the shared execution primitives (all reused by both paths):

| Requirement | Circle behaviour | Elligentt implementation | File / fn | Status |
|---|---|---|---|---|
| BurnIntent construction | EIP-712 typed data | `saExecGateway` builds + signs BurnIntent | `index.html` `saExecGateway` (40724) | CONFIRMED (works via UB) |
| EIP-712 signing | wallet `eth_signTypedData_v4` | Rabby (EIP-1193) signs | `saExecGateway` | CONFIRMED (works via UB) |
| Transfer submission | `POST /v1/transfer` | same-origin proxy `POST /api/gateway/transfer` (CSP-safe) | `functions/api/gateway/transfer.js` | CONFIRMED |
| Durable salt reservation | idempotency / replay protection | DO `GATEWAY_OP_LOCK` reserves salt before forward | proxy | CONFIRMED |
| Response / attestation | `{ transferId, attestation, signature, fees, expirationBlock }` | `saExecGateway` reads `respBody.attestation`/`signature`/`transferId`, returns `{ status:'pending', salt, transferId, attestation, operatorSig }` | `index.html` 40986 | CONFIRMED |
| GatewayMinter invocation | `gatewayMint(attestation, signature)` | `_execGatewayMint` targets `0x2222222d7164433c4C09B0b0D809a9b52C04C205`, selector `0x9fb01cc5`, switches to dest chain, submits tx | `index.html` `_execGatewayMint` (54567) | CONFIRMED (works via UB) |
| On-chain confirmation | receipt / confirm endpoint | proxy `/api/gateway/transfer/confirm` binds salt on-chain | `functions/api/gateway/transfer/confirm.js` | CONFIRMED |
| Balance reconciliation | balance refresh after mint | `ubInvalidateGatewayCache()` after success | both paths | CONFIRMED |
| Ambiguous / blocked / error states | no false success | `saExecGateway` returns discriminated `status` | `index.html` | CONFIRMED |

No protocol discrepancy was found. The Gateway/CCTP attestation distinction is respected:
`saExecGateway` consumes the Gateway attestation directly (not Iris/CCTP).

## C. Root cause — CONFIRMED

**Failing statement:** `index.html` `saDispatchSend` patch (pre-fix line 41018) —

```js
saDispatchSend = function() {
  if (_saGwOrigin && !_saCPNMode) {
    saExecGateway();   // ← fire-and-forget: no `await`
  } else {
    _saDispatchSendOrig.apply(this, arguments);
  }
};
```

Two compounding defects:

1. **Missing `await`.** `saExecGateway()` is async and returns a discriminated result
   (`{ status: 'pending', attestation, operatorSig, … }`). The fire-and-forget call discards
   that result, so the attestation returned by Circle is never consumed.
2. **Unreachable mint.** Even if the result had been captured, the destination mint could not
   run: `_execGatewayMint` is a **private** function inside the `UBScreen` IIFE and was not
   exposed in `UBScreen`'s returned object.

**Why Unified Balance succeeds.** `UBScreen.execSend` (54666) does the correct sequence:

```js
var gwResult = await saExecGateway();              // 54709
if (gwStatus === 'pending' && gwResult.attestation) {
  var mintTxHash = await _execGatewayMint({        // 54723 — direct, same scope
    attestation: gwResult.attestation,
    signature:   gwResult.operatorSig,
    destChainId: destChainId,
  });
}
```

**Why Send Assets fails.** `saDispatchSend` signed and submitted (first Rabby signature
completes BurnIntent + Circle submission) but then stopped: the mint step was never invoked,
so the flow ended immediately after the first signature with no `gatewayMint`.

The "Failed to fetch" from 3.1.1 was a *separate, earlier* failure (CSP-blocked direct Circle
POST) and is no longer the active blocker: the proxy routing on this branch is CSP-safe and
Unified Balance completes real mints through it.

## D. Correction

Two surgical changes, both in `index.html`:

1. **Expose the proven mint helper** (`UBScreen` return object, ~55012):

   ```js
   _execGatewayMint: _execGatewayMint,
   ```

   No logic change to `_execGatewayMint` — it is reused verbatim (verified GatewayMinter
   address + `0x9fb01cc5` selector + dest-chain switch + tx submission).

2. **Rewrote the `saDispatchSend` patch** (~41014–41054) to `async` with `await` and mint:

   ```js
   saDispatchSend = async function() {
     if (_saGwOrigin && !_saCPNMode) {
       try {
         var gwResult = await saExecGateway();
         var gwStatus = gwResult && gwResult.status ? gwResult.status : 'error';
         if (gwStatus === 'pending' && gwResult.attestation) {
           var destChainEl = document.getElementById('sa-dest-chain');
           var destChainId = destChainEl ? parseInt(destChainEl.value) : ((typeof activeChainId !== 'undefined') ? activeChainId : 5042);
           if (typeof UBScreen !== 'undefined' && typeof UBScreen._execGatewayMint === 'function') {
             try {
               var mintTxHash = await UBScreen._execGatewayMint({
                 attestation: gwResult.attestation,
                 signature:   gwResult.operatorSig,
                 destChainId: destChainId,
               });
               toast('Gateway transfer confirmed — tx ' + String(mintTxHash).slice(0, 10) + '…', 'success');
               if (typeof saUpdateRoute === 'function') saUpdateRoute();
               try { if (typeof ubInvalidateGatewayCache === 'function') ubInvalidateGatewayCache(); } catch(_) {}
             } catch(mintErr) {
               toast('Gateway mint failed: ' + (mintErr && mintErr.message ? mintErr.message : String(mintErr)).slice(0, 120), 'error');
             }
             return;
           }
           toast('Gateway mint step unavailable — transfer submitted but not minted', 'error');
           return;
         }
       } catch(e) {
         toast('Gateway error: ' + (e && e.message ? e.message : String(e)), 'error');
       }
     } else {
       _saDispatchSendOrig.apply(this, arguments);
     }
   };
   ```

**Scope / reachability verified.** `saDispatchSend` (41016) and `UBScreen` (54204) live in the
**same** inline `<script>` block (opening 13955 → closing 66780), so `const UBScreen` resolves
at runtime (after script load, before any user click). The guard uses the same
`typeof UBScreen !== 'undefined'` pattern already used at 55394/55484.

**Security impact.** None negative. No guard removed, no salt bypass, no direct Circle submit.
The mint helper still performs the dest-chain switch and requires the operator signature +
attestation from the proxy response. `blocked` / `ambiguous` / `error` states still surface as
toasts and **do not** mint. A missing mint helper fails loudly (no silent success).

**Regression risk.** Low — the change is additive parity with the proven UB path. Send Assets
non-Gateway (EVM/CPN) routing is unchanged (falls through to `_saDispatchSendOrig`).

## E. Verification

Tests (Vitest, all read-only source analysis; **no real transactions**):

| Suite | Result |
|---|---|
| `tests/gateway-send-assets-mint.test.js` (new, 4) | PASS |
| `tests/gateway-send-unified-path.test.js` (4) | PASS |
| `tests/gateway-csp-proxy.test.js` (3) | PASS |
| `tests/gateway-attestation-binding.test.js` (8) | PASS |
| `tests/gateway-fase2.test.js` (44) | PASS (GF2-2 updated to assert async+await) |
| `tests/gateway-deposit.test.js`, `gateway-fase18`, `gateway-ub-fase29`, `gateway-ub-fase291`, `gateway-ub-integration` | PASS |
| `tests/gateway-balance.test.js` | 1 pre-existing failure: **UI6.3** (unrelated `ubRefresh`/`ubGatewaySyncRefresh` ordering) |

`npm run build` passes. `public/index.html` (build byproduct) reverted — not committed.

New failures introduced by this change: **none**. The `gateway-fase2` GF2-2 assertion was
updated (not weakened) to require the corrected `await saExecGateway()` form.

**Remaining blockers:** PR #1 must be merged, and the Cloudflare Pages environment must have
`GATEWAY_OP_LOCK` (DO), `DO_INTERNAL_SECRET`, and `GATEWAY_RPC_URLS` bindings (otherwise the
proxy fails **closed** with HTTP 503 — a safe, distinct error).

**Safe deployment checklist:**
1. Merge PR #1.
2. Confirm CF bindings (`GATEWAY_OP_LOCK`, `DO_INTERNAL_SECRET`, `GATEWAY_RPC_URLS`).
3. Read Gateway USDC balance (Unified Balance) for the connected wallet.
4. Small (0.01 USDC) Send Assets → Gateway send; confirm browser shows `POST /api/gateway/transfer`, Rabby signs the BurnIntent, then approves the `gatewayMint`, and the transfer confirms on-chain.

## F. Operational safety

- **No real transaction executed** during this work — all verification is read-only (source
  analysis, mocked tests, RPC `eth_getTransaction*` reads of historical receipts).
- **No financial security guard disabled** — the Durable Object salt reservation, EIP-712
  authorization, discriminated `blocked`/`ambiguous`/`error` states, and on-chain confirmation
  requirements are all preserved.
- **Working Unified Balance path preserved** — `execSend` is untouched; only `_execGatewayMint`
  was *additionally exposed* (no behaviour change) and the Send Assets dispatch was corrected to
  mirror it.

### Classifications
- Root cause: **CONFIRMED**
- Fix correctness / scope reachability: **CONFIRMED**
- Deployed commit at `elligentttest.pages.dev`: **UNVERIFIED**
- Cloudflare binding presence in prod: **UNVERIFIED** (blocker for live mint, fails closed)
