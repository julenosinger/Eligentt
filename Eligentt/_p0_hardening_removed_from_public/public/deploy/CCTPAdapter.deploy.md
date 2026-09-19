# CCTPAdapter — Deploy Manual (Arc Testnet)

> Status: **DEPLOYED & VERIFIED** | 2026-06-27

---

## Deploy Info

| Field | Value |
|---|---|
| **Contract** | `CCTPAdapter` |
| **Address** | `0xabBBE4a2aa5012328e6DCA046F09128884eFef2a` |
| **Deploy TX** | `0x618481e286b1e71d09f45bd5088c74432b9e7a1ca8b58cb1e0ce7f7b50c477e5` |
| **Block** | `49019098` |
| **Network** | Arc Testnet (Chain ID: 5042002) |
| **Deployer** | `0x1B2369D268631C700957aD89dAC77F658b9B758A` |
| **Verified** | YES |
| **Explorer** | https://testnet.arcscan.app/address/0xabBBE4a2aa5012328e6DCA046F09128884eFef2a |

---

## Compiler Settings

| Setting | Value |
|---|---|
| Compiler | `v0.8.24+commit.e11b9ed9` |
| Optimizer | Enabled |
| Optimizer Runs | `200` |
| EVM Version | default (shanghai) |

---

## Constructor Arguments

```
CCTPAdapter(address _tokenMessenger)

_tokenMessenger = 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA
```

Encoded: `0x0000000000000000000000008fe6b999dc680ccfdd5bf7eb0974218be2542daa`

---

## Remix Deploy Instructions

1. Open https://remix.ethereum.org
2. Create file `CCTPAdapter.sol` and paste `deploy/CCTPAdapter_flat.sol`
3. Compiler: `0.8.24+commit.e11b9ed9`
4. Enable **Optimization** → Runs: `200`
5. Deploy with MetaMask connected to Arc Testnet (RPC: `https://rpc.testnet.arc.network`, Chain ID: `5042002`)
6. Constructor argument:
```
0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA
```

---

## Foundry Deploy

```bash
forge script script/DeployCCTPAdapter.s.sol \
  --rpc-url https://rpc.testnet.arc.network \
  --broadcast \
  --verify \
  --verifier blockscout \
  --verifier-url https://testnet.arcscan.app/api
```

---

## Files

| File | Purpose |
|---|---|
| `deploy/CCTPAdapter.abi` | ABI JSON |
| `deploy/CCTPAdapter.bin` | Creation bytecode (hex) |
| `deploy/CCTPAdapter_flat.sol` | Flattened source for verification |
| `deploy/deployed.json` | Deploy metadata (address, tx, block) |
| `deploy/deploy.js` | Node.js deploy script |
| `script/DeployCCTPAdapter.s.sol` | Foundry deploy script |
| `contracts/CCTPAdapter.sol` | Source with imports |
| `contracts/interfaces/IBridgeAdapter.sol` | Bridge adapter interface |
| `tests/CCTPAdapter.t.sol` | Unit tests |

---

## Post-Deploy Checklist

- [x] Contract deployed: `0xabBBE4a2aa5012328e6DCA046F09128884eFef2a`
- [x] Source verified on Blockscout
- [x] ABI publicly available
- [x] `tokenMessenger()` returns `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`
- [x] No proxy detected
- [ ] Register CCTPAdapter in executor's forwarder system (optional)
- [ ] Fund deployer wallet with test USDC for integration test
- [ ] Create route intent on executor (`0xdDF1346222ea1b6ad824430de2C4B9DB458FbFA9`)
- [ ] Approve USDC to CCTPAdapter
- [ ] Configure intent on CCTPAdapter
- [ ] Execute bridge intent via executor
- [ ] Verify BridgeInitiated event
- [ ] Verify depositForBurn nonce on TokenMessenger
