# Capital Hub Phase 1.0.1B — Gateway Atomic Execution & Final Security Enforcement

> Continuation of `work/capital-hub-phase-1.0.1` (base `9bbab1f`). Surgical fixes for
> the audit gaps: authoritative response classification, transferId restoration, and
> mainnet/testnet isolation.

## Gate results

### Gate A — Baseline (PASS)
HEAD `9bbab1f`; working tree clean. Reconfirmed consumers (`saExecGateway`,
`execSend`, `saDispatchSend`, `ubGwDepExecute`), the hardened proxy (`transfer.js`),
and the salt-keyed Durable Object (`gateway-op-lock.do.js`).

### Gate B — Authoritative financial classification (FIXED)
The previous fix classified **any** HTTP 503 as "not submitted". But 503 is
ambiguous: it can be a DO/persistence failure **before** submission, or a Circle 5xx
**after** the POST (the proxy passes the Circle status through). Now the frontend
decides by the proxy's explicit `blocked:true` contract (set only when the salt could
not be reserved → no forward), and otherwise treats 5xx/429/408 as `ambiguous`.

### Gate C — Atomic coordination by depositor (BLOCKED — infrastructure)
`GatewayOpLock` keys by `idFromName(salt)`, deduplicating only the same salt. Cross-salt
dedup of the same financial intent (stable `idempotencyKey` + server-computed
`payloadHash`, coordinated by depositor+environment with monotonic fencing) requires a
**new Durable Object design and a new binding/namespace**. Per the mandate
("não alterar bindings reais, infraestrutura Cloudflare ou produção sem autorização"),
this is reported **BLOCKED** — no production infra was touched.

### Gate D — Persistence & transferId (FIXED)
`saExecGateway` restores `transferId` from the Circle response when present (array
item or `burnIntent.transferId`), never inventing one. Sensitive material (signature,
attestation) is not logged or stored in localStorage.

### Gate E — True financial confirmation (preserved)
The Phase 1.0.1A positive validation (only `receipt.status 1/0x1` → `confirmed`) is
unchanged. The active flow still uses `/confirm` server-side for terminal transitions.

### Gate F — Validation & isolation (FIXED)
- Mixed mainnet/testnet (source XOR destination testnet) is now **blocked** before
  signing/submission (`mainnet_testnet_mismatch`) — the previous `||` OR treated the
  whole transfer as testnet.
- BigInt scale (`10n ** BigInt(dec)`), `padEnd`, strict decimal validation, recipient
  EVM + zero-address checks preserved from 1.0.1/1.0.1A.

### Gate G — Behavioral tests
`tests/capital-hub-phase-1.0.1.test.js` extended to **19 assertions**: proxy routing,
testnet fallback, array attestation parsing, `blocked:true` vs ambiguous 503
classification, `transferId` restoration, and mainnet/testnet mismatch. (In-browser
closures with wallet/RPC deps; backend DO + `/confirm` already covered by the existing
gateway suite.)

### Gate H — App protection (PASS)
No UI/layout/navigation change; no financial, contract, fee, network, asset, or
production-config change. `GatewaySpendService` remains not activated; Capital Hub
native execution remains disabled.

## Tests & build
- `tests/capital-hub-phase-1.0.1.test.js` — **19 pass**.
- Gateway/Send/UB regression — **4 pre-existing failures unchanged** (`gateway-balance`
  UI6.3, `gateway-ub-fase29` EVM branch, `send-assets-mainnet-source` Arc RPC,
  `treasury-restoration`), plus the Windows-path `gateway-spend-service`. **Zero new.**
- `npm run build` — passes.

## Classification
**BLOCKED** for the full scope: Gate C (atomic coordination by depositor) is an
infrastructure change requiring a new DO design/binding and is intentionally deferred.
Gates B, D, F (and E from 1.0.1A) are **done and verified** — no Mainnet readiness is
declared from mocks; no real transactions were executed.

No merge/deploy.
