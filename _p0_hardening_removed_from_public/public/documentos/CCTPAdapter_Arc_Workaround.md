# CCTPAdapterV2 — Arc Testnet Low-Level Call Workaround

> Date: 2026-06-27 | Arc Testnet (Chain ID: 5042002)

---

## 1. Root Cause

Arc Testnet CCTP proxies suppress return data on `depositForBurn()` when called via **Solidity interface calls** from within another contract. The Solidity ABI decoder tries to decode empty bytes as `uint64` → **REVERT**.

Low-level `address.call(...)` works because it returns `(bool, bytes)` and never tries to decode the return value.

| Call Type | Works? |
|---|---|
| `ITokenMessenger(tm).depositForBurn(...)` | ❌ |
| `tm.call(abi.encodeWithSignature("depositForBurn(...)", ...))` | ✅ |

---

## 2. Solution

**CCTPAdapterV2** replaces all external token/bridge calls with low-level `address.call()`:

```solidity
// V1 (broken):
uint64 nonce = tokenMessenger.depositForBurn(amount, domain, recipient, token, caller, 0, 2000);

// V2 (works):
(bool ok, ) = tokenMessenger.call(
    abi.encodeWithSignature(
        "depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)",
        amount, domain, recipient, token, caller, 0, 2000
    )
);
require(ok, "depositForBurn failed");
```

Same fix applied to `transferFrom` and `approve` for consistency.

---

## 3. Contracts

| Role | Address | Status |
|---|---|---|
| **CCTPAdapterV2** | `0x4a0FA5928C50F23B0fbDC312434Aef41B1B1b8f2` | ✅ Verified |
| **MultiSendExecutorV4** | `0x0a127252248ded4499C910e7E187E77C804CF19A` | ✅ Verified |
| CCTPAdapterV1 | `0xabBBE4a2aa5012328e6DCA046F09128884eFef2a` | ⚠️ Broken on Arc |
| TokenMessengerV2 | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` | CCTP |

### V2 Deploy

| Field | Value |
|---|---|
| TX | `0xbdb5b914cc8ef593962e0a03cb35ddd18cf70834bd5497dfd0fa7bc762d26aa2` |
| Block | `49025042` |
| Compiler | `v0.8.24+commit.e11b9ed9` |
| Explorer | https://testnet.arcscan.app/address/0x4a0FA5928C50F23B0fbDC312434Aef41B1B1b8f2 |

---

## 4. Integration Test Result

```
TX: 0xa44e259c523f61dee6af81b4ae2c87c15d135cb11bd8162879946600ca4a724d
Status: SUCCESS
Gas: 197,848
intentStatus: BRIDGE_PENDING (1)

Events:
  ✅ BridgeInitiated (CCTPAdapterV2)
  ✅ CCTPDepositCalled (CCTPAdapterV2)
  ✅ BridgeMessageSent (V4)
  ✅ DepositForBurn (TokenMessenger)
  ✅ MessageSent (MessageTransmitter)
```

---

## 5. Full Flow

```javascript
const V4 = "0x0a127252248ded4499C910e7E187E77C804CF19A";
const ADAPTER = "0x4a0FA5928C50F23B0fbDC312434Aef41B1B1b8f2";
const USDC = "0x3600000000000000000000000000000000000000";

// 1. Create intent
const intentId = await v4.createRouteIntent(destChain, USDC, recipients, amounts);

// 2. Approve adapter
await usdc.approve(ADAPTER, totalAmount);

// 3. Configure bridge params
await adapter.configureIntent(intentId, cctpDomain, mintRecipient, "0x00");

// 4. Execute
await v4.executeBridgeIntent(intentId, ADAPTER);
// → CREATED → BRIDGE_PENDING ✅
```

---

## 6. Files

| File | Description |
|---|---|
| `contracts/CCTPAdapterV2.sol` | V2 source (low-level calls) |
| `deploy_v4/CCTPAdapterV2.abi` | Contract ABI |
| `deploy_v4/CCTPAdapterV2.bin` | Bytecode |
| `deploy_v4/CCTPAdapterV2_flat.sol` | Flattened for verification |
| `tests/CCTPAdapterV2.t.sol` | 6 test scenarios |
