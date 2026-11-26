# Swap Tokens · Standard card — vertical fit report

Scope: vertical distribution of the existing Standard swap card, CSS only. No change to swap logic, routes, quotes, fees, slippage, approvals, balances, history, IDs, handlers or listeners.

## Baseline

- HEAD (start and end): `166e6f3818799455dd50c3b82bf5bf26062ba82b`. The change is uncommitted; nothing merged or deployed.
- Working tree at start: clean (only ignored build artifacts and `cache/` / `out/` noise).
- Tests measured at this HEAD with and without the change (same build-artifact state): 136 failed / 5,615 passed / 16 skipped (41 files failing). The set of failing tests is identical before and after (diffed). These failures already exist at HEAD and are unrelated to Swap layout.
- `node scripts/build.js`: OK. The regenerated `public/index.html` was reverted so only `index.html` is changed.

## Cause of the excess height (Standard, 1366×768, chart visible)

The card was 722px tall and started 91px below the top (63px page header + 28px `st-main-area` padding), so the Swap button ended at y=802 and was cut off at 768. Main contributors: 28px top padding, 47px mode toggle, 6px gaps, You Pay 130px, You Receive 90px, 34px flip row, quote block 162px (about 31px per row because rows inherit a 1.6 line height), 110-133px chart (60px plot), 34px slippage row.

## Change

One new block, `<style id="swp-vertical-fit">`, placed last in `<head>`. No existing CSS was edited (existing tests pin several of those exact strings).

- Every rule is inside `@media (min-width:769px)` and scoped to `#page-swap.swp-standard .st-swap-panel` (plus `.st-main-area` for the top padding). Advanced, mobile, route cards, Swap Summary, Bridge, RWA and shared classes are not matched.
- Local custom properties hold the spacing. Defaults equal the current values, so screens taller than 960px keep the existing spacing. Tiers: `max-height:960px` (moderate), `820px` (about 100-130px recovered), `700px` (short windows).
- Top space is `clamp(12px, 1.8vh, 16px)`.
- Quote rows get a tighter line height and padding; chart plot height is a variable (60 → 46 → 36 → 30px) and the chart marker position now reads the same variable so it stays on the line. Chart data, scales and updates are untouched.
- Swap button keeps 44-48px; pills, MAX/25%/50% and slippage buttons keep 22-30px minimum heights.
- No `transform`/`zoom`, no `overflow:hidden`, no fixed heights, no sticky button, no inner scrollbar. The one `!important` mirrors the existing Source-row rule (the markup has an inline margin).

## Measured results (headless Chromium, Standard, chart visible, wallet disconnected)

| Viewport | Card height before → after | Card top before → after | Swap button bottom before → after | Fully visible |
|---|---|---|---|---|
| 1366×768 | 722 → 612 | 91 → 77 | 802 → 680 | no → yes |
| 1366×650 (typical browser window) | 722 → 567 | 91 → 75 | 802 → 635 | no → yes |
| 1280×720 | 722 → 612 | 91 → 76 | 802 → 679 | no → yes |
| 1024×768 | 722 → 612 | 91 → 77 | 802 → 680 | no → yes |
| 1440×900 | 722 → 670 | 91 → 79 | 802 → 740 | yes → yes |
| 1920×1080 | 722 → 722 | 91 → 79 | 802 → 790 | yes → yes |
| 390×844 (mobile) | 758 → 758 | unchanged | unchanged | page scrolls naturally (unchanged) |

Recovered at 1366×768: 110px of card height, 124px of Swap button position (target 100-130px).

Dark and Light produce the same geometry. Advanced mode is unchanged (741px card in every run). Routes column: same x position and width (424px), same card heights (route selector 59px, summary 69px); it only moves up with the card, still aligned to its top.

No horizontal overflow at any tested size. Console error counts are the same before and after (all pre-existing, from the dev server and CDN loads).

## Not covered

Pending, success and error button states, cross-chain mode and a populated route list were not rendered (no wallet or funds; nothing was transacted). They are driven by the same elements whose spacing is only adjusted. The Send Assets page was not touched.
