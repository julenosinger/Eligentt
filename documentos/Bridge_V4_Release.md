# Bridge V4 — Release Notes

> Version: 1.0.0 | Arc Testnet (Chain ID: 5042002) | 2026-06-27

---

## 1. Overview

Bridge V4 replaces the legacy `ElligentCrossChainBatcher` with a modular architecture:

```
MultiSendExecutorV4 → CCTPAdapterV2 → TokenMessengerV2 → CCTP attestation
```

Key improvements over V3:
- **createRouteIntent()** creates bridge-able batch intents (missing in V3)
- **CCTPAdapterV2** uses low-level calls for Arc Testnet proxy compatibility
- **Monitoring** tracks every intent from creation to finalization
- **Session recovery** restores pending intents on wallet reconnect
- **Legacy fallback** preserved via toggle

---

## 2. Architecture

```
User
 │
 ├─ createRouteIntent(destChain, USDC, recipients, amounts)
 │   → stores intent in V4 storage, returns intentId
 │
 ├─ USDC.approve(CCTPAdapterV2, amount)
 │
 ├─ CCTPAdapterV2.configureIntent(intentId, domain, mintRecipient, 0x0)
 │   → records funder, CCTP routing params
 │
 └─ V4.executeBridgeIntent(intentId, CCTPAdapterV2)
     │
     └─ CCTPAdapterV2.sendMessage(destChain, payload)
         ├─ V4.getBatch(intentId) → reads amount
         ├─ USDC.transferFrom(funder → adapter)
         ├─ USDC.approve(TokenMessenger)
         └─ TokenMessenger.depositForBurn() [low-level call]
              ├─ USDC burn
              └─ MessageTransmitter.sendMessage()
                   → CCTP attestation → mint on destination
```

---

## 3. Contracts

| Contract | Address | Network | Verified |
|---|---|---|---|
| MultiSendExecutorV4 | `0x0a127252248ded4499C910e7E187E77C804CF19A` | Arc Testnet | ✅ |
| CCTPAdapterV2 | `0x4a0FA5928C50F23B0fbDC312434Aef41B1B1b8f2` | Arc Testnet | ✅ |
| TokenMessengerV2 | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` | Arc Testnet | ✅ (Circle) |
| MessageTransmitterV2 | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` | Arc Testnet | ✅ (Circle) |
| USDC | `0x3600000000000000000000000000000000000000` | Arc Testnet | ✅ |

### Compiler Settings

| Contract | Solidity | Optimizer |
|---|---|---|
| MultiSendExecutorV4 | v0.8.24 | 200 runs |
| CCTPAdapterV2 | v0.8.24 | 200 runs |

---

## 4. CCTP Arc Testnet Compatibility

Arc Testnet CCTP proxies suppress return data on `depositForBurn()` when called via Solidity interface from within another contract. The ABI decoder fails trying to decode empty bytes as `uint64`.

**Fix:** CCTPAdapterV2 uses `address.call()` (low-level) for all external token/bridge calls. This bypasses the ABI decoder and handles empty return data gracefully.

---

## 5. Test Results

### Integration (live on-chain)

| Test | Amount | Domain | Result |
|---|---|---|---|
| Basic | 0.001 USDC | 6 (Base) | BRIDGE_PENDING ✅ |
| Small | 0.0005 USDC | 6 (Base) | BRIDGE_PENDING ✅ |
| Medium | 0.002 USDC | 6 (Base) | BRIDGE_PENDING ✅ |
| Arbitrum | 0.001 USDC | 3 (Arb) | BRIDGE_PENDING ✅ |

All events confirmed: `RouteIntentCreated`, `BridgeMessageSent`, `BridgeInitiated`, `CCTPDepositCalled`, `DepositForBurn`, `MessageSent`.

Average bridge time: 22.3s.

### Unit Tests (Forge)

- `tests/MultiSendExecutorV4.t.sol` — 18 scenarios
- `tests/CCTPAdapterV2.t.sol` — 6 scenarios
- `tests/CCTPAdapter.t.sol` — 6 scenarios (V1)

---

## 6. Migration: V3 → V4

| Aspect | V3 (ElligentCrossChainBatcher) | V4 (Executor + Adapter) |
|---|---|---|
| Batch creation | `batchDepositForBurn()` | `createRouteIntent()` |
| Adapter | None (direct TM call) | `CCTPAdapterV2` |
| Intent tracking | None | `getIntentStatus()` + monitoring |
| Replay protection | None | Single-use config + status machine |
| Arc compatibility | Broken (high-level call) | Low-level call fix |

### Migration path

1. V4 is **default** (`useV4Bridge = true`)
2. Users who explicitly toggled OFF persist their preference via `localStorage.arcpay_use_v4`
3. New users use V4 automatically — no action needed
4. Legacy batcher remains available via Settings → Bridge V4 → toggle OFF

---

## 7. Frontend Changes

- `public/index.html`: +250 lines
- No changes to swap, wallet, payments, liquidity pool
- All existing functionality preserved

---

## 8. Monitoring & Recovery

| Feature | Description |
|---|---|
| Bridge history | localStorage (`arcpay_bridge_history`) — capped at 100 |
| Session recovery | `recoverPendingIntents()` on wallet connect |
| Metrics | Success/fail count, average time (`arcpay_bridge_metrics`) |
| Explorer links | ArcScan TX + Circle Iris CCTP message |
| Status labels | CREATED → BRIDGE_PENDING → CCTP_MESSAGE_SENT → ATTESTATION_PENDING → COMPLETED |

---

## 9. Known Limitations

- Single destination per batch (each intent targets one chain)
- CCTP attestation requires manual checking via Circle Iris (automation pending)
- Bridge step progress bar requires HTML template update (functionality works, UI pending)

---

## 10. Files

| File | Purpose |
|---|---|
| `contracts/MultiSendExecutorV4.sol` | V4 executor with createRouteIntent |
| `contracts/CCTPAdapterV2.sol` | Adapter with low-level calls |
| `contracts/interfaces/IBridgeAdapter.sol` | Bridge adapter interface |
| `public/index.html` | Frontend (V4 bridge + monitoring) |
| `deploy_v4/` | Build artifacts (ABI, bytecode, deploy scripts) |
| `tests/` | Forge test suites |
| `documentos/Bridge_V4_Release.md` | This file |
| `documentos/Bridge_V4_Final_Audit.md` | Security audit |
| `documentos/Bridge_V4_Production_Readiness.md` | Production readiness |
| `documentos/CCTPAdapter_Arc_Workaround.md` | Arc Testnet low-level call fix |
| `documentos/CCTP_Arc_MessageTransmitter_Audit.md` | CCTP infrastructure audit |
| `documentos/MultiSendExecutorV4_CCTP_Test_Report.md` | Integration test report |
| `documentos/MultiSendExecutorV7_ABI.md` | V3 bytecode analysis |
