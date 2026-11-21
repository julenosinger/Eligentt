# Swap — OKX & Bitget Connection Hotfix (2.0.1)

> P0: OKX/Bitget clicks on mobile did not open the wallet or start a visible
> connection. Surgical fix — no desktop/mobile regression, no financial change.

## 1. Root cause (proven)

Two compounding defects:

1. **WalletConnect Project ID was never injected.**
   `functions/index.js` injects it at runtime via
   `html.replaceAll('__WC_PROJECT_ID_PLACEHOLDER__', wcProjectId)`, but `index.html`
   declared `wcProjectId: ''` (the placeholder had been lost). Production served
   `wcProjectId: ''` (verified against `elligentttest.pages.dev`), so
   `WCProvider.init({ projectId: '' })` failed and the WalletConnect QR/selection
   modal never opened. OKX/Bitget mobile rely on WalletConnect → nothing happened.

2. **Fire-and-forget `connectWalletConnect()` without `await`.**
   `connectOKX()`/`connectBitget()` called `connectWalletConnect()` without
   `await`, gave no feedback on the tapped row, and swallowed async errors.

## 2. Fix (files)

`index.html`:

- Restored the `__WC_PROJECT_ID_PLACEHOLDER__` placeholder in `wcProjectId` so the
  Cloudflare Pages Function injects the real Project ID again.
- `connectWalletConnect(sourceWallet)` now:
  - routes the "Loading… / Opening… / Waiting for approval…" feedback to the tapped
    wallet's row (`wm-okx` / `wm-bitget`) instead of the generic WC row;
  - returns `true`/`false`;
  - fails fast with a clear "WalletConnect is not configured" when the Project ID is
    empty (no silent failure).
- `connectOKX()` / `connectBitget()` now `await connectWalletConnect('okx'|'bitget')`
  on mobile, keeping the `_connectingWallet` lock held for the whole flow and
  releasing it in `finally` (success / reject / cancel).

No change to the injected-provider (extension) path, the existing connectors, or the
generic WalletConnect button.

## 3. Before / after flow

**Before:** tap OKX → `toast(...)` + `connectWalletConnect()` (no await) → empty
Project ID → silent failure → no modal, no feedback.

**After:** tap OKX → `await connectWalletConnect('okx')` → "Opening WalletConnect…"
on the OKX row → QR/selection modal opens (real Project ID) → user approves in the
OKX app → `finalizeConnection` → "Waiting for approval…" → connected. Reject/cancel →
clear toast + row reset.

## 4. Manual Cloudflare configuration (required)

The Project ID is read from `env.WC_PROJECT_ID`. If it is not set in the Cloudflare
Pages dashboard (Production), the flow now reports "WalletConnect is not configured"
instead of failing silently. **Set `WC_PROJECT_ID` to a valid WalletConnect v2
Project ID in the dashboard.** (This is a manual step; the repo cannot read secrets.)

## 5. Tests & build

- `tests/swap-mobile-okx-bitget-201.test.js` (new) — **14 pass**, incl. behavioral
  `vm` tests: empty Project ID → returns `false` + "not configured"; WC SDK missing →
  `false`; successful connect → `true` with `connect`/`finalize` invoked; source-aware
  feedback; `finally` lock release.
- `tests/swap-mobile-okx-bitget.test.js` (updated) — **25 pass**.
- `tests/swap-mobile-header-wallet.test.js` — **16 pass**.
- Swap regression re-run: **10 pre-existing failures unchanged** (`swap-standard-mobile-layout` ×3, `swap-ui-modes` ×1, `swap-balance-fmt` ×1, `swap-chain-sync` ×3, `swap-multitoken` ×3) — **zero new**.
- `npm run build` — passes.

## 6. Desktop & financial integrity

- Desktop wallet modal, topbar, injected providers (MetaMask/Coinbase/Rabby/Trust/OKX/Bitget), network selector and Standard/Advanced swap are unchanged.
- No change to `executeSwap`, `SwapAggregator`, LI.FI/Tower, CCTP, Gateway, Circle Agent Wallet, Autonoma, Send/Bridge/Multisend/Scheduler, slippage/fees, approvals, signing, auth, or contracts.

## 7. Limitations

Physical-device verification (Chrome Android / iOS Safari / wallet in-app browsers)
was not executed in this environment; the fix is validated with controlled `vm`
mocks + source assertions. The WalletConnect Project ID must be set in Cloudflare
for the mobile flow to complete end-to-end.

## 8. Branch & commit

- Branch: `fix/swap-mobile-okx-bitget-201` (from `origin/main` `cec041e`).
