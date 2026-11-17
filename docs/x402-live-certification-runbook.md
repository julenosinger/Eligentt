# x402 Controlled Mainnet Certification Runbook (X402-2.1D.2B)

> **DOCUMENTATION ONLY.** This runbook describes the future operator-controlled
> live certification procedure. It is NOT executed in this phase, and no live
> authorization, settlement, transfer or broadcast is permitted without a
> separate, explicit owner authorization.

## 1. Prerequisites (all must be independently verified before any live step)

1. **Owner approval** — a signed, dated authorization from the project owner
   approving the exact scope below.
2. **Exact amount** — a single fixed atomic USDC amount (e.g. `1000000` = 1.00 USDC),
   never variable.
3. **Sender wallet** — the exact Circle developer-controlled wallet address that
   holds (or will hold) the test USDC.
4. **Recipient wallet** — the exact payout address.
5. **Token + network** — Arc USDC `0x3600…0000` on `eip155:5042`, decimals 6.
6. **Maximum acceptable fee/gas** — an operator-set ceiling.
7. **Balance check** — confirm the sender has at least `amount + fee` USDC.
8. **DO persistence verified** — `x402-intent-do-persistence.test.js` green.
9. **Facilitator capabilities verified** — `GET /v1/facilitator/x402/supported`
   returns Arc `exact`/`upto` with `0x3600…0000`.
10. **Signing verified** — the Circle `sign/typedData` flow returns a signature
    that locally recovers to the sender (Level 3, separately authorized).

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

A payment may be reported `SETTLED` only with all of:
correct chain, token, authorizer, recipient, exact atomic amount, nonce,
authorization fingerprint, a provider-confirmed transaction reference AND a
verified receipt (or documented provider finality) — with no contradictory
evidence.

> This runbook is not an authorization to execute. Live certification requires a
> future, separately-authorized phase.
