# MultiSendExecutorV4 — Migration Guide (V3.0.3 → V4)

---

## 1. Why V4?

| Issue | V3.0.3 | V4 |
|---|---|---|
| **createRouteIntent** | Missing | ✅ Added |
| **Bridge intent creation** | No public function | ✅ `createRouteIntent()` with deterministic intentId |
| **executeBridgeIntent** | Exists but unusable | ✅ Fully integrated |
| **CCTPAdapter compatibility** | Broken (no batch) | ✅ `getBatch()` returns correct data |
| **Replay protection** | Partial | ✅ Intent status machine |
| **Bridge adapter registry** | `setForwarder` only | ✅ `registerBridgeAdapter` + `getBridgeAdapter` |
| **Storage layout** | Unverified | ✅ Clean structs, deterministic intentId |

---

## 2. New Functions

### createRouteIntent

```solidity
function createRouteIntent(
    uint256 destinationChain,
    address token,
    address[] calldata recipients,
    uint256[] calldata amounts
) external nonReentrant returns (bytes32 intentId);
```

- Computes deterministic `intentId = keccak256(chainId, sender, nonce, payload)`
- Stores `RouteIntent` with amount, token, chain IDs, sender
- Sets status to `CREATED`
- Does NOT pull tokens — tokens are handled by the bridge adapter

### getRouteIntent

```solidity
function getRouteIntent(bytes32 intentId) external view returns (RouteIntent memory);
```

Returns full route data: sourceChain, destinationChain, token, creator, amount, nonce.

---

## 3. CCTPAdapter Integration Flow

```
1. executor.createRouteIntent(destChain, USDC, recipients, amounts)
   → intentId returned (deterministic)

2. USDC.approve(cctpAdapter, amount)

3. cctpAdapter.configureIntent(intentId, cctpDomain, mintRecipient, 0)

4. executor.executeBridgeIntent(intentId, cctpAdapter)
   → executor calls cctpAdapter.sendMessage(destChain, payload)
   → adapter calls executor.getBatch(intentId) → gets amount
   → adapter calls transferFrom(user, adapter, amount)
   → adapter calls TokenMessenger.depositForBurn(...)
   → status: CREATED → BRIDGE_PENDING
```

---

## 4. Deploy

| Setting | Value |
|---|---|
| Compiler | `v0.8.24+commit.e11b9ed9` |
| Optimizer | Enabled, 200 runs |
| Constructor | None |
| File | `contracts/MultiSendExecutorV4.sol` |

### Constructor args

None — empty constructor.

---

## 5. Verification (Blockscout)

```
Compiler: v0.8.24+commit.e11b9ed9
Optimization: Enabled, 200 runs
Constructor arguments: (empty)
Contract name: MultiSendExecutorV4
```

Flatten the contract (IBridgeAdapter interface inline) before submission.

---

## 6. Post-Deploy Checklist

- [ ] Deploy V4 executor
- [ ] Verify source on Blockscout
- [ ] Deploy fresh CCTPAdapter (or reuse `0xabBBE4a2...`)
- [ ] USDC approve to CCTPAdapter
- [ ] `createRouteIntent(chain, USDC, recipients, amounts)` → get intentId
- [ ] `configureIntent(intentId, domain, mintRecipient, caller)` on adapter
- [ ] `executeBridgeIntent(intentId, adapter)` → `depositForBurn`
- [ ] Verify status: CREATED → BRIDGE_PENDING
- [ ] Verify BridgeInitiated event on adapter
- [ ] Verify depositForBurn nonce on TokenMessenger
- [ ] Update frontend contract address

---

## 7. Migration Steps (V3 → V4)

1. **DO NOT unpause or modify V3** — it stays as-is
2. Deploy V4 at a NEW address
3. Point CCTPAdapter (or deploy new) to V4
4. Users create intents on V4 instead of V3
5. Existing V3 batches remain untouched
6. Frontend updates `EXECUTOR_ADDRESS` to V4

---

## 8. Storage Layout

| Slot | Variable |
|---|---|
| 0 | `nonces` mapping |
| 1 | `routes` mapping (bytes32 → RouteIntent) |
| 2 | `intentStatus` mapping |
| 3 | `adapterOf` mapping |
| 4 | `_guard` (reentrancy) |

---

## 9. Files

| File | Description |
|---|---|
| `contracts/MultiSendExecutorV4.sol` | V4 source |
| `deploy_v4/MultiSendExecutorV4.abi` | Contract ABI |
| `deploy_v4/MultiSendExecutorV4.bin` | Bytecode |
| `tests/MultiSendExecutorV4.t.sol` | 18 test scenarios |
