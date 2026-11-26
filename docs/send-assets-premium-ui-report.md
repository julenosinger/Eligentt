# Send Assets · Single & Batch Send — Premium UI report

Scope: presentation refinement of the Single & Batch Send tab only. No change to the transfer engine, Gateway, CCTP, x402, CPN, Batch Payments, fees, approvals, signing, contracts, APIs, auth or history.

## Baseline vs. final

| | Baseline | Final |
|---|---|---|
| HEAD | `0898d358ff7e2910eb8ae7259ea0e308769d9255` | unchanged (changes are uncommitted, no merge/deploy) |
| `vitest run` | 51 files failed / 198 passed; 92 tests failed / 5366 passed / 16 skipped | identical (same 112 FAIL lines, diffed) |
| `node scripts/build.js` | n/a | OK (the regenerated `public/index.html` artifact was reverted to HEAD, so only the source file is changed) |

The 92 failing tests already failed before the change (Unified Balance, etc.) and are unrelated to Send Assets. No test was edited, removed or weakened.

## Files modified

- `index.html` (authoring source): the only file changed.
- `docs/send-assets-premium-ui-report.md` (this report).

## What changed

Markup (all existing IDs, handlers and `.sa-*` classes preserved; no ID removed or duplicated):
- Select Asset: `aria-pressed` on asset buttons, "3 assets available" meta, Source switch (`#sa-origin-bar`) and Gateway notice moved into the lower region of the card.
- Transfer Details: From/To Network wrapped in a side-by-side row; Recipient paste button; Amount label row with balance; 25% / 50% buttons next to MAX; label `for` associations.
- Route Preview: compact FROM → TO flow with real network logos and names.
- Recent Activity: new empty state, transaction counter, keyboard-accessible hash links.
- Quick Actions: icon + label stacked, 4 columns desktop / 2×2 mobile.
- Removed the hard-coded placeholder fee `~0.001 USDC` from the initial Route Preview markup (now `—` until a real amount is entered).

CSS: one new `<style id="sa-premium-ui">` block, every rule scoped to `#page-send`, using existing theme tokens (dark and light). No global style touched; the Light Premium layer is untouched.

JS (additive, no existing function body altered except as noted):
- `saSetPercent(25|50)`: exact BigInt math on the displayed balance via the existing `_saParseUnitsExact`, token decimals respected, never exceeds the balance, no floats. Execution-time validation (`_saValidateAmount`, `saToRaw`) is unchanged.
- `saPasteRecipient()`: click-initiated clipboard read, then fires the field's own input handler (same validation, autocomplete, route update as typing).
- `saRenderRouteFlow()`: display-only, called from `saUpdateRoute()`; logo re-rendered only when the network changes.
- `saSelectAsset`: also sets `aria-pressed`.
- `saRenderActivity`: also updates the transaction counter. History, persistence and confirmation logic untouched.
- No new dependencies, timers, polling, listeners, or RPC/API calls.

## Validation performed

- Full vitest suite compared with baseline: identical results.
- Static check: no duplicate IDs introduced, no ID removed, no inline handler removed from the Send page.
- `saSetPercent` exercised against 1.00 USDC, 5.25 USDC, 0.123457 cirBTC (8 dec), unknown balance (`—`, `…`), wrong-asset balance and zero balance: exact results (e.g. 50% of 5.25 = 2.625, 25% of 0.123457 cirBTC = 0.03086425), no-op when the balance is unknown.
- Production build completes.

## Not verified in this environment

The sandbox has no browser, so these were NOT checked visually and should be reviewed by eye before merging: light/dark appearance, desktop/tablet/mobile layout, collapsed/expanded sidebar, console errors at runtime, and overflow/overlap. Same-chain and cross-chain sends, Gateway sends and CPN payouts were not executed (no real transactions), and their code paths were not modified.
