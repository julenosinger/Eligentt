# Network Default (Arc Mainnet) & Mobile Chain Switch

> P0: default the app to Arc Mainnet (5042) and restore the mobile network
> selector. No financial-execution change; desktop and mobile preserved.

## 1. Root cause (proven)

**Mobile network selector did not switch.**
The network-selector modal has a two-column layout: the left column lists chains,
and the right column (`#ns-detail`) holds the "Switch to this network" button. On
mobile (`@media(max-width:600px)`) the right column is hidden
(`.ns-right{display:none}`), and every chain row's `onclick` called
`_nsSelectChain()` — which only *previews* the chain in the (hidden) right panel.
There was no path to `_nsSwitchTo()` on mobile, so tapping a row never switched
the network.

**Ethereum as the default source chain.**
`bridgeFromIdx = 1` and `xcFromIdx = 1` (both Ethereum) initialised the Bridge and
Cross-Chain "from" chain to Ethereum, contradicting the code comment
"Initialize Bridge direction from the active Arc network" and the requirement
"não utilizar Ethereum como fallback padrão". (`activeChainId` itself was already
`5042`.)

## 2. Fix (files)

`index.html`:

1. Network-selector row `onclick` now dispatches by viewport:
   `window.innerWidth <= 600 ? _nsSwitchTo : _nsSelectChain` — mobile taps switch
   directly; desktop taps keep previewing in the right panel.
2. `bridgeFromIdx = 0` (Arc) / `bridgeToIdx = 1` (Ethereum) at the initial
   declaration and in `initBridgeChains()`.
3. `xcFromIdx = 0` (Arc) / `xcToIdx = 1` (Ethereum) for Cross-Chain.

`activeChainId` remains `5042` (Arc Mainnet), `getActiveChain()` falls back to Arc,
and `getSelectableNetworks()` lists Arc first (unchanged, now consistent).

## 3. Behavior

- **Switch flow:** tap row → `_nsSwitchTo` → `ensureNetwork(chainId)` →
  `wallet_switchEthereumChain` (with `wallet_addEthereumChain` on 4902) → poll
  `eth_chainId` → `refreshProviderState()` → `chainChanged` handler refreshes
  state/badges/balances. User rejection (4001) is surfaced; the button re-enables.
- **Wallet compatibility:** the switch uses the dapp's selected provider
  (`_safeEth()`), so MetaMask / Coinbase / Rabby / Trust / OKX / Bitget and
  WalletConnect all follow the same `ensureNetwork` path. No wallet is ever forced
  to switch; the real wallet chain is shown until the user consents.
- **Arc default:** a fresh session starts on Arc Mainnet (header, selector, bridge
  source, cross-chain source).

## 4. Tests & build

- `tests/network-default-mobile-switch.test.js` (new) — **17 pass**: Arc as
  `activeChainId`/bridge/cross-chain source, `getSelectableNetworks` Arc-first
  (behavioral via `vm`), mobile row-tap switch dispatch, `ensureNetwork` uses
  `wallet_switchEthereumChain` + add fallback + 4001 handling, `chainChanged`
  refresh, disconnect → Arc, and swap/LI.FI execution intact.
- Regression re-run: **13 pre-existing failures unchanged** (verified at baseline
  via stash: `chain-provider-consistency` ×2, `network-selector-mainnet` ×2,
  `swap-chain-sync` ×3, `send-coldstart-arc-gas` ×5, `swap-cross-chain-routes` ×1).
  **Zero new failures.**
- `npm run build` — passes.

## 5. Desktop & mobile protection

Desktop: only the network-selector right-panel behavior is preserved (row tap still
previews); the modal layout, header, sidebar, Swap/Bridge/Send and wallet modal are
unchanged. Mobile: header de-dup, wallet modal (OKX/Bitget), bottom nav, safe-area,
Standard/Advanced, dark/light all preserved.

## 6. Financial integrity

No change to the swap engine, LI.FI/Tower/CCTP, Circle Gateway/Agent Wallet, Send,
Bridge execution, approvals/allowances/signatures, slippage/fees, Treasury/Multisend,
Scheduler/Autonoma, contracts/chain IDs, or reconciliation. The signing chain always
matches the wallet's real authorised network.

## 7. Branch & commit

- Branch: `fix/network-default-mobile-switch` (from `origin/main` `cec041e`).
