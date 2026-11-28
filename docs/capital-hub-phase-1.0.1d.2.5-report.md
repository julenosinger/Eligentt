# Capital Hub Phase 1.0.1D.2.5 — Cloudflare Infrastructure Deployment

> Continuation of `work/capital-hub-phase-1.0.1` (base `4be152d`). Infrastructure
> deployment phase.

## Classification
**INFRASTRUCTURE BLOCKED** — no Cloudflare access in this environment. The exact
Worker configuration has been prepared (ready for a single `wrangler deploy`), but
deployment cannot be executed without authorization.

---

## ETAPA 1 — Access verification (result)

- `npx wrangler whoami` → **"You are not authenticated. Please run `wrangler login`."**
- `CLOUDFLARE_API_TOKEN` → **not set**
- `CLOUDFLARE_ACCOUNT_ID` → **not set**
- `CF_API_TOKEN` → **not set**
- No local `.wrangler` auth state (only `tmp/`).

**No Cloudflare account access, no API token, no project access.** Per the mandate
("Nunca solicitar credenciais diretamente no chat ou armazená-las no Git"), I did not
request credentials; I report the exact authorization required below.

## ETAPA 2 — Infrastructure audit (result)

- No standalone `GatewayOpLock` Worker exists (no `wrangler.toml` anywhere outside
  `node_modules`).
- The Durable Object class is `functions/api/gateway/gateway-op-lock.do.js`
  (`export class GatewayOpLock`) — self-contained, no imports.
- The `deploy/`, `deploy_v4/`, `deploy_tax/` directories are Solidity/CCTP contract
  deployments, unrelated to the Gateway Worker.
- `wrangler.jsonc` documents `GATEWAY_OP_LOCK` as requiring external Cloudflare
  Dashboard configuration (not inline) — which is why the binding is absent.

## ETAPA 3 — Prepared (not deployed) Worker

I prepared the exact Worker config so the operator can deploy with one command once
authenticated:

- `workers/gateway-op-lock/wrangler.toml` — name `elligentt-gateway-op-lock`, DO
  binding `GATEWAY_OP_LOCK` / `GatewayOpLock`, migration tag `v1`.
- `workers/gateway-op-lock/worker.js` — re-exports `GatewayOpLock` from the shared
  source (no duplicated class).

Deploy steps (after authentication):
1. `cd workers/gateway-op-lock && npx wrangler deploy`
2. Cloudflare Pages (Preview) → Settings → Functions → Durable Object bindings →
   add `GATEWAY_OP_LOCK` → the namespace created by the Worker.
3. Set `DO_INTERNAL_SECRET` (Worker + Pages, same value).
4. Re-deploy the Pages project.

`GATEWAY_OP_LOCK` (atomic, durable) is the correct primary; KV is NOT a substitute for
real-funds operations.

## ETAPA 4 — Validation (prepared, not run)

`GET /api/gateway/health` (from 1.0.1D.2.4) is the non-financial probe that, once the
Worker is deployed, will report `persistence: 'do'` after proving a real reserve/read
round-trip. The probe and its tests are in place; the actual DO probe cannot pass until
the binding exists in the deployed environment.

## ETAPA 5 — Preview (not deployed)

No deployment was performed (no access). No frontend/backend/Worker change was pushed
to any Cloudflare environment.

## Tests / regression
- `node --check workers/gateway-op-lock/worker.js` passes; the import path and
  `GatewayOpLock` export were verified.
- No functional code changed: the 54 coordinator + 5 runtime + 7 native-execution tests
  and the 4 pre-existing failures are unchanged (the only new files are the Worker
  config + this report).

## Files
- `workers/gateway-op-lock/wrangler.toml` (new) — Worker DO config + migration.
- `workers/gateway-op-lock/worker.js` (new) — Worker entry re-exporting GatewayOpLock.

## Exact authorization required to unblock
1. Cloudflare authentication: `wrangler login` (interactive OAuth by the operator), OR
   `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` set in the deploy environment
   (never committed to Git).
2. Permission to deploy a Worker and to add a Durable Object binding + secret on the
   Cloudflare Pages Preview environment.

Once (1) and (2) are provided, the prepared Worker is deployable and the persistence
error is resolved; the classification would then progress to
READY FOR REAL MAINNET TEST after a passing `/api/gateway/health` probe.

No merge to main. No production change. No real transactions. No credentials stored.
