# Bridge Tokens · UI refinement

Scope: presentation only, in `index.html`. No change to the bridge engine, CCTP V2, LI.FI, route discovery/selection, Destination Readiness logic, burn/attestation/mint/recovery, Treasury Vault/relayers, contracts, RPCs, fees, BigInt math or any other module. No Standard/Advanced modes and no chart were added.

## Baseline

- HEAD at start and end: `b6d38dfe62719631cc111c7ab97b0bfced632818` on `main` (changes uncommitted; nothing merged or deployed). Working tree at start: clean.
- `vitest run` before and after: 136 failed / 5,615 passed / 16 skipped (41 files failing). The failing set is identical (diffed); none of the Bridge-specific suites fail because of this change. The 136 failures already existed at this HEAD.
- `node scripts/build.js`: OK. The regenerated `public/index.html` was reverted so only `index.html` changed.

## Audit findings

- The card's `.brg-*` rules live in `styles/base.css`, which `index.html` does not load, so the card was rendering with generic shared classes (`.swap-card`, `.chain-row`, `.token-sel`).
- The CCTP V2 / "Use LI.FI" selector already exists: `shared/bridgeRouteSelector.js` injects it with inline styles. It was kept and only restyled from CSS (that file is untouched).
- Many existing tests pin Bridge markup (`brg-bal-row` prefix, `<span>You Receive</span>`, rate box ids and order, readiness class names); all still pass.
- Source gas on Arc is paid in USDC (the native gas token).

## What changed

CSS: one new block, `<style id="brg-modern-ui">`, every rule scoped to `#page-bridge`, using the same tokens as the Swap card (`--panel-*`, `--swap-*`). Dark and Light both apply. Height tiers (900 / 820 / 700px) adjust local variables only, like the Swap card. `!important` is used only to override inline styles that exist in the markup or in the injected route selector (amount cell flex/padding, Wallet/Network row direction, route chips, and the always-visible summary).

- YOU SEND / YOU RECEIVE are separate rounded surfaces. Amount on the left, token and network on the right as one joined selector (both still independent controls, each with its own handler), real token and network icons, balance below, USD equivalent below the amount.
- 25% / 50% / MAX on the balance row; the CCTP V2 / LI.FI selector at the bottom of YOU SEND.
- Flip button centred between the surfaces, Swap-style; its handler is unchanged.
- Bridge summary (Route, Bridge Fee, Estimated Time, You Receive, Minimum Received) is its own block with icons and right-aligned values.
- Destination Readiness: compact aligned rows, header on one line, readiness line and its states untouched.
- Primary button: full width, 44-48px, rounded; clear disabled, hover, active and focus states; dynamic labels untouched.

Markup (ids and handlers unchanged): labels now read YOU SEND / YOU RECEIVE; the summary block was moved out of the receive surface (same element, same ids, same order); icons added to the summary rows; the three shortcut buttons added inside the existing FROM balance row.

JS (additive, no existing function body edited):
- `brgSetPct(25|50|100)`: reads the balance already shown (4 decimals) and does exact integer math in 1e-4 units. Results are floored and never exceed the displayed balance. MAX keeps one unit of display-rounding headroom, plus a 0.05 reserve only when the token is the source chain's native gas currency (USDC on Arc). It fills the amount field and fires the field's own `input` event, so quotes and validation run exactly as if typed. Does nothing when the balance is unknown.
- `updateBridgeEst` is wrapped: the original runs first; afterwards the summary shows neutral placeholders (Route "—", and Estimated Time "—" when there is no amount or both chains are equal) instead of "LI.FI" / "Fetching route…". The summary is now always visible, so no stale or implied data is shown. Real values still come only from the engine's quote/selection.

## Measured (headless Chromium, no wallet, no funds)

| Viewport | Card height before → after | Button bottom before → after | Note |
|---|---|---|---|
| 1366×768 | 619 → 656 | 726 → 767 | button fits; summary is now always visible (+~120px) |
| 1440×900 | 619 → 722 | 726 → 831 | fits |
| 1366×650 | 619 → 603 | 726 → 714 | ~60px of page scroll (same before) |
| 390×844 | stacked | stacked | page scrolls naturally |

The card is taller than before at the same viewport because the summary is now always shown with placeholders (as in the approved reference); tiers compensate. No inner scrollbar, no transform/zoom, no clipping.

Functional checks on the live page (mocked routes, no transactions): flip swaps names and chain logos; token and network pickers open; 25% / 50% / MAX give exact values (349.8324 → 87.4581 / 174.9162 / 349.7823 on Arc USDC with the gas reserve; 10.5000 → 2.625 / 10.4999 on Ethereum USDC); unknown balance does nothing; a too-small MAX shows a warning and fills nothing; route cards select from the card body and the Select button, with the Selected state, summary, divider and button label following the real selection; typing a new amount resets the summary; Readiness shows "Unavailable / Awaiting destination" without a wallet (never a positive state); Help and History present; no console errors.

## Limitations

- Real wallet flows were not run: approval, burn, attestation, mint, recovery, History confirmation, duplicate-execution protection and gas-insufficient states are driven by untouched code and were not exercised.
- The MAX reserve (0.05, only for the native-gas token) is a UI helper constant, not an engine requirement; the engine still validates the amount.
- Fonts in the sandbox browser differ from production, so exact text widths (for example the Readiness header) may differ slightly.
