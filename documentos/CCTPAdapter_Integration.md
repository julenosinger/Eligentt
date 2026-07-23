# CCTPAdapter — Integration with MultiSendExecutorV3.0.3

> Arc Testnet | Circle CCTP v2 | Version 1.0.0

---

## 1. Architecture Overview

**Deployed CCTPAdapter:** `0xabBBE4a2aa5012328e6DCA046F09128884eFef2a`
**Explorer:** https://testnet.arcscan.app/address/0xabBBE4a2aa5012328e6DCA046F09128884eFef2a
**Status:** Verified ✅

```
User
 │
 ├─[1]─► MultiSendExecutorV3.createRouteIntent(...)  →  stores batch (amount, token, destChain)
 │
 ├─[2]─► USDC.approve(cctpAdapter, amount)            →  adapter can pull tokens
 │
 ├─[3]─► CCTPAdapter.configureIntent(intentId, domain, mintRecipient, destCaller)
 │         └─► Records funder = msg.sender
 │
 ├─[4]─► MultiSendExecutorV3.executeBridgeIntent(intentId, cctpAdapter)
 │         │
 │         └─► CCTPAdapter.sendMessage(destChain, payload)
 │               │
 │               ├─► Decodes (intentId, token) from payload
 │               ├─► Reads CCTP config from storage (validates funder != address(0))
 │               ├─► Calls executor.getBatch(intentId) → gets amount
 │               ├─► transferFrom(funder, adapter, amount)   ← pulls USDC from user
 │               ├─► approve(tokenMessenger, amount)
 │               └─► Calls TokenMessengerV2.depositForBurn(...)
 │                     │
 │                     └─► Circle CCTP attestation → destination chain mint
```

---

## 2. Contracts

| File | Contract | Purpose |
|---|---|---|
| `contracts/interfaces/IBridgeAdapter.sol` | `IBridgeAdapter` | Interface: `sendMessage(uint256, bytes)` |
| `contracts/CCTPAdapter.sol` | `CCTPAdapter` | CCTP v2 bridge adapter implementing IBridgeAdapter |

---

## 3. Real Arc Testnet Addresses

| Name | Address | Verified |
|---|---|---|
| **TokenMessengerV2** | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` | YES |
| **MessageTransmitterV2** | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` | YES |
| **USDC** | `0x3600000000000000000000000000000000000000` | YES |
| **MultiSendExecutor V3.0.3** | `0xdDF1346222ea1b6ad824430de2C4B9DB458FbFA9` | NO (pending) |

Both TokenMessenger and MessageTransmitter are `AdminUpgradableProxy` (EIP-1967) proxies pointing to Circle's official V2 implementations.

---

## 4. CCTP Domain Mapping

The adapter maps `destinationDomain` (uint32) to standard CCTP domains:

| Network | Chain ID | CCTP Domain |
|---|---|---|
| Ethereum | 1 | 0 |
| Avalanche | 43114 | 1 |
| Optimism | 10 | 2 |
| Arbitrum | 42161 | 3 |
| Base | 8453 | 6 |
| Polygon PoS | 137 | 7 |

The domain is set per-intent via `configureIntent()`. No hardcoded mappings in the adapter.

---

## 5. Constants

| Parameter | Value | Reason |
|---|---|---|
| `maxFee` | `0` | Standard CCTP transfers from Arc are free |
| `minFinalityThreshold` | `2000` | Standard finality (recommended for Arc → other chains) |

---

## 6. CCTPAdapter Interface

### Constructor
```solidity
constructor(address _tokenMessenger)
```
- `_tokenMessenger`: CCTP TokenMessengerV2 on the deployment chain

### configureIntent
```solidity
function configureIntent(
    bytes32 intentId,
    uint32 destinationDomain,
    bytes32 mintRecipient,
    bytes32 destinationCaller
) external
```
Pre-configures CCTP routing data for an intent. Must be called **before** `executeBridgeIntent`.

### clearIntent
```solidity
function clearIntent(bytes32 intentId) external
```
Removes a pre-configured intent (gas refund for storage).

### sendMessage
```solidity
function sendMessage(uint256 destinationChain, bytes calldata payload)
    external payable returns (bytes32)
```
Called by the executor. Decodes intentId/token, reads config + batch amount, executes `depositForBurn`.

### Events
```solidity
event BridgeInitiated(
    bytes32 indexed intentId,
    uint32 indexed destinationDomain,
    bytes32 indexed messageId
);
```

---

## 7. depositForBurn Parameters (CCTP v2)

```solidity
function depositForBurn(
    uint256 amount,              // Amount from executor batch
    uint32 destinationDomain,    // CCTP domain from intent config
    bytes32 mintRecipient,       // bytes32 recipient on destination
    address burnToken,           // USDC address (from payload)
    bytes32 destinationCaller,   // From intent config (0x0 for standard)
    uint256 maxFee,              // 0 (free from Arc)
    uint32 minFinalityThreshold  // 2000 (standard)
) external returns (uint64 nonce)
```

---

## 8. Usage Flow

```javascript
const ADAPTER = "0xabBBE4a2aa5012328e6DCA046F09128884eFef2a"; // Verified on Arc Testnet
const EXECUTOR = "0xdDF1346222ea1b6ad824430de2C4B9DB458FbFA9";
const USDC = "0x3600000000000000000000000000000000000000";

// 1. Create a route intent on the executor
const intentId = await executor.createRouteIntent(
    1,                    // destinationChain
    USDC,
    recipients,           // address[]
    amounts               // uint256[]
);

const amount = totalAmount;

// 2. Approve USDC to CCTPAdapter (so it can pull tokens)
await usdc.approve(ADAPTER, amount);

// 3. Configure CCTP params on the adapter
await adapter.configureIntent(
    intentId,
    0,                    // destinationDomain (0 = Ethereum)
    mintRecipientBytes32, // bytes32(uint256(uint160(recipient)))
    "0x0000000000000000000000000000000000000000000000000000000000000000"
);

// 4. Execute via executor → pulls tokens → depositForBurn
await executor.executeBridgeIntent(intentId, ADAPTER);

// 5. On destination: attest and mint via Circle CCTP
```

---

## 9. Security Notes

- **No owner, no admin, no pause** — the adapter is trustless
- **Single-use intent configs** — deleted after successful sendMessage, prevents replay
- **Reentrancy-safe** — the executor's nonReentrant modifier protects the sendMessage call
- **Amount sourced from executor** — amount is read from the executor's batch storage (authoritative), not from the adapter config
- **Token approval scoped** — only approves exactly `amount` to TokenMessenger

---

## 10. Deploy Commands (Arc Testnet)

```
Compiler: 0.8.24
Optimizer: disabled
Constructor args: ["0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA"]
```

After deployment, register the adapter address in the MultiSendExecutor's forwarder system.
