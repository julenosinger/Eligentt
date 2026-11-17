# Send Assets Regression Contract

> **Status: ENFORCED.** Any change to Send Assets, Swap, Bridge, Gateway, CPN,
> x402, Recipients, or bundling MUST preserve this contract. Enforced by
> `tests/send-assets-precision.test.js` (and the broader Send/Balance suites).

## 1. Functional contracts (must not break)

- **Wallet Send** (same-chain) — Arc Mainnet + EVM chains.
- **Cross-chain** — Arc → Base/Arbitrum/Optimism/Ethereum/Polygon (CCTP primary,
  LI.FI fallback).
- **Circle Gateway** (BurnIntent EIP-712).
- **CPN / Send to Bank** — button stays visible; auth, OFI onboarding, canonical
  USDC contract and calldata validation preserved.
- **x402** — session token, mutex, listener dedup, stale-success/error guards.

## 2. Financial invariants

- **Exact decimal → BigInt conversion** in `saToRaw()`. NO floating point
  (`parseFloat`/`Math.pow(10, dec)`/`Math.round`) for signed amounts.
- Decimals: USDC 6, EURC 6, cirBTC 8, native ETH 18.
- Arc native USDC gas (18-dec native layer) is distinct from the ERC-20 interface
  at `0x3600…0000` (6 decimals). Never merge them.
- Fee = `(rawAmt * feeBps) / 10000n` (BigInt). Recipient gets `rawAmt`; the
  Treasury Vault gets `feeRaw`. Never substitute the recipient with an operator
  or intermediate contract.
- Never silently truncate or round a financial value; excess precision is rejected.

## 3. Security invariants

- `SendGuard` validations preserved (ERC-20 token, spender, recipient).
- Recipient: valid EVM address, never zero, resolved from Recipients before
  signing, used verbatim in calldata and review.
- Chain/token/gas must match the selected network; RPC failure is never a fake
  zero nor a false positive. Send stays blocked when validation is indeterminate.

## 4. Concurrency / stale-response invariants

- Request ID / session token / mutex guards: an old op must not unlock a new op,
  an old result must not update the current wallet, double-click must not submit
  twice, network switch invalidates incompatible execution data, disconnect drops
  confirmation, reopen does not duplicate listeners.

## 5. Execution / reconciliation invariants

- `idle → validating → awaiting_signature → submitting → pending → confirmed/failed/unknown`
  (per-executor). Sent ≠ confirmed; timeout ≠ on-chain failure; a receipt is bound
  to its op; success requires the flow's evidence; no auto-retry of ambiguous ops;
  hash/chainId/identifiers preserved for recovery.

## 6. Gateway / CPN / x402 invariants

- Gateway: BurnIntent EIP-712, depositor-bound signature, unique salt, replay
  protection, locks, token/network validation, concurrency control, wallet vs
  Gateway balance separation.
- CPN: visibility preserved; authentication; chainId validation; canonical USDC
  contract; approved recipient; exact amount; calldata validation; on-chain
  confirmation ≠ bank settlement.
- x402: `SETTLEMENT_IMPLEMENTED` must stay `false` until settlement is actually
  implemented — never flipped to make tests pass.

## 7. Mandatory tests

- `tests/send-assets-precision.test.js` — exact conversion, precision/excess,
  invalid/scientific/negative inputs.
- Existing Send/Balance suites.

Run:

```bash
npx vitest run tests/send-assets-precision.test.js
```

## 8. Approval criteria for future changes

A change to the above modules is acceptable only if it: (a) is minimal and
reversible, (b) documents the affected consumers, (c) passes the mandatory tests,
and (d) introduces zero new regressions in Swap, Bridge, Gateway, CPN, x402,
Autonoma, Recipients, Unified Balance and Schedule.
