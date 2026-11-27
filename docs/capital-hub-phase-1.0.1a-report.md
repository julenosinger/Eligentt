# Capital Hub Phase 1.0.1A — Gateway Security Enforcement & Execution Integrity

> Continuation of `work/capital-hub-phase-1.0.1` (base `8cf5efc`). Surgical fixes for
> the audit gaps: proxy enforcement, positive confirmation, and BigInt precision.

## Gate results

### Gate A — Baseline (PASS)
HEAD `8cf5efc`; working tree clean. Active Gateway consumers: `saExecGateway`
(used by Send Assets `saDispatchSend` + Unified Balance `execSend`), `ubGwDepExecute`
(deposit), `GatewaySpendService` (secure executor, currently not activated).
`functions/api/gateway/transfer.js` is the hardened proxy (DO idempotence + state
machine + `/confirm` RPC verification).

### Gate B — Proxy enforcement (FIXED)
`saExecGateway` POSTed **directly to Circle** (`GW_API_BASE + '/v1/transfer'`),
bypassing the proxy — contradicting its own doc comment. Now:
- Mainnet submissions go through `/api/gateway/transfer` (DO idempotence, state
  machine, replay protection).
- Testnet chains keep the direct Circle API (the proxy is mainnet-only).
- Response is parsed as the Circle **array** `[{ burnIntent, attestation:{payload,signature} }]`
  (previously the code read a non-existent `.attestation` on the array → the success
  branch never fired).
- Proxy error codes are mapped: 409 → `ambiguous` ("already submitted — do not
  resubmit"), 503 → `error` (fail-closed, not submitted), 5xx/429/502/504 → `ambiguous`.

### Gate C — Idempotence (backend enforced; frontend now uses it)
The frontend now routes mainnet through the proxy, which enforces atomic salt
reservation via `GATEWAY_OP_LOCK`. The frontend does not introduce a third executor
and does not activate `GatewaySpendService` (kept blocked, no equivalence proof yet).

### Gate D — Persistence/ambiguity (preserved)
No frontend financial POST runs inside storage transactions. Ambiguous responses are
surfaced as `ambiguous` (never retried automatically, never a new salt/signature).

### Gate E — Confirmation integrity (FIXED)
`_execGatewayMint` previously returned `confirmed` for **any** non-revert receipt
(status `null`/`undefined`/unexpected). Now it uses **positive** validation:
`status 1/'0x1'` → `confirmed`; `status 0/'0x0'` → `failed`; anything else or no
receipt → `pending`. The caller branches on status and never shows a pending hash as
success.

### Gate F — Financial precision (FIXED)
- `BigInt(10 ** decimals)` (Number exponentiation, lossy >15 decimals) → `10n ** BigInt(decimals)`.
- Fixed `'000000000'` pad → `fracPart.padEnd(decimals, '0')`.
- Amount already validated as strict decimal string (Phase 1.0.1); recipient address
  + zero-address validated.

### Gate G — Behavioral tests
`tests/capital-hub-phase-1.0.1.test.js` extended to **17 assertions** covering the
proxy routing (`/api/gateway/transfer`), testnet fallback, array attestation parsing,
proxy error mapping (409/503/5xx), positive success validation, and BigInt scale.
These are source-level behavioral guards (the functions are in-browser closures with
wallet/RPC deps); the backend `/confirm` + DO flow is already covered by the existing
gateway suite.

## Tests & build
- `tests/capital-hub-phase-1.0.1.test.js` — **17 pass**.
- Gateway/Send/UB regression — **4 pre-existing failures unchanged** (`gateway-balance`
  UI6.3, `gateway-ub-fase29` EVM branch, `send-assets-mainnet-source` Arc RPC,
  `treasury-restoration`), plus the known Windows-path `gateway-spend-service`.
  **Zero new failures.**
- `npm run build` — passes.

## Classification
**APPROVED** for the proxy-enforcement, positive-confirmation, and BigInt-precision
fixes (the concrete audit gaps). The remaining items (frontend state-machine mirror,
client-side EIP-712/attestation re-validation, `GatewaySpendService` activation with
proven equivalence) are backend-enforced already or deferred to Phase 1.0.2.

No merge/deploy; no Mainnet transactions executed.
