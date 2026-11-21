# Swap — Mobile Wallet Connect 2.0 (OKX + Bitget)

> Extends the existing wallet-connection infrastructure with OKX Wallet and
> Bitget Wallet, preserving desktop behavior and all financial execution.

## 1. Root cause

The mobile wallet modal only listed MetaMask, Coinbase, Rabby, Trust Wallet and
WalletConnect. OKX and Bitget were absent — there was no connector, provider
detection, or EIP-6963 mapping for them, so users could not connect those wallets.

## 2. Integrations added (verified against official docs)

| Wallet | Desktop (extension) | Mobile (no extension) | Provider |
|---|---|---|---|
| OKX Wallet | `window.okxwallet` (EIP-1193) | WalletConnect | `isOKXWallet` / EIP-6963 `com.okex.wallet` |
| Bitget Wallet | `window.bitkeep.ethereum` (EIP-1193) | WalletConnect | `isBitKeep` / EIP-6963 "Bitget Wallet" |

- **Detection order:** EIP-6963 (by name + rdns) → injected EIP-1193
  (`window.okxwallet` / `window.bitkeep.ethereum`). Multiple providers are
  deduplicated by EIP-6963 `uuid`.
- **Desktop missing extension:** `showInstallPanel` with the official install URL
  (`https://www.okx.com/web3`, `https://web3.bitget.com/wallet-download?type=2`).
- **Mobile:** both apps connect via **WalletConnect** (their mobile apps are
  WC-compatible; no DApp deep-link scheme exists). The modal shows a clear
  "Connect via WalletConnect" description and a toast — never a silent redirect.
- **No fabricated endpoints/IDs/URLs.** No `getMobileDeepLink` entry was added
  for OKX/Bitget (they have no such deep link); mobile uses WalletConnect.

## 3. Files changed

- `index.html` — wallet modal rows, `_safeOkx`/`_safeBitget`, `_wmKnownMap`,
  `detectWallets`, `updateWalletBadges`, `finalizeConnection` badges,
  `openWalletModal` descriptions, `connectOKX`/`connectBitget` (with a
  duplicate-click guard `_connectingWallet`).
- `public/assets/wallets/okx.svg`, `public/assets/wallets/bitget.svg` — logos.
- `tests/swap-mobile-okx-bitget.test.js` — new (25 tests).
- `tests/swap-mobile-header-wallet.test.js` — replaced the stale "OKX must not
  exist" assertion (now superseded by the new requirement).

## 4. How OKX/Bitget connect on mobile

Tap OKX/Bitget → no injected provider → `connectWalletConnect()` with a clear
"Connect OKX/Bitget Wallet via WalletConnect" notice → the user scans the QR with
the OKX/Bitget app. In the wallet's in-app browser, the injected
`window.okxwallet`/`window.bitkeep.ethereum` is used directly.

## 5. Tests & build

- `tests/swap-mobile-okx-bitget.test.js` (new) — **25 pass**, incl. behavioral
  `vm` tests for `_safeOkx`/`_safeBitget` detection and `_wmMatchFn` mapping
  ("OKX Wallet"→`connectOKX`, "Bitget Wallet"→`connectBitget`), WalletConnect
  fallback, no fabricated deep links, install panel, duplicate-click guard.
- `tests/swap-mobile-header-wallet.test.js` (updated) — **16 pass**.
- Swap regression re-run: **10 pre-existing failures** remain unchanged
  (`swap-standard-mobile-layout` ×3 CSS-marker mismatch, `swap-ui-modes` ×1 Tower,
  `swap-balance-fmt` ×1, `swap-chain-sync` ×3, `swap-multitoken` ×3) — verified
  identical at baseline (stash diff). **Zero new failures.**
- `npm run build` — passes.

## 6. Desktop & financial integrity

- Desktop wallet modal, topbar, Standard/Advanced swap, network selector and all
  other tabs are unchanged (the previous mobile header de-dup + modal layering
  remain intact).
- No change to `executeSwap`, `SwapAggregator`, LI.FI/Tower, CCTP, Gateway,
  Circle Agent Wallet, Autonoma, Send/Bridge/Multisend/Scheduler, slippage/fees,
  approvals, signing, auth, or contracts.

## 7. Remaining limitations / manual verification

- Physical-device verification (Chrome Android, iOS Safari, wallet in-app
  browsers) was not executed in this environment; the integration is validated
  via controlled `vm` simulations and source assertions. A real extension/app
  test is recommended before release.

## 8. Branch & commit

- Branch: `feat/swap-mobile-okx-bitget` (from `origin/main` `d7756a7`).
