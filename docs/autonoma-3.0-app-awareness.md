# Autonoma 3.0 — Unified App Awareness & Read-Only Intelligence

> Read-only phase: Autonoma now understands the Elligentt module ecosystem and can
> securely retrieve the authenticated user's own data (contacts, balances,
> transactions, queue, invoices, payment links) and answer conversationally through
> DeepSeek, OpenAI or Claude. Existing financial execution is unchanged.

## 1. Repository state

| Item | Value |
|---|---|
| Baseline | `origin/main` @ `4c442e0` (Autonoma 2.3) |
| Branch | `feat/autonoma-3.0-app-awareness` |
| Final | *(this commit)* |

## 2. Module capability inventory

| Module | Purpose | Read tools | Implemented | Data source |
|---|---|---|---|---|
| Recipients / Contacts | Saved contacts (name/address/network) | `contacts.list`, `contacts.search`, `contacts.get` | ✅ P0 | client (localStorage) |
| Unified Balance | Circle Agent Wallet balances | `balance` | ✅ | Circle W3S API (server) |
| Transaction History | Recent txs + status | `history` | ✅ | Circle W3S API (server) |
| Circle Agent Wallet | Canonical agent identity | `wallet_info` | ✅ | Circle W3S API (server) |
| Queue | Pending execution queue | `queue.list` | ✅ | client (ExecutionQueue) |
| Invoices | Invoices | `invoices.list` | ✅ | client (localStorage) |
| Payment Links | Payment links | `paymentLinks.list` | ✅ | client (localStorage) |
| Schedule | Scheduled/recurring payments | `schedule.list` | ⚠️ metadata only | client (not wired) |
| Swap / Bridge / Liquidity / RWA / Tax / Treasury | — | `*.getSupported*`, `*.listPositions`, … | ⚠️ metadata only | — |

> Unimplemented modules are exposed as **accurate capability metadata** — the model
> is never given fabricated data or speculative APIs.

## 3. Implemented read-only tools

**Server-side (Circle Agent Wallet, per-user):** `balance`, `history`, `wallet_info`
resolve the authenticated user's wallet from `AUTH_KV` (`user:{email}`) and read via
`env.CIRCLE_API_KEY`. No wallet → explicit `needsProvision` (never a fake balance).

**Client-side (localStorage, bridged in the browser):** `contacts.list`,
`contacts.search`, `contacts.get`, `queue.list`, `invoices.list`, `paymentLinks.list`.

## 4. Architecture

```
Autonoma Chat → Selected Provider → Orchestrator (generate loop)
  → Trusted Tool Registry (server-owned defs)
  → Read executor (server-read: Circle W3S; client-read: returned to frontend)
  → Authorized user data → conversational response
```

- **Bounded loop** (`chat.js` `runReadLoop`, max 4 iterations): the model calls
  server-read tools, receives structured results, and produces a grounded answer.
  Client-read + write tools are returned to the frontend (existing bridge/gate) and
  are never executed server-side.
- **Server-owned definitions** only; `resolveAuthorizedTools` validates names against
  the allowlist; no client-controlled tool defs; no model-executed code.
- **Anthropic compatibility**: `_toAnthropicMessages` converts assistant `tool_calls`
  and `tool` results to `tool_use` / `tool_result` content blocks so multi-step loops
  round-trip on Claude too.

## 5. Example tool-call flows

1. "Mostre meus contatos" → model → `contacts.list` (client-read) → frontend renders
   "Encontrei N contatos: …" from `RecipientResolver.all()`.
2. "Procure João nos meus contatos" → `contacts.search {query:"João"}` → frontend
   filters by name/address.
3. "Qual é meu saldo?" → `balance` (server-read) → Circle `/wallets/{id}/balances`
   → model answers "Seu saldo na Circle Agent Wallet é 500 USDC".
4. "Qual o endereço salvo para Maria?" → `contacts.get {name:"Maria"}` → exact/fuzzy.

## 6. Security validation

- Every user-specific tool request is authenticated (`requireSession`, fail-closed).
- Ownership enforced server-side (`user:{email}` → per-user `circleWalletId`).
- Inputs validated (tool name allowlist + JSON Schema, top-level `required`).
- No cross-user data leakage (balance resolves only the caller's wallet — tested).
- Read-only tools never write, never sign, never trigger approvals.
- No API keys / private keys / session tokens exposed to the model.
- No `eval` / `new Function` in the frontend bridge.

## 7. Tests & baseline comparison

- `tests/autonoma-3.0-app-awareness.test.js` (new) — **25 pass** (manifest, read-tool
  executor + ownership isolation, trusted registry, bounded loop, Anthropic
  tool_result, frontend bridge, read-only enforcement).
- AI suites (1.2.x hardening, multi-ai, phase1) — **pass** (113 tests).
- Regression (ai-first, timeline 2.2, receipt 2.3, wallet identity, no-wallet) —
  **pass**.
- Total re-run: **14 files, 203 pass**.
- `npm run build` — passes.
- Pre-existing failures (unchanged, verified against clean `origin/main`):
  `agent-capability-router` (3 — stale `public/index.html` `.das-*`),
  `autonoma-0-execution-gate` (1), `autonoma-1-execution-authority` (2 —
  `signer.signTransaction` in source), plus the previously-known
  `autonoma2.test.js` / `autonoma2-phase2a` / `autonoma-6b` / `autonoma-2-wallet-security`.

## 8. Files changed

- `functions/api/_ai/capabilities.js` (new) — App Capability Manifest.
- `functions/api/autonoma2/readTools.js` (new) — server read executor.
- `functions/api/_ai/trustedTools.js` — read tool definitions + prompt.
- `functions/api/_ai/providerRegistry.js` — Anthropic tool_result conversion.
- `functions/api/autonoma2/chat.js` — bounded read-tool loop.
- `index.html` — frontend client-read bridge (`_autReadSurface`).
- `tests/autonoma-3.0-app-awareness.test.js` (new).
- `docs/autonoma-3.0-app-awareness.md` (new).

## 9. Remaining risks

- **Streaming trade-off**: the read-tool path uses `generate()` (non-streaming) and
  returns the final answer as a single SSE chunk. The frontend already renders the
  full reply once (no incremental render), so this is not user-visible.
- **Client-side data is device-local**: contacts/queue/invoices/paymentLinks reflect
  the current browser's `localStorage`; a different device may show different data
  (matches existing app behavior).
- **Cross-module client+server reads** (e.g. "contacts + balance" in one turn) route
  through the server loop for server reads and the frontend bridge for client reads;
  a mixed single-turn result is handled by returning tool calls to the client.

## 10. Financial execution (unchanged)

No change to Send, Swap, Bridge, Circle Agent Wallet identity, signing, approval,
fees, reconciliation, Multisend or Scheduler. Read tools are strictly read-only and
never introduce new financial gates or blockers.
