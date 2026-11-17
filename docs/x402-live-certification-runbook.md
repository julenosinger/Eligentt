# x402 Controlled Mainnet Certification Runbook (X402-2.1D.2B → 2.1E)

> **DOCUMENTATION ONLY.** This runbook describes the future operator-controlled
> live certification procedure. It is NOT executed, and no live authorization,
> settlement, transfer or broadcast is permitted without a separate, explicit
> owner authorization.

## 0. Operator approval (new in 2.1E)

Live settlement additionally requires a cryptographically-authenticated operator
approval (`functions/api/x402/x402-approval.mjs`): a unique, HMAC-SHA256-signed,
one-time-use, revocable approval binding operator identity, chain, token, sender,
recipient, max atomic amount, fee ceiling, settlement attempt id, and expiry.
A feature flag or a general-purpose API key never authorizes payment; a
forged/tampered/expired/revoked/reused/mismatched approval is rejected.

## 1. Infrastructure prerequisites (all independently verified)

1. **Owner approval** — signed, dated authorization for the exact scope.
2. **Operator approval** — a valid `buildApproval(...)` for the exact attempt.
3. **Exact amount** — a fixed atomic USDC amount, never variable.
4. **Sender wallet** — exact Circle developer-controlled wallet.
5. **Recipient wallet** — exact payout address.
6. **Token + network** — Arc USDC `0x3600…0000` on `eip155:5042`, decimals 6.
7. **Maximum fee/gas** — operator-set ceiling (bound into the approval).
8. **Balance check** — sender ≥ amount + fee.
9. **DO persistence verified** — `x402-intent-do-persistence.test.js` green.
10. **Facilitator capabilities verified** — `/supported` returns Arc `exact` with `0x3600…0000`.
11. **Signing verified** — Circle `sign/typedData` recovers to the sender (Level 3).
12. **RPC certification** — `x402-rpc.mjs` `validateReceiptEvidence` green against a
    live Arc receipt (network access required). Read-only mainnet checks performed
    in 2.1F: `eth_chainId`=5042, USDC `eth_getCode`=1798 bytes,
    `authorizationState(0,0)` callable, latest block 31758224. Finality binding of
    an actual Elligentt payment remains future work.
13. **Authorization binding** — `validateAuthorizationBinding` requires the
    transaction input to decode to `transferWithAuthorization` with the exact
    nonce (and, when present, a matching `AuthorizationUsed` event); a plain
    ERC-20 transfer is never accepted as proof.

## 2. Step-by-step procedure

1. Enable (in a NON-production environment first) the persistence + signing +
   verification gates, with `X402_LIVE_SETTLEMENT_ENABLED=false`.
2. Create the payment intent for the approved amount / recipient / network.
3. Reserve the authorization nonce.
4. Sign the EIP-3009 `TransferWithAuthorization` via Circle and verify locally.
5. Record facilitator `/verify` (non-settling) and confirm `isValid`.
6. Acquire the atomic settlement claim and transition to `SUBMITTING`.
7. **Only with a second explicit owner authorization**, submit `/settle` and
   capture the provider reference/transaction hash.
8. Reconcile via `/status` + on-chain `authorizationState`; only mark `SETTLED`
   when a provider-confirmed transaction + receipt bind the exact terms.

## 3. Monitoring & reconciliation

- Track the attempt in the settlement ledger (`SUBMITTING → SETTLEMENT_UNKNOWN →
  SETTLED|FAILED`).
- Never auto-retry an ambiguous (`SETTLEMENT_UNKNOWN`) attempt.
- On any lost-response/timeout, reconcile before any further action.

## 4. Emergency stop

- Set `X402_LIVE_SETTLEMENT_ENABLED=false` and `X402_SIGNING_ENABLED=false`
  (and `X402_ENABLED=false`) immediately; these gates are fail-closed by design.
- Do not release the nonce reservation or settlement claim.

## 5. Incident response

- Preserve the durable intent, settlement ledger and evidence (never delete).
- Reconcile via read-only RPC + facilitator `/status`.
- Escalate any contradictory evidence (the ledger rejects silent overwrites).

## 6. Final evidence requirements

A payment may be reported `SETTLED` only with ALL of: correct chain, token,
authorizer, recipient, exact atomic amount, nonce, authorization fingerprint, a
provider-confirmed transaction reference AND a verified receipt whose `Transfer`
event binds the exact terms (or documented provider finality), with `confirmations`
meeting policy and no contradictory evidence. `authorizationState=true` alone is
insufficient.

> This runbook is not an authorization to execute. Live certification requires a
> future, separately-authorized phase.
