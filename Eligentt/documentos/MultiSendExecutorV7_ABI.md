# MultiSendExecutor V7 — Audit & Verification Report

> Generated: 2026-06-27
> Status: **VERIFICATION FAILED** — Source code mismatch

---

## 1. Contract Identification

| Field | Value |
|---|---|
| **Contract Address (original)** | `0xdDF1346222ea1b6ad824430de2C4B9DB458FbFA9` |
| **Contract Address (new deploy)** | `0x15C008e6AB2bc89c073eA43969889e5506ef44E5` |
| **Network** | Arc Testnet (Chain ID: 5042002 / 0x4cef52) |
| **Explorer** | https://testnet.arcscan.app (Blockscout) |
| **RPC** | https://rpc.testnet.arc.network |
| **Bytecode match** | IDENTICAL between both addresses |

---

## 2. On-chain Bytecode Analysis

| Field | Value |
|---|---|
| **Compiler** | Solidity v0.8.24 |
| **Optimizer** | Disabled (0 runs) |
| **Proxy** | NO — direct contract (`proxy_type: null`) |
| **Libraries** | None — fully self-contained |
| **Constructor Args** | None (empty constructor, sets slot 4 = 1) |
| **Version string** | `"3.0.3"` (hardcoded in bytecode at function selector `0x54fd4d50`) |
| **Contract size** | ~7,262 bytes deployed |
| **Creation TX (original)** | `0xc765cdf13f78cbb83d81390b5cc0c4790eb4fcffbe9f9decaf72504a53d021d1` |
| **Deployer** | `0x01de545e8fea5ecaab78ec2c09e6d98117f7687d` |
| **Block** | `48740036` |

### Creation Bytecode (identical for both addresses)

```
0x60806040526001600455348015610014575f80fd5b50611c5e806100225f395ff3fe...
```

### Compiler Metadata (CBOR tail)

```
a26469706673582212204df40fb0c73263ac83fe1b847037de8d4e03312b34942f413e9bd3102a6a3fac64736f6c63430008180033
```

Decoded:
- solc version: `0.8.24` (bytes: `00 08 18`)
- optimization: `00` (disabled)

---

## 3. Function Selectors (from deployed bytecode dispatch)

### Public/External Functions

| Selector | Internal Offset | Likely Function Name |
|---|---|---|
| `0x0673c852` | 0x0135 | `batchPermitTransfer` |
| `0x129e9f8e` | 0x0156 | `revokeForwarder` |
| `0x36a4a71a` | 0x016a | `reserved` (returns 1) |
| `0x498569dc` | 0x018a | `nonce` / `batchCounter` |
| `0x54fd4d50` | 0x01b7 | `version` (returns "3.0.3") |
| `0x56c69e6e` | 0x01f4 | `getBatch` |
| `0x6a140691` | 0x02ce | `encodeBatchPayload` |
| `0x7a1c9ca7` | 0x02ed | `confirmBatch` |
| `0x7ecebe00` | 0x030c | `nonces` (mapping read) |
| `0x837f43f7` | 0x0337 | `getBatchStatus` |
| `0x8c250750` | 0x0372 | `batchTransferFrom` |
| `0x928347f6` | 0x0391 | `setForwarder` |
| `0x950bff9f` | 0x03b0 | `MAX_RECIPIENTS` (returns 256) |
| `0xad965a0e` | 0x03c5 | `executeBatch` (multisend, payable) |
| `0xaf2a8b2e` | 0x03d8 | `executeBatchWithPermit` (payable) |
| `0xba51e726` | 0x03eb | `gasFeeForBatch` |
| `0xc5bbc08f` | 0x043a | `batchPermitTransfer` (duplicate/overloaded) |
| `0xcab61621` | 0x016a | `reserved` (returns 1, duplicate) |
| `0xcac34401` | 0x016a | `reserved` (returns 1, duplicate) |
| `0xd4b69207` | 0x0459 | `executeBridgeIntent` (payable) |
| `0xef4a4d87` | 0x016a | `reserved` (returns 1, duplicate) |
| `0xfc675ca1` | 0x046c | `hashBatch` |

---

## 4. Events (extracted from bytecode logs)

| Event Topic (keccak256) | Likely Event Name |
|---|---|
| `0x94dca44b...` | `BatchPermitted` |
| `0x38e8218a...` | `BatchCompleted` |
| `0xf2fc80e2...` | `ForwarderRevoked` |
| `0x1e78f0be...` | `BatchCreated` |
| `0x7609c468...` | `BatchConfirmed` |
| `0x14c5a5fe...` | `ForwarderSet` |
| `0xa1bc4bb3...` | `MultisendExecuted` |
| `0x8128e373...` | `NativeBatchExecuted` |
| `0xe1ed2e42...` | `IntentExecuted` |
| `0x7d9233f4...` | `IntentFailed` |

