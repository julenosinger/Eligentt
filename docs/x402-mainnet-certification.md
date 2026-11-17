# x402 Mainnet Certification — Arc (5042) + Circle Wallet + Facilitator

> Phase X402-2.0 — **READ-ONLY financial certification.** No payments, no
> broadcast, no deploy. Baseline `1fd6325` verified.

## A. Executive verdict

**BLOCKED.**

Arc Mainnet is **not EIP-3009 compatible** and the reference facilitator
(`x402.org/facilitator`) does **not** support `eip155:5042`. The `exact` scheme
(which requires USDC `transferWithAuthorization`) cannot settle on Arc with the
current stack. The code correctly marks Arc `eip3009Compatible: false` and keeps
`SETTLEMENT_IMPLEMENTED = false`.

## B. Arc compatibility — read-only on-chain evidence

RPC `https://rpc.mainnet.arc.io` (block `0x1e404d3` = 31,720,659). Contract
`0x3600000000000000000000000000000000000000`.

| Check | Selector | Result | Verdict |
|---|---|---|---|
| chainId | `eth_chainId` | `0x13b2` = **5042** | ✅ |
| code present | `eth_getCode` | 1,798 bytes | ✅ contract deployed |
| decimals | `decimals()` | **6** | ✅ |
| name | `name()` | `USDC` | ✅ |
| symbol | `symbol()` | `USDC` | ✅ |
| balanceOf | `balanceOf(0x0)` | `0` | ✅ standard ERC-20 |
| EIP-712 domain | `eip712Domain()` | **`execution reverted`** | ❌ NOT EIP-712 |
| EIP-3009 state | `authorizationState(0,0)` | **`execution reverted`** | ❌ NOT EIP-3009 |

**Conclusion:** Arc USDC is a standard ERC-20 (6 decimals) but does **not**
implement EIP-3009 (`transferWithAuthorization`) nor expose an `eip712Domain()`.
The `exact` scheme cannot be executed. The existing `eip3009Compatible: false`
flag and `TRUSTED_ASSETS['eip155:5042']` "listed but blocked" posture are correct.

## C. Circle Wallet signing

