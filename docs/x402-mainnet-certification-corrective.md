# x402 Mainnet Certification — CORRECTIVE (Arc + Circle + Facilitator)

> Phase X402-2.0.1 — corrective re-audit of X402-2.0. Baseline `48627da`
> verified. Read-only; no payments, no broadcast, no code changes to the
> executor, no deploy.

## A. Executive verdict

**PARTIALLY VERIFIED** (upgraded from `BLOCKED` in X402-2.0).

The X402-2.0 verdict was **incorrect** on two points, both caused by flawed
methodology:

1. **Arc EIP-3009 was judged "incompatible" using WRONG function selectors.**
   `authorizationState` was probed with `0xe3ee160e` (which is actually
   `transferWithAuthorization`) and `eip712Domain` with `0x0a97c449` (which is
   not `eip712Domain`). A reverted call with a wrong selector proves nothing.

2. **The facilitator matrix only checked the dev facilitator** (`x402.org`),
   not production facilitators. Multiple production facilitators support Arc.

Corrected status: **Arc USDC is CONFIRMED EIP-3009 compatible** (on-chain, below)
and **production facilitators exist** (Circle Facilitator Service is primary).
The remaining uncertainty is Circle Wallet EIP-712 signing on the Arc USDC
domain — to be resolved in X402-2.1, not here.

## B. Arc USDC evidence (correct selectors)

RPC `https://rpc.mainnet.arc.io`, block `0x1e40dcf`, contract
`0x3600000000000000000000000000000000000000`.

| Probe | Selector | Result | Interpretation |
|---|---|---|---|
| `eth_chainId` | — | `0x13b2` = 5042 | ✅ chain confirmed |
| `eth_getCode` | — | 1,798 bytes | ✅ contract present |
| `decimals()` | `0x313ce567` | `6` | ✅ ERC-20 6 decimals |
| `name()` | `0x06fdde03` | `USDC` | ✅ |
| `symbol()` | `0x95d89b41` | `USDC` | ✅ |
| `DOMAIN_SEPARATOR()` | `0x3644e515` | `0x940506929bba468048a19b567f4f0d534714bc06604b5c3017e5d16785ccdf84` | ✅ EIP-712 present |
| `authorizationState(0,0)` | `0xe94a0102` | `0x0` (false) | ✅ EIP-3009 present |
| `nonces(0)` | `0x7ecebe00` | `0x0` | ✅ (nonce state) |
| `eip712Domain()` | `0x84b0196e` | `execution reverted` | ⚠️ ERC-5267 optional — NOT proof of absence |
| `allowance(0,0)` | `0xdd62ed3e` | `0x0` | ✅ ERC-20 |

**Domain separator match (DEFINITIVE):** computing
`keccak256(EIP712Domain("USDC","2",5042,0x3600…0000))` with ethers v6 yields
`0x940506929bba468048a19b567f4f0d534714bc06604b5c3017e5d16785ccdf84` — **exactly
equal** to the on-chain `DOMAIN_SEPARATOR()`.

**Conclusion (CONFIRMED ON-CHAIN):** Arc USDC implements EIP-3009
(`transferWithAuthorization`) with EIP-712 domain `name="USDC", version="2",
chainId=5042`, matching `TRUSTED_ASSETS['eip155:5042']`.

## C. Documentation cross-check

- **Arc docs (CONFIRMED BY OFFICIAL DOCUMENTATION):** `0x3600…0000` is "Circle
  FiatToken v2 with full EIP-3009 support"; domain `USDC`/`2`; "USDC on Arc is a
  native precompile — it implements EIP-3009 natively. EIP-2612 permit() is not
  supported." Two interfaces: native 18 decimals (gas) + ERC-20 6 decimals.
- **Circle docs (CONFIRMED):** Facilitator Service supports Arc `eip155:5042`,
  USDC `0x3600…0000`, schemes `exact` + `upto` (Permit2).
- **On-chain (CONFIRMED ON-CHAIN):** matches both — domain separator identical,
  `authorizationState`/`nonces` present, 6 decimals.
- **Discrepancy:** none material. `eip712Domain()` reverts (ERC-5267 not
  implemented) but this is optional and does not contradict EIP-3009 (which uses
  `DOMAIN_SEPARATOR()`).

## D. Facilitator matrix (production)

| Provider | Endpoint | Arc `eip155:5042` | Scheme | Evidence |
|---|---|---|---|---|
| **Circle Facilitator Service** | (Circle API, keyed) | ✅ | `exact`, `upto` (Permit2) | Circle docs, 2026-11 |
| **Arclight** | `https://x402.arclight.finance` | ✅ | `exact` (USDC+EURC) | docs, 2026-11 |
| **Aeron** | `https://x402.aeron.sh` / `x402-arc.aeron.sh` | ✅ | `exact` | `/status` shows Arc rail enabled |
| **MeshGateway** | `https://facilitator.meshgateway.co` | ✅ | `exact` (EIP-3009) | docs, 2026-11 |
| **TRDEFI Arc Facilitator** | `https://trdefi-arc-facilitator.netlify.app` | ✅ | `exact` | github + `/supported` |
| **Agent402** | agent402.tools | ✅ (via Circle) | `exact` | docs, daily canary |
| x402.org (dev) | `https://x402.org/facilitator` | ❌ | — | dev/testnet only |

**Recommended:** Circle Facilitator Service (official, hosted, Arc `exact` +
`upto`, on-chain settlement via Circle relayer). Alternatives available.

## E. Permit2 feasibility

