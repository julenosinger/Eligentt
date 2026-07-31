const { ethers } = require("ethers");

const ARC_RPC = "https://rpc.testnet.arc.network";
const EXECUTOR_V4 = "0x0a127252248ded4499C910e7E187E77C804CF19A";
const CCTP_ADAPTER_V2 = "0x4a0FA5928C50F23B0fbDC312434Aef41B1B1b8f2";
const USDC = "0x3600000000000000000000000000000000000000";
const SEPOLIA_MT = "0x7865fAfC2db2093669d92c0F33AeEF291086BEFD";
const SEPOLIA_RPC = "https://rpc.sepolia.org";
const SEPOLIA_DOMAIN = 0;
const SEPOLIA_CHAIN_ID = 11155111;

const PK = process.env.PRIVATE_KEY;

async function main() {
  const p = new ethers.JsonRpcProvider(ARC_RPC);
  const w = new ethers.Wallet(PK, p);
  console.log("Wallet:", w.address);

  const usdc = new ethers.Contract(USDC, [
    "function approve(address,uint256) returns (bool)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)"
  ], w);

  const bal = await usdc.balanceOf(w.address);
  console.log("USDC:", ethers.formatUnits(bal, 6));
  const ethBal = await p.getBalance(w.address);
  console.log("ETH:", ethers.formatEther(ethBal));

  const amount = ethers.parseUnits("1", 6);
  console.log("Amount: 1 USDC");

  // ── 1. createRouteIntent ──
  console.log("\n══ 1. createRouteIntent ══");
  const execAbi = [
    "function createRouteIntent(uint256 destinationChain, address token, address[] recipients, uint256[] amounts) returns (bytes32 intentId)",
    "function executeBridgeIntent(bytes32 intentId, address adapter) returns (bytes32 messageId)",
    "function getIntentStatus(bytes32 intentId) view returns (uint8)",
    "event RouteIntentCreated(bytes32 indexed intentId, address indexed sender, uint256 indexed destinationChain)"
  ];
  const executor = new ethers.Contract(EXECUTOR_V4, execAbi, w);

  const tx1 = await executor.createRouteIntent(SEPOLIA_CHAIN_ID, USDC, [w.address], [amount], { gasLimit: 400000 });
  const r1 = await tx1.wait();
  console.log("TX:", tx1.hash, r1.status === 1 ? "✓" : "FAIL");
  console.log("Gas:", r1.gasUsed.toString());

  let intentId;
  for (const log of r1.logs) {
    console.log("  log:", log.address.slice(0,10) + "...", log.topics.length, "topics");
    if (log.topics.length >= 3) {
      intentId = log.topics[1];
      console.log("  intentId from topic:", intentId);
    }
  }
  if (!intentId) { console.log("FAIL: no intentId"); return; }

  // ── 2. approve USDC ──
  console.log("\n══ 2. approve ══");
  const approval = await usdc.allowance(w.address, CCTP_ADAPTER_V2);
  console.log("Allowance:", ethers.formatUnits(approval, 6));
  if (approval < amount) {
    const atx = await usdc.approve(CCTP_ADAPTER_V2, amount);
    await atx.wait();
    console.log("Approved:", atx.hash, "✓");
  } else {
    console.log("Allowance sufficient");
  }

  // ── 3. configureIntent ──
  console.log("\n══ 3. configureIntent ══");
  const adapter = new ethers.Contract(CCTP_ADAPTER_V2, [
    "function configureIntent(bytes32 intentId, uint32 destinationDomain, bytes32 mintRecipient, bytes32 destinationCaller)",
    "function intentConfigs(bytes32) view returns (uint32,bytes32,bytes32,address)",
    "event BridgeInitiated(bytes32 indexed, uint32 indexed, bytes32 indexed)"
  ], w);
  const mintRecipient = ethers.zeroPadValue(w.address, 32);
  const cfgTx = await adapter.configureIntent(intentId, SEPOLIA_DOMAIN, mintRecipient, ethers.ZeroHash);
  await cfgTx.wait();
  console.log("configureIntent:", cfgTx.hash, "✓");

  const cfg = await adapter.intentConfigs(intentId);
  console.log("Config — domain:", cfg[0].toString(), "funder:", cfg[3]);

  // ── 4. executeBridgeIntent ──
  console.log("\n══ 4. executeBridgeIntent ══");
  let burnTxHash, messageHash, messageBytesRaw, attestationSig;
  try {
    const tx4 = await executor.executeBridgeIntent(intentId, CCTP_ADAPTER_V2, { gasLimit: 1500000 });
    const r4 = await tx4.wait();
    burnTxHash = tx4.hash;
    console.log("TX:", tx4.hash, r4.status === 1 ? "✓" : "FAIL");
    console.log("Gas:", r4.gasUsed.toString());
    console.log("Arc Explorer:", `https://arc-testnet.blockscout.com/tx/${tx4.hash}`);

    const MT = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275".toLowerCase();
    const TM = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA".toLowerCase();

    for (const log of r4.logs) {
      const addr = log.address.toLowerCase();
      console.log("  event:", addr.slice(0,14)+"...", "topic0:", log.topics[0]?.slice(0,14)+"...");

      if (addr === CCTP_ADAPTER_V2.toLowerCase() && log.topics[0] === '0x1c76e0645a3d36403c3ec57714bb25f4c93bf4f993afab89a0af10b2f44fbd46') {
        console.log("  >>> BridgeInitiated");
      }
      if (addr === MT.toLowerCase() && log.topics[0] === '0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036') {
        try {
          const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['bytes'], log.data);
          messageBytesRaw = ethers.hexlify(decoded[0]);
          messageHash = ethers.keccak256(messageBytesRaw);
          console.log("  >>> MessageSent — hash:", messageHash);
          const hex = messageBytesRaw.startsWith('0x') ? messageBytesRaw.slice(2) : messageBytesRaw;
          console.log("      srcDomain:", Number(BigInt('0x' + hex.slice(72, 80))));
          console.log("      dstDomain:", Number(BigInt('0x' + hex.slice(80, 88))));
        } catch(e) { console.log("  decode err:", e.message); }
      }
    }
  } catch(e) {
    console.log("REVERT:", e.shortMessage || e.message);
    if (e.data) {
      console.log("  data:", e.data);
      const errIface = new ethers.Interface([
        "error TransferFailed()", "error IntentNotConfigured(bytes32)", "error UnknownIntent()", "error AlreadyExecuted()",
        "error ApproveFailed()", "error DepositFailed()"
      ]);
      try { const err = errIface.parseError(e.data); console.log("  decoded:", err.name); } catch(_) {
        try { console.log("  reason:", ethers.toUtf8String(e.data)); } catch(__) {}
      }
    }
    return;
  }

  const status = await executor.getIntentStatus(intentId);
  console.log("Intent status:", status.toString(), "(0=CREATED,1=PENDING,2=EXECUTED,3=FAILED)");

  if (!messageHash) {
    console.log("\n❌ No MessageSent — intent FAILED");
    return;
  }

  // ── 5. Poll Iris ──
  console.log("\n══ 5. Polling Iris for attestation ══");
  for (let i = 1; i <= 60; i++) {
    try {
      const url = `https://iris-api-sandbox.circle.com/attestations/${messageHash}`;
      const resp = await fetch(url);
      if (resp.ok) {
        const data = await resp.json();
        if (data && data.status === 'complete' && data.attestation) {
          attestationSig = data.attestation;
          console.log(`\nAttempt ${i}: ✓ COMPLETE — sig length: ${attestationSig.length}`);
          break;
        }
      }
      process.stdout.write(`.`);
    } catch(e) { process.stdout.write(`e`); }
    await new Promise(r => setTimeout(r, 5000));
  }

  if (!attestationSig) {
    console.log("\n⚠ Max attempts reached. Run mint manually with:");
    console.log("messageBytesRaw:", messageBytesRaw);
    return;
  }

  // ── 6. Mint ──
  console.log("\n══ 6. Mint on Ethereum Sepolia ══");
  const sepP = new ethers.JsonRpcProvider(SEPOLIA_RPC);
  const sepEth = await sepP.getBalance(w.address);
  console.log("Sepolia ETH:", ethers.formatEther(sepEth));

  if (sepEth === 0n) {
    console.log("⚠ No Sepolia ETH. Fund:", w.address);
    console.log("Then manually run mint with:");
    console.log("  messageBytesRaw:", messageBytesRaw);
    console.log("  attestationSig:", attestationSig);
    return;
  }

  const sepW = w.connect(sepP);
  const mt = new ethers.Contract(SEPOLIA_MT, ["function receiveMessage(bytes,bytes) returns (bool)"], sepW);

  const calcHash = ethers.keccak256(messageBytesRaw);
  console.log("\n[V4 FINAL MINT CHECK]");
  console.log("messageHash:", messageHash);
  console.log("calcHash:", calcHash);
  console.log("hashMatch:", calcHash === messageHash);
  console.log("sigBytes:", (attestationSig.length - 2) / 2);

  try {
    const mintTx = await mt.receiveMessage(messageBytesRaw, attestationSig, { gasLimit: 500000 });
    console.log("\nMint TX:", mintTx.hash);
    console.log("Sepolia Explorer:", `https://sepolia.etherscan.io/tx/${mintTx.hash}`);
    const mr = await mintTx.wait();
    console.log("Status:", mr.status === 1 ? "✓ SUCCESS" : "FAIL");
    console.log("Gas:", mr.gasUsed.toString());

    console.log("\n═══════════════════════════════");
    console.log("Burn (Arc):    ", `https://arc-testnet.blockscout.com/tx/${burnTxHash}`);
    console.log("Mint (Sepolia):", `https://sepolia.etherscan.io/tx/${mintTx.hash}`);
    console.log("═══════════════════════════════");
  } catch(e) {
    console.log("Mint REVERT:", e.shortMessage || e.message);
    if (e.data) console.log("  data:", e.data);
  }
}

main().catch(console.error);
