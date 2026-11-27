# Capital Hub 1.0 · Report

HEAD initial = HEAD final = `e574da1b9332f1bb30dcd1dc3236e5a61e6dd3f3` (branch `main`). Nothing committed, merged or deployed.

## What was added
Treasury › **Capital Hub** (sidebar item right below Vault; no new main-menu tab). Header, environment pill (derived from the active chain), Refresh, and six internal tabs: Overview, Manage Funds, Networks, Transactions, Analytics, Security.

| File | Change |
|---|---|
| `shared/capitalHub.js` (new) | Data layer: exact BigInt decimals, shared-cache Gateway reader, other-capital readers, operation journal, status reconciliation, transfer observer |
| `shared/capitalHubUI.js` (new) | Shell, Overview (cards, actions, distribution, capital flow, recent operations, network balances) |
| `shared/capitalHubTabs.js` (new) | Manage Funds, Networks, Transactions (filters, pagination, details, CSV), Analytics, Security |
| `index.html` | Nav item, section container, 3 script tags, scoped `<style id="capital-hub-ui">`, 1 branch in `showTrsSection`, 1 observer line in the existing Gateway deposit flow (`try/catch`, after the deposit is confirmed) |
| `tests/capital-hub.test.js` (new) | 18 tests |

## Reused services (no second engine, no ledger of balances)
- **Gateway balances:** the shared Unified Balance cache, refreshed through the existing `ubGatewayFetch()` (`/api/gateway/balances`, single in-flight, seq-guarded). Capital Hub never issues its own balance request and has no timers or polling; it only re-renders when that cache changes.
- **Deposit:** opens the existing Gateway deposit window (`ubGwDepOpen`), which keeps its own network/amount selection, approval, fees and signatures.
- **Transfer / Withdraw:** open Send Assets with Circle Gateway as source (existing flow). Withdraw pre-fills **your own address**.
- **Status truth:** deposit = Processing after the source tx; Confirmed only when a later Gateway read shows `balance >= balanceBefore + amount`. Transfer = Confirmed only when the existing `/api/gateway/transfer` record says so (GET on show/Refresh, max 10 open ops).
- **Separation:** Gateway (unified), EVM wallet (active network) and Treasury Vault are shown as separate sources and never summed.

## Limitations (stated, not hidden)
1. **There was no persistent Gateway history to reuse** (the server only answers by salt; the in-page operation bus is in-memory). Recent Operations, Transactions, Capital Flow and Analytics therefore read a small per-browser journal (`localStorage`, per wallet and environment, max 300) of operations started here after this release. Older Gateway activity is not shown. The journal holds no balances.
2. **Withdraw** = Gateway transfer to your own wallet. Circle's trustless on-chain withdrawal is not implemented in this app and the UI says so.
3. **Fees paid** are not recorded by the existing flows: shown as "—".
4. **USD** is shown for USDC only (1:1 by definition). No reliable USD quote is used for EURC or cirBTC, so none is shown.
5. Chain IDs are shown only for domains the app already maps; others show "—".
6. **Replay Protection** is informational: enforcement is server-side and cannot be verified from the browser.
7. Not exercised with a real wallet or real Gateway responses (balances, journal and cache were mocked in the browser). No transactions were sent.
8. Pre-existing: `ti-vault` has no glyph in the pinned icon font (Vault sub-menu icon blank); Treasury cards have no borders in Light Mode.

## Tests
- Baseline vs after: **136 failed / 5624 passed** → **136 failed / 5642 passed** (+18 new). Failure lists identical. `node scripts/build.js` passes and bundles the new modules.
- Browser (Chromium headless, Dark/Light, 1440 and 390): no-wallet, loading/error/stale/partial states, per-asset switch, flow ranges, filters, pagination, details, CSV (14 columns, formula-injection guarded), launchers open the existing deposit window and Send Assets (Gateway origin, own-address recipient). Only existing `/api/gateway/*` endpoints were requested. No console errors.
- No lint/typecheck scripts exist in this repository.
