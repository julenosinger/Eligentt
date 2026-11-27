# Capital Hub Phase 1.0.1 — Gateway Critical Security Hardening

## Status: incremental delivery (concrete P0 fixes)

The Gateway backend (`functions/api/gateway/transfer.js`) is already heavily
hardened from prior phases: persistent state machine (`submitting → accepted /
rejected / ambiguous → confirmed / failed`), Durable-Object atomic idempotence
(`GATEWAY_OP_LOCK` + non-production KV fallback, fail-closed in prod), atomic batch
reserve/rollback, and a server-side `/confirm` endpoint with full RPC verification
(chain-id, tx hash, receipt status, calldata salt decode). The Capital Hub UI is
presentation-only (native execution buttons disabled). This phase hardens the
remaining frontend gaps.

## Fixes applied (index.html)

1. **Confirmation integrity — `_execGatewayMint` (P0 §8).**
   Previously returned the raw `mintTxHash` even when no receipt was found after
   polling — a tx hash is NOT confirmation. It now returns a discriminated result:
   `{ status: 'confirmed', txHash, receipt }`, `{ status: 'pending', txHash }`
   (no receipt → never success), or `{ status: 'failed', txHash, receipt }`
   (revert). The caller (`execSend`) now branches on `status` and shows "awaiting
   confirmation — do not resubmit" for pending, never a false "Minted".

2. **Financial validation — `saExecGateway` (P0 §3).**
   - Amount is validated as a strict decimal string (`^\d+(\.\d+)?$`) — rejects
     scientific notation, signs and malformed input; no longer routes through
     `Number()`/`parseFloat` (float drift + `1e3` acceptance).
   - Excessive precision is rejected (`amount_too_precise`) instead of silently
     truncating the fractional part.
   - Recipient must be a valid EVM address (`^0x[0-9a-fA-F]{40}$`) and is rejected
     if it is the zero address.

Already-correct (verified, no change): `ubGwDepExecute` uses BigInt + regex
validation; the amount→atomic conversion in `saExecGateway` is BigInt-only.

## Tests

- `tests/capital-hub-phase-1.0.1.test.js` (new) — **10 pass** (discriminated mint
  result, caller branching, strict decimal regex behavioral test, precision +
  recipient validation).
- Gateway regression re-run — **3 pre-existing failures unchanged**
  (`gateway-spend-service.test.js` Windows path `C:\C:\…`, `gateway-balance.test.js`
  UI6.3, `treasury-restoration.test.js`). **Zero new failures.**
- `npm run build` — passes.

## Remaining / not done this increment

- Full frontend state machine + fencing tokens/versioning are implemented on the
  backend (DO) but not mirrored in the frontend `saExecGateway` flow (the frontend
  still delegates idempotence to the backend proxy). A full frontend
  operation-journal migration is a larger effort and is deferred.
- EIP-712 signature verification and attestation schema/binding validation remain
  backend-side; no client-side cryptographic re-validation was added (Circle API
  keys are never client-side).
- Mainnet readiness was NOT declared from mocks — no real Mainnet transaction was
  executed.

## Recommendation

Approved for the **confirmation-integrity and financial-validation** fixes above.
The broader idempotency/state-machine surface is already enforced server-side;
the frontend mirror is recommended for a follow-up increment (Phase 1.0.2), not
this one. No merge/deploy performed (awaiting explicit authorization).
