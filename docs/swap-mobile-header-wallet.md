# Swap — Mobile Header & Wallet Connect Optimization

> Mobile UI only. Desktop layout/behavior and the financial execution path are
> unchanged (guarded by regression tests).

## 1. Root causes

### Header duplication (mobile)
On mobile (`max-width:768px`) the `#page-swap` page becomes a full-screen overlay
whose terminal `.st-header` is forced visible (`display:flex !important`) and acts
as the mobile top bar (hamburger + network pill + wallet button). In **Standard**
mode the `swp-std-header` page header is ALSO shown, so the user saw two
`Connect Wallet` buttons, two network pills, and a redundant "No wallet" indicator.
The existing desktop de-dup rule (`@media(min-width:769px) … .st-header .st-net-pill/.st-wallet-btn{display:none}`) is desktop-only, so mobile Standard was never covered.

### Wallet modal hidden behind the bottom nav
The wallet modal overlay `.wm-overlay` was `z-index:2000`, but the app's
`.mobile-bottom-nav` is `z-index:9999`. On mobile the bottom sheet of the wallet
modal was therefore overlaid by the bottom navigation, hiding the last wallet
option and the footer, and blocking full scroll. There was no safe-area padding.

### OKX Wallet
OKX is **not integrated anywhere** in the codebase (no connector, no deep link,
no EIP-6963 mapping). Per the task ("include OKX only when an existing functional
integration exists; do not invent connectors"), OKX was **not added** — adding it
would be fabricating a non-functional option.

## 2. Changes (files)

`index.html` only — 13 insertions, 2 deletions:

1. `.wm-overlay` z-index `2000` → `10000` (above the bottom nav `9999`, still
   below the top-level modals `1000000+`).
2. Mobile `.wm-left` now adds `padding-bottom:calc(24px + env(safe-area-inset-bottom,0px))`.
3. New `@media(max-width:768px)` rule hiding the duplicated
   `#page-swap.swp-standard .swp-std-header .st-wallet-btn` and
   `#page-swap.swp-standard .swp-std-header .st-net-pill` (title, Live subtitle,
   History and settings remain).

## 3. Before / after (mobile header)

**Before:** `.st-header` (Connect Wallet + Arc Mainnet) **and** `.swp-std-header`
(Connect Wallet + "No wallet" + Arc Mainnet) both visible → duplicated controls.

**After:** `.st-header` keeps the single Connect Wallet + network selector;
`.swp-std-header` keeps only `Swap Tokens`, the Live subtitle, and History.

## 4. Supported wallets & behavior per platform

| Wallet | Desktop | Mobile |
|---|---|---|
| MetaMask | injected (extension) | deep link `metamask.app.link` |
| Coinbase Wallet | injected (extension) | deep link `go.cb-w.com` |
| Rabby | injected (extension) | deep link `rabby.io` |
| Trust Wallet | injected (extension) | deep link `link.trustwallet.com` |
| WalletConnect | QR / 300+ wallets | QR / 300+ wallets |
| (OKX) | — | — (no integration; not added) |

Detected wallets (EIP-6963 / `window.ethereum.providers`) are shown in a
"Detected" section with a generic provider connect; the static fallback list is
shown when none are detected. The modal is single-column + scrollable on mobile.

## 5. Desktop isolation

No desktop rule was modified: the two-column wallet modal (`.wm-cols{1fr 1fr}`),
the topbar wallet chip + network pill, the Advanced-mode header de-dup rule
(`@media(min-width:769px)`), and the Standard/Advanced toggles are byte-identical.

## 6. Tests & build

- `tests/swap-mobile-header-wallet.test.js` (new) — **17 pass**: mobile de-dup rule
  scoping, wallet modal z-index > 9999, safe-area padding, supported wallet list,
  no OKX connector, deep-link mapping (behavioral, via `vm`), WalletConnect,
  desktop preservation, and swap-engine presence.
- Swap regression re-run: **10 files, 216 tests** — 212 pass; the same 4
  pre-existing failures remain unchanged (3 `swap-standard-mobile-layout`
  CSS-marker mismatch + 1 `swap-ui-modes` Tower reference test).
- `npm run build` — passes.

## 7. Commit & branch

- Branch: `fix/swap-mobile-header-wallet` (from `origin/main` `9e3044e`).

## 8. Financial integrity

No change to the swap engine (`executeSwap`, `SwapAggregator`, route selection,
approvals, slippage, fees), Circle Agent Wallet, Gateway, LI.FI/Tower, Bridge,
Send, or Unified Balance. This is CSS-only presentation.
