# CCTP Arc Testnet — MessageTransmitter Audit

> Date: 2026-06-27 | Arc Testnet (Chain ID: 5042002)

---

## 1. CCTP Infrastructure Status

### MessageTransmitterV2

| Field | Value |
|---|---|
| Proxy | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |
| Implementation | `0xA849059BC1F6Fff867eF77bed6fA874f77a62466` |
| `localDomain` | **26** (Arc Testnet CCTP domain) |
| `owner` | `0x643151056F7cCCD36030d6507a8C07Ed4a46E8D2` |
| `pauser` | `0x0000...` (no pauser — cannot be paused) |
| `paused` | **false** (NOT paused) |
| `attesterManager` | `0x643151056F7cCCD36030d6507a8C07Ed4a46E8D2` |
| `maxMessageBodySize` | `0` (unlimited) |
| Enabled attestors | **1** (`0x643151...`) |

### TokenMessengerV2

| Field | Value |
|---|---|
| Proxy | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` |
| Implementation | `0xF07C0ad13178a9ef5c3fFA0Be69e0BECd452Bf6D` |
| `localMessageTransmitter` | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` ✅ |
| `messageBodyVersion` | `1` |
| `owner` | `0xb941616ac6ab1d5851644cef696A5284F79CfBB9` |
| Remote messengers | Domains 0,1,2,3,5,6,7: **ALL CONFIGURED** ✅ |

### USDC

| Field | Value |
|---|---|
| Address | `0x3600000000000000000000000000000000000000` |
| Type | Proxy (EIP-1967) |
| Implementation | `0x3910b7cbb3341f1f4bf4ceb66e4a2c8f204fe2b8` |
| `transferFrom` | ✅ Working via low-level call |
| `approve` | ✅ Working (returns true) |

---

## 2. depositForBurn Behavior

### Direct EOA call → SUCCESS ✅

```
TX: 0xe67545441f141c8d4c50f1d1ba84d6e7fa15bdc0c0ee2a217cc9dcdb604a25ab
Status: SUCCESS
Gas: 120,228
Events: Transfer, Burn, MessageSent (TM), MessageReceived (MT)
```

### Contract call (CCTPAdapter) → FAILS ❌

```
TX: 0x6358eed2b92f7e9c08477eca776a286e054618d2f7586691a7a3bcaa5de92799
Status: SUCCESS (outer), FAILED (inner via try/catch)
Gas (adapter sub-call): 220,896 total
```

---

## 3. debug_traceTransaction Analysis

From the failed TX, the adapter's sendMessage execution:

| Step | Call | Input | Output |
|---|---|---|---|
| getBatch | adapter → V4 | `0x5ac44282...` | ✅ Correct data |
| transferFrom | adapter → USDC | `0x23b872dd...` | `0x00...01` (TRUE) ✅ |
| approve | adapter → USDC | `0x095ea7b3...` | `0x00...01` (TRUE) ✅ |
| depositForBurn | adapter → TM | `0x8e0250ee...` | **EMPTY** ❌ |
| ├ transferFrom | TM → USDC | `0x23b872dd...` | `0x00...01` (TRUE) ✅ |
| ├ burn | TM → burner | `...` | ✅ |
| └ sendMessage | TM → MT | `0x14b157ab...` | **EMPTY** ❌ |

The TokenMessenger successfully burns USDC but the call to MessageTransmitter.sendMessage returns empty output. This causes depositForBurn to have empty output, which causes the adapter's ABI decode to fail, reverting sendMessage.

---

## 4. Root Cause Analysis

### Hypothesis A: CCTP configuration ✅ RULED OUT
- All domains configured on TokenMessenger
- MessageTransmitter linked correctly
- Contract NOT paused
- 1 enabled attester

### Hypothesis B: Invalid domain ✅ RULED OUT
- Direct call with domain 6 works

### Hypothesis C: USDC incompatibility ✅ RULED OUT
- transferFrom and approve both work
- Burn succeeds inside depositForBurn

### Hypothesis D: **Contract caller restriction** ⚠️ MOST LIKELY

The `depositForBurn` via `TokenMessengerV2` works when called by an EOA but fails when called by a contract (CCTPAdapter). The trace shows:

1. TokenMessenger pulls USDC from adapter ✅
2. TokenMessenger burns USDC ✅
3. TokenMessenger calls MessageTransmitter.sendMessage → **returns empty** ❌

The empty return from MessageTransmitter means the call either:
- Reverted (and the burn TX by CCTP shows the revert as empty data)
- OR succeeded but returned empty data (unlikely since depositForBurn returns a nonce)

The fact that the TokenMessenger can burn USDC from the adapter but the MessageTransmitter call fails suggests a permission check that passes for EOA callers but fails for contract callers.

### Hypothesis E: **Gas forwarding issue in DELEGATECALL chain** ⚠️ POSSIBLE

The CCTPAdapter calls TokenMessenger proxy → DELEGATECALL to implementation. The implementation then calls USDC (2x) and MessageTransmitter. Each DELEGATECALL/CALL chain consumes gas. By the time MessageTransmitter is reached, the gas might be insufficient for the complex sendMessage logic.

The direct EOA call had 120K gas. The adapter sub-call used 220K gas. But with the try/catch in V4's executeBridgeIntent, gas forwarding might be limited by the 63/64 rule.

---

## 5. Recommendation

1. **Test with higher gas limit**: Try `executeBridgeIntent` with 2M+ gas to rule out gas exhaustion
2. **Check CCTP source**: Review the TokenMessengerV2 implementation to see if there's a `msg.sender` check for `depositForBurn`
3. **Use direct approve pattern**: Instead of adapter → USDC → approve → TM → depositForBurn, try having the user directly approve the TokenMessenger and skip the adapter's pull
4. **Deploy CCTPAdapter V2**: Modify the adapter to not pull tokens, but instead have the user approve TM directly and the adapter only configure the intent

---

## 6. Evidence Summary

| Contract | Check | Result |
|---|---|---|
| MessageTransmitter | Not paused | ✅ |
| MessageTransmitter | localDomain = 26 | ✅ |
| TokenMessenger | Remote domains configured | ✅ |
| TokenMessenger | localMessageTransmitter linked | ✅ |
| USDC | transferFrom works | ✅ |
| USDC | approve works | ✅ |
| depositForBurn (direct EOA) | Works | ✅ |
| depositForBurn (via contract) | Fails at MessageTransmitter | ❌ |

**Conclusion:** Arc Testnet CCTP infrastructure accepts direct EOA calls but rejects contract-originated depositForBurn at the MessageTransmitter.sendMessage step. The root cause is likely a permission check or gas limitation in the TokenMessengerV2 implementation on Arc Testnet.