- **Deployed on Arc** (Circle `upto` scheme): Permit2
  `0x000000000022D473030F116dDEE9F6B43aC78BA3`; x402 Permit2 proxy
  `0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002`.
- **Feasibility:** viable for `upto` (max-amount) payments; requires the buyer to
  approve/sign a Permit2 authorization. Not needed for `exact` (EIP-3009).

## F. Gateway / Nanopayments feasibility

- Circle offers **Gateway Nanopayments** (batched signed authorizations,
  off-chain aggregated settlement into a Gateway balance) for sub-cent payments.
- Not interchangeable with normal Gateway `transfer` — different authorization
  (`GatewayWalletBatched`). Out of scope for `exact`; candidate for micro-payments
  in a later phase.

## G. Circle Wallet signing

- Custodial per-user Circle Wallet supports **EIP-712 `signTypedData`** (relayer
  auth, `tests/sign-typeddata.test.js`).
- **Unverified:** signing the **Arc USDC EIP-3009 domain** (`USDC`/`2`/5042) with
  the per-user wallet; whether `signTypedData` accepts an arbitrary domain and
  whether the recovered signer equals the wallet address on Arc.
- No platform-wallet fallback; no new wallet. To be verified in X402-2.1 with an
  authorized, controlled signature (not here).

## H. Financial precision (exact contract)

X402-2.0 proposed `BigInt(Math.round(maxUsd * 10 ** decimals))` — **still float.**
Correct contract (no `Number`/`parseFloat`/`Math.round`):

```js
// decimal-string → BigInt (exact, rejects malformed/negative/scientific/excess)
function parseExactUnits(str, decimals) {
  const s = String(str).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [i, f = ''] = s.split('.');
  if (f.length > decimals) return null;      // excess precision → reject
  return BigInt(i + f + '0'.repeat(decimals - f.length));
}

// config max cap is a DECIMAL STRING (e.g. "25"), not a float
const maxUsdAtomic = parseExactUnits(MAX_USD_STRING, decimals); // 25 → 25000000n
// amount is an integer atomic-units string
const amountAtomic = BigInt(amountStr.trim());
const withinMax = amountAtomic > 0n && amountAtomic <= maxUsdAtomic;
// display only (never authoritative): amountAtomic / 10n**decimals (BigInt)
```

This mirrors the already-shipped Send Assets `_saParseUnitsExact`. Applied to
x402 in X402-2.1 (the live `validateRequirement` currently still uses
`Number(amountBig)/10^dec` for `amount_within_max`).

## I. Intent & idempotency design

Current `requirementId()` uses **FNV-1a** — a non-cryptographic fingerprint,
acceptable only as a REQUIREMENT fingerprint, never as a payment-attempt ID.

Future model (X402-2.1):
- `requirementFingerprint` = canonical digest (SHA-256 of
  scheme|network|asset|amount|payTo|resourceUrl|timeout) — identifies the offer.
- `intentId` = cryptographically random UUIDv4 (per payment attempt).
- Bindings: authenticated userId, Circle walletAddress, resourceUrl, network,
  asset, amount (atomic BigInt), payTo, expiration (maxTimeoutSeconds), nonce.
- Durable Object lock keyed by `intentId` (and by `(authorizer, nonce)` for
  EIP-3009 replay prevention); idempotency; settlement evidence (tx hash +
  chainId); reconciliation status.

## J. Recommended architecture

**Primary: Circle Facilitator Service, `exact` scheme, EIP-3009 on Arc.**

```
HTTP 402 → discover (SSRF-guarded) → prepare (server-side validate + Circle wallet)
        → intent (persistent, Durable Object lock, random intentId)
        → sign (Circle signTypedData, USDC/2/5042 EIP-3009 domain)
        → facilitator /verify + /settle (Circle relayer broadcasts transferWithAuthorization)
        → reconcile (tx hash + status)
```

Alternatives: Arclight / Aeron / MeshGateway / TRDEFI facilitators;
self-hosted facilitator (MIT, single Worker) as fallback; Gateway Nanopayments
for future micro-payments.

## K. Implementation contract for X402-2.1

1. Flip `X402_NETWORKS['eip155:5042'].eip3009Compatible` to `true` (evidence now
   confirmed). Keep `SETTLEMENT_IMPLEMENTED = false` until the pay path ships.
2. Implement exact BigInt `validateRequirement` (decimal-string max cap).
3. Add `X402_FACILITATOR_URL` (override; default Circle or Arclight).
4. Verify Circle `signTypedData` on the Arc USDC domain (controlled test).
5. Persistent intent (Durable Object) + replay/idempotency guards.
6. Wire `/verify` + `/settle` through the chosen facilitator.
7. Only then flip `SETTLEMENT_IMPLEMENTED` (and `X402_ENABLED`) under explicit
   authorization.

## L. Regression results

- Initial HEAD `48627da`; final HEAD recorded on commit.
- Changed files: this doc + certification tests only.
- x402 suites: `x402.test.js` 33, `x402-client.test.js` 7,
  `x402-send-assets.test.js` 63, `x402-arc-certification.test.js` 6 → all pass;
  no new failures.
- No production code modified; `SETTLEMENT_IMPLEMENTED = false`, `X402_ENABLED`
  off, `/api/x402/pay` fail-closed all preserved.

## Remaining blockers for X402-2.1

1. Circle Wallet `signTypedData` on the Arc USDC EIP-3009 domain — **UNVERIFIED**
   (requires authorized controlled signing).
2. Live facilitator `/settle` integration + API-key setup — not yet wired.
3. Financial-precision correction in `validateRequirement` — specified, not applied.
4. Persistent intent/replay model — specified, not implemented.
