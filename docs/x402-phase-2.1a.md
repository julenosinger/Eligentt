# x402 Phase X402-2.1A — Financial Precision & Validation Hardening (Arc Mainnet)

> P0 financial-security hardening for x402 payments on Arc Mainnet (`eip155:5042`).
> Exact BigInt arithmetic + strict requirement validation + corrected Arc EIP-3009
> metadata. **No settlement, no signing, no broadcast, no deploy, no UI changes.**

## 1. Baseline and final HEAD

| | Commit |
|---|---|
| Initial HEAD (baseline) | `3b4cbe9` — `docs(x402): corrective mainnet certification — Arc EIP-3009 CONFIRMED + facilitator matrix` |
| Final HEAD (code) | `40e0957` — `feat(x402): exact BigInt financial precision + Arc EIP-3009 metadata (X402-2.1A)` |

Phase X402-2.0.1 (the corrective re-audit) was confirmed present at baseline via
`docs/x402-mainnet-certification-corrective.md`, which established:

- Arc USDC `0x3600000000000000000000000000000000000000` is **EIP-3009 compatible**
  on-chain (`DOMAIN_SEPARATOR` matches EIP-712 domain `USDC`/`2`/`5042`).
- Production facilitators exist (Circle Facilitator Service primary).

## 2. Exact files changed

Source (2):

- `functions/api/x402/_x402.mjs` — parsers, `validateRequirement`, `readFlags`,
  `DEFAULT_MAX_USD`, `USDC_DECIMALS`, `X402_NETWORKS['eip155:5042']`.
- `functions/api/x402/index.js` — removed timeout `|| 60` coercion in `handlePrepare`.

Tests (9 — updated only where they hardcoded Arc EIP-3009 incompatibility; no
payment-safety assertion was weakened):

- `tests/x402.test.js` — Arc `eip3009Compatible` → `true`; new "exact financial
  precision (BigInt)" suite (parsers + cap + timeout rejection).
- `tests/x402-arc-certification.test.js` — Arc flag + cap-as-string assertions.
- `tests/x402-send-assets.test.js` — Arc flag + status table assertion.
- `tests/x402-send-assets-phase11.test.js`, `phase12`, `phase121`, `phase123`,
  `phase125`, `phase126` — Arc `eip3009Compatible` assertions.

Docs (1):

- `docs/x402-phase-2.1a.md` — this report.

**Not modified:** `index.html` (SA_X402), Send Assets execution, SA-1/SA-1.1
precision, Swap/Bridge/CCTP/LI.FI/Circle Gateway/CPN/Treasury/Autonoma/Unified
Balance/Scheduler/Recipients, token registry/logos, smart contracts, production
RPC settings, existing fees, wallet creation/auth.

## 3. Root cause of each correction

1. **Float financial comparison (P0).** `validateRequirement` converted the atomic
   amount to a JS `Number` (`Number(amountBig) / Math.pow(10, decimals)`) and
   compared `amountUsd <= maxUsd` with a float `maxUsd`. Float division is not
   exact for financial authorization and can drift at the cap boundary.
   → Replaced with exact BigInt comparison `amountAtomic <= maxUsdAtomic`.

2. **Non-canonical atomic parsing.** The old code did `BigInt(String(req.amount))`
   with a try/catch, which accepted `"1.5"`-like input only via `BigInt` rejection,
   but the surrounding logic still computed `amountUsd` before validating. It had
   no explicit rejection contract for sign/scientific/excess precision.
   → Replaced with `parseAtomicUnits` (strict `^\d+$`) and `parseDecimalUnits`
   (strict decimal-string contract).

3. **Authoritative cap as a JS number.** `DEFAULT_MAX_USD = 25` (number) and
   `readFlags` did `Number(env.X402_MAX_USD)`, allowing silent coercion/rounding.
   → Migrated to decimal string `DEFAULT_MAX_USD = '25'`; `readFlags` parses
   `X402_MAX_USD` exactly and fails closed to the default on any invalid value.

4. **Invalid timeout silently became 60s.** Both `normalizePaymentRequired` and
   `index.js handlePrepare` coerced `Number(req.maxTimeoutSeconds) || 60`, so a
   malformed timeout was silently accepted as 60s.
   → Removed the `|| 60` coercion; `validateRequirement` now rejects non-integer /
   non-positive / >3600 timeouts via `Number.isInteger`.

5. **Arc EIP-3009 flagged false.** `X402_NETWORKS['eip155:5042'].eip3009Compatible`
   was `false`, contradicting the confirmed on-chain evidence in the corrective
   report. → Flipped to `true` (token capability ≠ settlement availability).

## 4. Before / after behavior

| Concern | Before | After |
|---|---|---|
| Cap comparison | `Number(amountBig)/1e6 <= Number(maxUsd)` (float) | `parseAtomicUnits(amount) <= maxUsdAtomic` (BigInt) |
| `DEFAULT_MAX_USD` | `25` (number) | `'25'` (decimal string) |
| `readFlags().maxUsd` | `number` | `decimal string` + `maxUsdAtomic: bigint` |
| Amount `"0.0000001"` (7dp) | not applicable to atomic path | rejected (excess precision) |
| Amount `"1e6"` / `"-1"` | `BigInt` throws → caught → invalid | rejected by strict regex |
| Timeout `"abc"` / `0` / `3601` | `|| 60` → silently 60s | rejected (invalid) |
| Arc `eip3009Compatible` | `false` | `true` (confirmed on-chain) |

