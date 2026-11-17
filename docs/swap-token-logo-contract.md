# Swap Token-Logo Architecture Contract

> **Status: ENFORCED.** Changes to Swap, Alchemy, Bridge, token selectors, or
> bundling MUST preserve this contract. The rules are enforced by
> `tests/swap-token-logo-contract.test.js`, which runs in the GitHub Actions CI
> `test` job and blocks the `deploy-preview` job on failure.

## 1. LI.FI metadata ownership

LI.FI is the **primary source of truth** for token metadata on LI.FI-supported
networks (`chainId`, `address`, `symbol`, `name`, `decimals`, `logoURI`,
`priceUSD`).

- The Cloudflare proxy (`functions/api/lifi/tokens.js`) copies `logoURI` verbatim.
- A valid LI.FI `logoURI` must **never** be replaced, dropped or overwritten by a
  generic avatar, a symbol-based logo map, or another token's artwork.

## 2. Canonical token identity

A token is identified by **(chainId, contract address)** — **never by symbol
alone**. Native assets use the chain's `nativeCurrency` (zero-address / sentinel
markers), never a symbol guess. Two tokens with the same symbol on different
chains are distinct.

## 3. Logo fallback precedence

The centralized resolver is `_swpTokenLogo(t, chainId)` in `index.html`:

1. **LI.FI `logoURI`** (validated to `http(s)` only) — primary.
2. **Native ETH** → local verified `/assets/tokens/eth.svg` (native classification).
3. **Verified registry logo** keyed by canonical contract address
   (`_SWP_VERIFIED_LOGOS`: Arc/Ethereum/Base/Arbitrum/OP/Polygon USDC, EURC,
   cirBTC) — only when LI.FI is missing.
4. **Neutral token-specific badge** (deterministic per-symbol hue + first letter).

Rules:
- Never infer identity from a single letter (the old `decorate()` MutationObserver
  bug). `.tok-item-icon` must stay OUT of that `SEL` selector.
- Image `onerror` is one-shot (hide `<img>`, show fallback) — no retry loop.
- The resolver is pure (no shared mutable state) — async rendering cannot swap logos.

## 4. CSP image-source

`public/_headers` `img-src` MUST allow the LI.FI logo CDNs:
`raw.githubusercontent.com`, `static.debank.com`, `assets.coingecko.com`,
`arbiscan.io`. Never broaden to a blanket `https:`; add only verified domains.

## 5. Balance provider independence

Balance reads are independent of logo resolution and token metadata. The
provider chain is: Alchemy (feature-flag gated) → RPC (BalanceService) →
Etherscan (eligible chains). Logos never affect balances, and vice-versa.

## 6. Arc Mainnet invariants

Arc (5042) is protected and out of scope for non-Arc optimizations:
- Native gas = USDC (18 decimals at the native layer).
- USDC ERC-20 interface = `0x3600…0000` (6 decimals).
- Never classify ETH as Arc's native gas; never merge native USDC with the ERC-20
  interface; never route Arc through Alchemy/Etherscan.

## 7. Mandatory regression tests

`tests/swap-token-logo-contract.test.js` must stay green. The CI `test` job runs it
plus the Swap/Balance suites and fails the pipeline on any regression.