- The custodial per-user Circle wallet supports **EIP-712 `signTypedData`** via the
  server-side sign endpoint (see `tests/sign-typeddata.test.js` — "Commit C —
  custodial signTypedData returns a signature that recovers the correct address").
- This capability is exercised for the **relayer authorization** domain
  (`functions/api/relayer-auth.mjs`, opt-in `auth.scheme='eip712'`).
- **EIP-3009 signing for the Arc USDC domain is NOT implemented**
  (`docs/x402-integration.md`: "Fase 2 (não incluída): assinatura EIP-3009 via
  Circle signTypedData").
- Whether the Circle `signTypedData` endpoint accepts an arbitrary domain
  (name="USDC", version="2", chainId 5042) is **UNVERIFIED** — and irrelevant
  while the on-chain `transferWithAuthorization` selector does not exist.

**Blocker:** even with a valid EIP-712 signature, Arc USDC has no
`transferWithAuthorization` to consume it.

## D. Facilitator matrix

| Provider | Endpoint | Arc `eip155:5042` | EVM `exact` | Classification |
|---|---|---|---|---|
| x402.org (reference) | `https://x402.org/facilitator` | ❌ absent from `/supported` | Base Sepolia only | **UNSUPPORTED** for Arc |
| Self-hosted facilitator | n/a (not implemented) | — | — | **not implemented** |

`GET https://x402.org/facilitator/supported` (live, read-only) lists
`eip155:84532` (Base Sepolia) for EVM `exact`/`upto`/`batch-settlement`, plus
Solana/Algorand/Aptos/Stellar/Hedera/XRPL. **No mainnet EVM, no Arc.**

## E. Security findings

| Sev | Finding | Root cause | Remediation |
|---|---|---|---|
| P0 | Arc EIP-3009 incompatible | USDC is a native precompile, not EIP-3009 ERC-20 | Keep Arc blocked; do not enable Arc settlement |
| P0 | Facilitator lacks Arc support | reference facilitator targets testnets only | identify/self-host an Arc facilitator before enabling |
| P1 | Financial limit uses float | `Number(amountBig)/10^dec` for `amount_within_max` | exact BigInt atomic-unit comparison (below) |
| P2 | SSRF guard is best-effort | Workers has no DNS resolver; no response-size limit / rate limit | enforce `X402_ALLOWED_HOSTS` allowlist; add size/time limits |
| P2 | `handlePay` inert (503) | settlement not implemented | implement only after A/B unblocked |

## F. Financial precision

Current (`functions/api/x402/_x402.mjs`, `validateRequirement`):

```js
const amountBig = BigInt(String(req.amount).trim());      // atomic units (exact)
const amountUsd = Number(amountBig) / Math.pow(10, dec); // ← FLOAT
add('amount_within_max', amountUsd <= maxUsd, ...);       // ← FLOAT comparison
```

**Exact contract for X402-2.1** (BigInt, no float for the authoritative limit):

```js
const scale = 10n ** BigInt(decimals);
const maxUsdAtomic = BigInt(Math.round(maxUsd * 10 ** decimals)); // 25 USD × 10^6 = 25000000n
add('amount_valid', amountBig != null && amountBig > 0n, ...);
add('amount_within_max', amountBig != null && amountBig <= maxUsdAtomic, ...);
// amountUsd for DISPLAY only: (amountBig * 10n**6n) / scale, string-formatted — never authoritative.
```

Reject: zero/negative, scientific notation, non-integer strings, oversized (still
exact in BigInt but bounded by `amount_within_max`), unsupported token/domain/
network, invalid timeout/recipient. USD limit → atomic units exactly via integer
scale (the configured `maxUsd` is a small decimal).

## G. Proposed architecture (for X402-2.1)

```
HTTP 402 → discover (SSRF-guarded fetch + parse/validate)
        → prepare (re-validate server-side, resolve per-user Circle wallet)
        → intent (cryptographically strong id = requirementId(resource, req))
        → [BLOCKED until: EIP-3009-capable network + Arc facilitator]
        → sign (Circle signTypedData, EIP-3009 USDC domain)
        → settle (facilitator /verify + /settle, idempotency key = intent id)
        → reconcile (persist intent state + tx evidence; never localStorage-only)
```

Persistent server-side intent model (NOT implemented in 2.0, specified for 2.1):
intentId (hash of canonical requirement), userId + walletAddress binding,
resourceUrl, requirement digest, expiration (maxTimeoutSeconds), nonce,
idempotency key, durable lock, transaction hash, reconciliation status.

## H. Implementation contract for X402-2.1

- `functions/api/x402/_x402.mjs` — exact BigInt `validateRequirement`; add
  `maxUsdAtomic`; keep `SETTLEMENT_IMPLEMENTED = false` until A/B unblocked.
- `functions/api/x402/index.js` — keep `handlePay` fail-closed; add `/verify` +
  `/settle` only when a facilitator + EIP-3009 network are certified.
- New `functions/api/x402/intent-*.mjs` (Durable Object) — persistent intent lock,
  idempotency, evidence.
- Config: add `X402_FACILITATOR_URL` (override), keep `X402_ENABLED` off.
- Tests: exact-precision boundary, intent idempotency, facilitator `/supported`
  parsing, Arc rejection, settlement-disabled gate.
- **Feature gates (unchanged):** `X402_ENABLED` off, `SETTLEMENT_IMPLEMENTED`
  false, `settlementAvailable()` false.

## I. Regression results

- `tests/x402.test.js` 33 ✅, `tests/x402-client.test.js` 7 ✅,
  `tests/x402-send-assets.test.js` 63 ✅ → **103/103** (unchanged from baseline).
- No code changed in this phase (documentation + read-only verification only).

## J. Mainnet activation blockers (explicit)

1. **Arc USDC lacks EIP-3009** — `transferWithAuthorization`/`authorizationState`
   revert on-chain. Unresolved.
2. **No Arc-capable facilitator** — `x402.org/facilitator` does not list
   `eip155:5042`. No self-hosted option implemented.
3. **EIP-3009 Circle signing unverified** — signing path for the Arc USDC domain
   not implemented/confirmed.
4. **Financial precision** — float `amount_within_max` must be replaced with the
   exact BigInt contract before any settlement.
5. **Persistent intent model** — Durable Object lock + idempotency not implemented.

**NON-NEGOTIABLE:** x402 payments remain disabled. No settlement, no signing, no
broadcast, no deploy.
