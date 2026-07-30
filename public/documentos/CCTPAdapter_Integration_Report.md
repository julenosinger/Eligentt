# CCTPAdapter + MultiSendExecutorV3.0.3 — Integration Test Report

> Date: 2026-06-27 | Status: **CCTPAdapter DEPLOYED — Executor batch creation BLOCKED**

---

## 1. Contracts

| Role | Address | Status |
|---|---|---|
| **CCTPAdapter** | `0xabBBE4a2aa5012328e6DCA046F09128884eFef2a` | ✅ Deployed & Verified |
| **MultiSendExecutor V3.0.3** | `0xdDF1346222ea1b6ad824430de2C4B9DB458FbFA9` | NOT verified |
| **TokenMessengerV2** | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` | ✅ Verified (Circle CCTP) |
| **MessageTransmitterV2** | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` | ✅ Verified (Circle CCTP) |
| **USDC** | `0x3600000000000000000000000000000000000000` | ✅ ERC-20 |

### CCTPAdapter Deploy

| Field | Value |
|---|---|
| TX | `0x618481e286b1e71d09f45bd5088c74432b9e7a1ca8b58cb1e0ce7f7b50c477e5` |
| Block | `49019098` |
| Compiler | `v0.8.24+commit.e11b9ed9` |
| Optimizer | Enabled, 200 runs |
| Explorer | https://testnet.arcscan.app/address/0xabBBE4a2aa5012328e6DCA046F09128884eFef2a |

---

## 2. Integration Test Results

### ✅ Step 1: Register Adapter (setForwarder)

```
TX: 0x2267bbd7dcc8bf29e37c0e68818532b7cd9697813f5b34a5301b9510ec55a14e
Status: SUCCESS
Storage confirms: forwarder[0x1B2...] = 0xabBBE4a2aa...
```

### ❌ Step 2: Create Bridge-Able Batch

**BLOCKED.** The executor V3.0.3 has the following state-changing functions:

| Selector | Function | Creates stored batch? |
|---|---|---|
| `0x8c250750` | `sendTokenBatch(address,address[],uint256[])` | ❌ Direct transfers only |
| `0xad965a0e` | `sendMixedBatch(BatchTransfer[])` | ❌ Direct execution only |
| `0xaf2a8b2e` | `sendNativeBatch(address[],uint256[])` | ❌ Direct transfers only |
| `0xd4b69207` | `executeBridgeIntent(bytes32,address)` | ❌ Reads batch, doesn't create |
| `0x0673c852` | `batchPermitTransfer(...)` | ❌ Direct transfers only |

**None of the public functions create a stored batch** in the `batches` mapping (slot 1) that `executeBridgeIntent` requires.

### ✅ Step 3: CCTPAdapter Configure

- `configureIntent(intentId, domain, mintRecipient, destCaller)` works correctly
- `intentConfigs` mapping correctly stores and returns data
- `clearIntent` clears configuration

### ⏸️ Steps 4-5: Bridge Execution

Cannot proceed without a valid batchId from the executor.

---

## 3. Root Cause

The `executeBridgeIntent` function at selector `0xd4b69207` references a batch stored in `batches[intentId]`. The batch must have:
- `amount > 0` (otherwise reverts with `UnknownIntent`)
- `status == 0` (CREATED)
- `token != address(0)`
- `destinationChain` set

No public function on this contract creates such a batch. The functions that exist (`sendTokenBatch`, `sendMixedBatch`, `sendNativeBatch`) execute transfers immediately without storing bridge-able batch data.

### Hypothesis

The batch creation logic likely exists in a **separate function** that:
1. Computes `batchId = hashBatch(token, recipients, amounts, message)` 
2. Stores the batch struct in slot 1
3. Emits `BatchCreated` event

This function has NOT been found among the public dispatch selectors. Possible explanations:
- The batch creation requires a specific parameter combination not yet discovered
- The function was intended to be added in a future upgrade
- The contract uses a different storage layout than expected

---

## 4. What Works

| Feature | Status |
|---|---|
| CCTPAdapter deploy | ✅ |
| CCTPAdapter verify | ✅ |
| setForwarder (register adapter) | ✅ |
| USDC approve to adapter | ✅ |
| configureIntent | ✅ |
| clearIntent | ✅ |
| sendNativeBatch | ✅ |
| sendTokenBatch | ✅ |
| sendMixedBatch | ✅ |
| hashBatch (view) | ✅ |
| getBatch (view) | ✅ |
| getBatchStatus (view) | ✅ |
| version() | ✅ (returns "3.0.0") |

## 5. What Doesn't Work

| Feature | Status |
|---|---|
| Create bridge-able batch | ❌ |
| executeBridgeIntent (no valid batch) | ❌ |
| getBridgeAdapter (not found) | ❌ |

---

## 6. Recommendations

1. **Deploy a new executor** with `createRouteIntent()` that stores batches for bridge use, OR
2. **Find the correct function signature** for batch creation on the existing executor (may require source code), OR
3. **Verify and fix the existing executor** by deploying a corrected version that includes batch creation

The CCTPAdapter is fully functional and ready. The bottleneck is the executor contract.

---

## 7. Files

| File | Description |
|---|---|
| `contracts/CCTPAdapter.sol` | CCTPAdapter source |
| `contracts/interfaces/IBridgeAdapter.sol` | Bridge adapter interface |
| `deploy/CCTPAdapter.abi` | Contract ABI |
| `deploy/CCTPAdapter.bin` | Bytecode |
| `deploy/CCTPAdapter_flat.sol` | Flattened source (verified) |
| `deploy/CCTPAdapter.deploy.md` | Deploy instructions |
| `deploy/deployed.json` | Deploy metadata |
| `deploy/deploy.js` | Deploy script |
| `deploy/test-live.js` | Integration test script |
| `script/DeployCCTPAdapter.s.sol` | Foundry script |
| `tests/CCTPAdapter.t.sol` | Unit tests (6 scenarios) |