---

## 5. On-chain Storage Layout

| Slot | Variable |
|---|---|
| 0 | `nonces` mapping (mapping(address => uint256)) |
| 1 | `batches` mapping (struct with token, sender, amounts, etc.) |
| 2 | `batchStatus` mapping (mapping(uint256 => enum/uint8)) |
| 3 | `forwarders` mapping (mapping(address => address)) |
| 4 | `_status` (reentrancy guard: 1 = unlocked, 2 = locked) |

---

## 6. executeBridgeIntent() Analysis

| Aspect | Detail |
|---|---|
| **Selector** | `0xd4b69207` |
| **State mutability** | `payable` (accepts ETH for bridge fees) |
| **Reentrancy guard** | Uses slot 4 (1 = unlocked, 2 = locked) |
| **Parameters** | `(bytes32 intentId, address adapter)` |
| **Returns** | `bytes32 messageId` |
| **Status machine** | CREATED(0) -> BRIDGE_PENDING(1) / FAILED(3), protected by status check |
| **Adapter** | address(0) = no-op signal (marks as BRIDGE_PENDING, returns intentId as messageId) |
| **Bridge call** | `IBridgeAdapter(adapter).sendMessage{value: msg.value}(destinationChain, payload)` |
| **Events** | `BridgeMessageSent(intentId, adapter, messageId)` or `IntentFailed(intentId)` |
| **Struct used** | Batch struct with: `(uint256 chainId, uint256 amount, address token, uint256 status, uint256 destinationChain)` |
| **Permissions** | Permissionless — anyone can call, no owner/access control |

### executeBridgeIntent Flow (from bytecode)

1. Check `_status == 1` (reentrancy guard)
2. Load batch from `batches[intentId]`
3. Revert if batch.amount == 0 (UnknownIntent)
4. Revert if `batchStatus[intentId] != 0` (AlreadyExecuted)
5. Build payload: `abi.encode(intentId, batch.token)`
6. If adapter == address(0): set status BRIDGE_PENDING, emit, return intentId
7. Else: external call to `adapter.sendMessage{value: msg.value}(batch.destinationChain, payload)`
8. On success: set status BRIDGE_PENDING, emit BridgeMessageSent
9. On revert: set status FAILED, emit IntentFailed

---

## 7. Verification Attempt

| Field | Value |
|---|---|
| **Date** | 2026-06-27 |
| **Contract** | `0x15C008e6AB2bc89c073eA43969889e5506ef44E5` |
| **Source provided** | `MultiSendExecutorV3` (version "3.0.0") |
| **Compiler used** | `v0.8.24+commit.e11b9ed9` |
| **Optimizer** | Disabled |
| **Constructor args** | (none) |
| **Result** | **FAILED** |

### Failure Reason

```
"No contract could be verified with provided data"
```

The source code provided (`MultiSendExecutorV3` with version `"3.0.0"`) does NOT match the on-chain bytecode (which contains version `"3.0.3"` and a different internal architecture). The provided source has different:
- Function names/selectors (e.g., `sendNativeBatch` vs `executeBatch`)
- Event signatures
- Internal structures
- Version string

---

## 8. What is Needed

To successfully verify, provide the source code that meets ALL of the following:

1. **Compiler**: Solidity v0.8.24 (exact version, not `^0.8.20`)
2. **Optimizer**: Disabled (0 runs)
3. **Contract name**: Must match on-chain (likely `MultiSendExecutorV7` or whatever bytecode decodes to)
4. **Version string**: Must be `"3.0.3"`
5. **Constructor**: No arguments
6. **Interface must include**: `executeBridgeIntent`, `executeBatch`, `executeBatchWithPermit`, `batchTransferFrom`, `batchPermitTransfer`, `setForwarder`, `revokeForwarder`, `confirmBatch`, `getBatch`, `getBatchStatus`, `hashBatch`, `encodeBatchPayload`, `gasFeeForBatch`, `version`, `nonce`, `MAX_RECIPIENTS`
7. **Structures**: Batch with 5 fields (chainId, amount, token, status, destinationChain), forwarder registry, batch status enum with 4 states

---

## 9. Summary

- Both addresses (`0xdDF1346222ea1b6ad824430de2C4B9DB458FbFA9` and `0x15C008e6AB2bc89c073eA43969889e5506ef44E5`) contain the SAME bytecode
- The bytecode was compiled with Solidity 0.8.24, no optimizer
- The contract is NOT a proxy, has NO constructor arguments, and uses NO external libraries
- Contract version is `"3.0.3"`, NOT `"3.0.0"`
- The provided source code (`MultiSendExecutorV3`) compiles to a DIFFERENT bytecode
- **Verification cannot proceed without the correct source code**