## 5. BigInt parsing contract

```js
// _x402.mjs
export function parseDecimalUnits(str, decimals) // decimal string → BigInt atomic
export function parseAtomicUnits(str)            // canonical atomic string → BigInt
export const DEFAULT_MAX_USD = '25';
export const USDC_DECIMALS = 6;
```

`parseDecimalUnits(str, decimals)`:

- Input: a decimal string and a token decimal count (`0..77`).
- Returns `BigInt` atomic units, or `null` on invalid input.
- Rejects: `null`/`undefined`, empty/whitespace, `NaN`, `Infinity`, negatives,
  scientific notation (`1e3`), multiple decimal points, excess decimal precision,
  unsupported decimal counts.
- Never rounds or truncates. Never goes through `Number`/`parseFloat`.

`parseAtomicUnits(str)`:

- Input: a canonical, positive, unsigned integer string (already atomic units).
- Returns `BigInt`, or `null` on invalid input.
- Rejects: sign (`-1`), decimal point (`1.0`), scientific (`1e6`), hex (`0x10`),
  empty, `null`. Trims surrounding whitespace.

Examples (USDC, 6 decimals):

| Input | Result |
|---|---|
| `"1"` | `1000000n` |
| `"1.25"` | `1250000n` |
| `"0.000001"` | `1n` |
| `"25"` | `25000000n` |
| `"0.0000001"` | `null` (reject) |
| `"1e3"` | `null` (reject) |
| `"-1"` | `null` (reject) |
| `"1.2345678"` | `null` (reject) |

The authoritative comparison is exact: `amountAtomic <= maxAmountAtomic`.
`amountUsd` remains a `Number` for **display/backward-compat only**
(`shared/x402Client.js` uses `Math.round(amountUsd * 1e6)`; tests use
`toBeCloseTo`).

## 6. Arc compatibility metadata

```js
'eip155:5042': Object.freeze({ chainId: 5042, label: 'Arc Mainnet', testnet: false, eip3009Compatible: true }),
```

USDC `0x3600000000000000000000000000000000000000`, 6 decimals, EIP-712 domain
`name="USDC"`, `version="2"`, `chainId=5042` — confirmed on-chain in
`docs/x402-mainnet-certification-corrective.md`.

**Token capability ≠ settlement availability.** The flag only records that the
canonical USDC implements EIP-3009. Settlement stays independently gated (below).

## 7. Preserved settlement gates

All kept fail-closed:

- `SETTLEMENT_IMPLEMENTED = false` (unchanged).
- `X402_ENABLED` defaults to `false` (`readFlags`).
- `POST /api/x402/pay` still returns HTTP 503 (fail-closed; no settlement).
- `settlementAvailable()` in Send Assets untouched (`index.html` not modified).
- No EIP-3009 signing, no facilitator `/verify`/`/settle`, no broadcasts, no new
  payment authorization, no automatic execution.

API contracts for `/status`, `/discover`, `/prepare`, `/pay` are preserved
(`maxUsd` in `/status` is now a decimal string; the client renders it as `$<v>`).

## 8. Test results

Focused suites (all green except the single pre-existing failure below):

| Suite | Result |
|---|---|
| x402 (12 files: `x402`, `x402-arc-certification`, `x402-client`, `x402-send-assets`, `phase11/12/121/122/123/124/125/126`) | **321 passed / 1 pre-existing failed** |
| `tests/send-assets-precision.test.js` | 29 passed |
| `tests/per-user-circle-wallet.test.js` + `tests/circle-wallet-identity.test.js` | 41 passed |
| Production build (`npm run build`) | success (22.3s) |

New precision tests added in `tests/x402.test.js` (exactness contract of §5):
exact 6-decimal conversion, minimum atomic unit, max authorized amount, one
atomic unit above max, zero/negative, scientific, excess precision, large
integers, malformed atomic strings, invalid timeout rejection, cap fail-closed.

## 9. Existing failures vs new failures

- **New failures: ZERO.**
- **Pre-existing (confirmed at baseline `3b4cbe9` via a clean worktree run):**
  `tests/x402-send-assets-phase126.test.js` →
  `patch replaces settlementAvailable body in memory without touching disk`
  (`expect(patched).toContain('__testSettlement')`). Root cause is a
  string-match brittleness: the `REAL_SA_BODY` template literal in the test does
  not byte-match `index.html`'s `settlementAvailable()` (leading indentation and
  CRLF vs LF line endings). `index.html` and the `patchSrc`/`REAL_SA_BODY` logic
  are untouched by this phase. Out of scope to fix here.

## 10. Remaining blockers for X402-2.1B

1. **Circle Wallet EIP-712 signing on the Arc USDC domain** — not yet confirmed;
   signing path must be validated before any settlement wiring.
2. **Facilitator `/verify` + `/settle`** — not implemented; needs a production
   facilitator integration (Circle Facilitator Service primary).
3. **Transaction broadcast / authorization flow** — no signing, no broadcast.
4. **Production enablement** — flip `X402_ENABLED` and `SETTLEMENT_IMPLEMENTED`
   only after 1–3 are complete and certified.

This phase does **not** claim production payment readiness.
