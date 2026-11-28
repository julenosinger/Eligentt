# Gateway Send 3.1.1 — P0 Root Cause: "Failed to fetch"

> Investigation-only report. No real transfer, no merge, no deploy.

## 1. Current Git state

| | Value |
|---|---|
| `main` HEAD | `6024d2e` (Phase 3.0 final) |
| `fix/gateway-send-3.1` HEAD | `6b1250e` (Phase 3.1 routing) |
| PR #1 | **OPEN, not merged** (`mergeCommit: null`) |
| Deployed at `elligentttest.pages.dev` | **UNVERIFIED** — Cloudflare Pages deploys `main` (production branch), so the deployed version is most likely `6024d2e` (Phase 3.0, which still posts directly to Circle). |

## 2. Confirmed root cause — CONFIRMED

**The deployed `saExecGateway` posts the Gateway transfer request directly to
`https://gateway-api.circle.com/v1/transfer` (cross-origin), but the application's
Content-Security-Policy (`connect-src` in `public/_headers`) does NOT include
`gateway-api.circle.com`. The browser therefore blocks the request, and `fetch()`
rejects with `TypeError: Failed to fetch`.**

Evidence:

1. `public/_headers` `connect-src` allows `https://api.circle.com` and
   `https://iris-api.circle.com` (and various RPC endpoints) but **NOT**
   `https://gateway-api.circle.com`.
2. `git log -S "gateway-api.circle.com" -- public/_headers` → **no commits ever
   added it** — the Gateway API domain has never been CSP-allowlisted.
3. Circle's Gateway API does allow CORS (`Access-Control-Allow-Origin: *`,
   verified with a read-only OPTIONS preflight), so CORS is NOT the cause — the
   block is the app's own CSP, which is enforced client-side before the request
   leaves the browser.
4. The historical transaction `0xdb1b6ae8…` is a **successful `gatewayMint`**
   (`0x9fb01cc5`) to the GatewayMinter `0x2222222d…C205` on Arc (`0x13b2`=5042),
   `status 0x1` — confirming Gateway mints worked at some point (likely before the
   CSP was applied to that environment, or via a different routing).

## 3. Why "Sign in wallet — failed" is misleading

The Unified Balance `execSend` sets the step label to `Sign in wallet…` **before**
calling `saExecGateway()`. `saExecGateway()` signs (Rabby) then performs the
`fetch()`. The CSP-blocked fetch throws, `saExecGateway`'s catch returns
`{ status: 'error', error: 'Failed to fetch' }`, and the UI then labels the step
`Failed to fetch` / failed — but the user perceives it as a signing failure. The
signature itself is not the problem; the subsequent network POST is.

## 4. Evidence excluding alternative hypotheses

- **Not Rabby/extension:** the failure is a CSP-blocked `fetch`, not a wallet
  `eth_signTypedData_v4` rejection (which would surface as `4001`/`User rejected`).
- **Not CORS:** Circle Gateway returns `Access-Control-Allow-Origin: *`.
- **Not Circle reachability:** `gateway-api.circle.com` is reachable (OPTIONS 204).
- **Not a Durable Object unavailability:** a missing DO binding would surface as an
  HTTP 503 from the proxy, not a browser `Failed to fetch`.
- **Not a balance-shape regression (Phase 3.0):** `saExecGateway` (index.html) does
  not call `GatewaySpendService.fetchGatewayBalance`; it has its own direct POST.
  The Phase 3.0 changes to `shared/GatewaySpendService.js` do not affect this path.

## 5. Corrective action

The fix already exists on PR #1 (`fix/gateway-send-3.1`, `6b1250e`): route the
mainnet transfer through the Cloudflare proxy `/api/gateway/transfer` (same-origin
= `'self'`, which IS CSP-allowed). This both eliminates the `Failed to fetch` and
restores the Durable Object salt reservation before Circle submission.

Required to restore the transfer:

1. **Merge PR #1** (`fix/gateway-send-3.1`) — routes `saExecGateway` through the
   proxy for mainnet. (Testnet still posts directly to the Circle testnet API for
   dev only.)
2. **Configure Cloudflare Pages environment** for the proxy to forward:
   - `GATEWAY_OP_LOCK` Durable Object binding (separate Worker).
   - `DO_INTERNAL_SECRET`.
   - `GATEWAY_RPC_URLS` (JSON map chainId→rpcUrl) for `/confirm`.
   Without these the proxy fails **closed** (HTTP 503), which is a *different*,
   safe error — not `Failed to fetch`.

Do **not** add `gateway-api.circle.com` to the CSP `connect-src` as the fix — that
would re-enable the direct-submit bypass that Phase 3.1 intentionally closes.

## 6. Severity

**P0** — financial execution path is blocked (fail-closed) by the CSP; no funds are
at risk, but the transfer cannot proceed until the proxy routing (PR #1) is merged
and the Cloudflare bindings are provisioned.

## 7. Safe manual verification procedure (requires explicit user approval)

1. Merge PR #1 and configure the CF bindings above.
2. Read the Gateway USDC balance (Unified Balance) for the connected wallet.
3. Attempt a small (0.01 USDC) mainnet send from Gateway source; confirm the
   browser network tab shows `POST /api/gateway/transfer` (not `gateway-api.circle.com`).
4. Sign with Rabby, receive the attestation, execute `gatewayMint`, and confirm via
   `/api/gateway/transfer/confirm` (on-chain salt binding) before reporting success.

## 8. Files changed

- `docs/gateway-send-phase-3.1.1-root-cause.md` (this report).
- `tests/gateway-csp-proxy.test.js` (new regression test: CSP excludes the direct
  Gateway domain and the protected proxy path is `'self'`).

No functional module was modified.
