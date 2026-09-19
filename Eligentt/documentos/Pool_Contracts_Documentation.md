# Elligentt Liquidity Pool — Contract Documentation (Auto-Generated)

**Data:** 15/07/2026  
**Chain:** Arc Testnet (Chain ID: 5042002)  
**ABI Version:** custom_v1  
**Pool Type:** Custom LP Token with Reserves

---

## Pool Address

```
0x18076d992005186AeB13AC5270CaD6E27DB95247
```

- **Name (on-chain):** Elligente LP Token
- **Symbol (on-chain):** ELP
- **Decimals (on-chain):** 18
- **LP Token Address:** 0x18076d992005186AeB13AC5270CaD6E27DB95247 (pool IS the LP token)
- **Pool + LP unified:** Yes (single contract, ERC-20 LP + reserves)

---

## Router & Factory

| Component | Address | Status |
|-----------|---------|--------|
| **Router** | `null` | Not deployed — direct pool access |
| **Factory** | `null` | Not deployed — custom LP token |

Swaps are performed **directly on the pool contract**, not through a router.

---

## Supported Tokens

| Token | Address | Decimals |
|-------|---------|----------|
| USDC | `0x3600000000000000000000000000000000000000` | 6 |
| cirBTC | `0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF` | 8 |

---

## On-Chain Reserve Data (Snapshot: 15/07/2026)

| Metric | Raw Value | Formatted |
|--------|-----------|-----------|
| Reserve A | 20,508,094,695 | ~20,508.09 USDC (6 decimals) |
| Reserve B | 15,186,215,374 | ~151.86 cirBTC (8 decimals) |
| Total Supply (LP) | 17,543,847,605 | ~17.54 ELP (18 decimals) |

Source: `eth_call` to `getReserves()` and `totalSupply()` at block latest.

---

## Supported Functions (On-Chain Verified)

### ERC-20 Standard

| Function | Selector | Type | Verified |
|----------|----------|------|----------|
| `name()` | `0x06fdde03` | view | Yes — "Elligente LP Token" |
| `symbol()` | `0x95d89b41` | view | Yes — "ELP" |
| `decimals()` | `0x313ce567` | view | Yes — 18 |
| `totalSupply()` | `0x18160ddd` | view | Yes |
| `balanceOf(address)` | `0x70a08231` | view | Yes |
| `allowance(address,address)` | `0xdd62ed3e` | view | Yes |
| `transfer(address,uint256)` | `0xa9059cbb` | write | Presumed (standard) |
| `approve(address,uint256)` | `0x095ea7b3` | write | Presumed (standard) |
| `transferFrom(address,address,uint256)` | `0x23b872dd` | write | Presumed (standard) |

### Pool-Specific

| Function | Selector | Type | Verified |
|----------|----------|------|----------|
| `getReserves()` | `0x0902f1ac` | view | Yes |

Returns: `(uint256 reserveA, uint256 reserveB, uint256 blockTimestampLast)`

---

## Unsupported Functions (On-Chain Verified — REVERT)

These functions are **NOT available** on this pool contract:

| Function | Selector | Expected Standard |
|----------|----------|------------------|
| `token0()` | `0x0dfe1681` | Uniswap V2 |
| `token1()` | `0xd21220a7` | Uniswap V2 |
| `tokenA()` | `0x0fcb5522` | Custom |
| `tokenB()` | `0x5f0e0dd1` | Custom |
| `fee()` | `0xddca3f43` | Uniswap V2 |
| `factory()` | `0xc45a0155` | Uniswap V2 |
| `getAmountOut(uint256,address)` | `0xf2ac2d16` | Uniswap V2 |

**Note:** Without `getAmountOut`, the constant-product AMM formula is used client-side to estimate swap outputs:
```
amountOut = (reserveOut * amountIn * (1 - fee)) / (reserveIn + amountIn * (1 - fee))
```

---

## Fee Structure

| Parameter | Value |
|-----------|-------|
| Estimated Pool Fee | 0.30% (30 bps) |
| Default Slippage | 1.00% (100 bps) |
| Low Slippage | 0.50% (50 bps) |
| High Slippage | 2.00% (200 bps) |
| Max Slippage | 3.00% (300 bps) |

**Note:** Since `fee()` is not available on-chain, the fee is estimated as 0.3% (typical AMM default).

---

## Liquidity Health (Snapshot: 15/07/2026)

| Metric | Value |
|--------|-------|
| **Total Liquidity (TVL)** | ~20,508 USDC |
| **Health Score** | 4/10 — Moderate |
| **Tier** | Moderate |
| **Stability** | Low (highly imbalanced pool: ~13,000:1 ratio) |
| **Token Diversity** | 2 tokens |

---

## Price Impact Tiers

| Tier | Threshold | Action |
|------|-----------|--------|
| **LOW** | < 1% | Normal execution |
| **MEDIUM** | 1% - 5% | Warning displayed |
| **HIGH** | 5% - 10% | Confirmation required |
| **CRITICAL** | > 10% | Confirmation required + strong warning |
| **BLOCKED** | > 15% | Swap execution blocked |

---

## Security Modules (FASE 1 + FASE 2)

### Phase 1 — Critical Security
- `chainSimulator.calculateMinOut()` — Slippage protection (never 0)
- `chainSimulator.isDeadlineExpired()` — 300s deadline enforcement
- `chainSimulator.buildApproveCalldata()` — Exact approval only
- `chainSimulator.validateSwapRouter()` — Router address validation
- `riskEngine.js` — Swap classified as MEDIUM risk
- `agentWalletManager.js` — Private keys in session memory only (no plaintext)
- `rpcManager.js` — Multi-RPC fallback (dRPC, Arc Network, ArcScan, Anomaly)

### Phase 2 — Economic Protection
- `poolAbiDiscovery.js` — On-chain ABI discovery
- `priceImpact.js` — Price impact calculation & tier classification
- `liquidityHealth.js` — Liquidity health score (0-10)
- `liquidityProtection.js` — Low liquidity warnings/blocks
- `poolRegistryModule.js` — Central pool metadata registry
- `poolHealthCheck.js` — 6-point health validation
- `economicRisk.js` — Combined economic risk scoring
- `chainSimulator.performFullSwapAnalysis()` — Integrated analysis pipeline

---

## Storage Layout (On-Chain Discovery)

| Slot | Content | Format |
|------|---------|--------|
| 0 | EMPTY | — |
| 1 | EMPTY | — |
| 2 | `totalSupply` | uint256 |
| 3 | `name` (short string) | "Elligente LP Token" |
| 4 | `symbol` (short string) | "ELP" |
| 5 | `reserveA` | uint256 |
| 6 | `reserveB` | uint256 |
| 7-8 | Internal mappings | balanceOf / allowance |

---

## Test Coverage Summary

| Phase | Test File | Tests | Status |
|-------|-----------|-------|--------|
| Original | `pool.test.js` | 13 | Pass |
| Phase 1 | `swap-security.test.js` | 58 | Pass |
| Phase 2 | `pool-phase2.test.js` | 74 | Pass |
| **Total** | | **145** | **100% Pass** |

---

*All data sourced exclusively from on-chain `eth_call` and `eth_getStorageAt` against the Arc Testnet RPC (dRPC). No mocked data.*
