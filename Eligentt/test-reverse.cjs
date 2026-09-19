const { ethers } = require("ethers");

const PK = process.env.PRIVATE_KEY;
const burnTxHash = "0x518819f84d34454fa44d786d5389baf99a08d311c36ff9fe4a258932894b7e9c";
const BASE_DOMAIN = 6;
const SEPOLIA_RPC = "https://sepolia.gateway.tenderly.co";
const SEPOLIA_MT = "0x7865fAfC2db2093669d92c0F33AeEF291086BEFD";

async function main() {
  const w = new ethers.Wallet(PK);

  // Get message + attestation from Iris
  console.log("── Iris V2 (srcDomain=6) ──");
  let messageBytesRaw, attestationSig;
  for (let i = 1; i <= 60; i++) {
    try {
      const v2url = `https://iris-api-sandbox.circle.com/v2/messages/${BASE_DOMAIN}?transactionHash=${burnTxHash}`;
      const v2resp = await fetch(v2url);
      if (v2resp.ok) {
        const v2data = await v2resp.json();
        if (v2data?.messages?.[0]) {
          const m = v2data.messages[0];
          if (m.status === 'complete' && m.attestation) {
            messageBytesRaw = m.message.startsWith('0x') ? m.message : '0x' + m.message;
            attestationSig = m.attestation;
            console.log(`Attempt ${i}: ✓ COMPLETE`);
            console.log("  sourceDomain:", m.sourceDomain);
            console.log("  destinationDomain:", m.destinationDomain);
            break;
          }
        }
      }
      process.stdout.write('.');
    } catch(e) { process.stdout.write('e'); }
    await new Promise(r => setTimeout(r, 5000));
  }

  if (!attestationSig) { console.log("\nNot ready"); return; }

  console.log("\nmessageHash:", ethers.keccak256(messageBytesRaw));
  console.log("attestation:", attestationSig.length, "chars");

  // Mint on Sepolia
  console.log("\n── Mint on Sepolia ──");
  const sepP = new ethers.JsonRpcProvider(SEPOLIA_RPC);
  const sepW = w.connect(sepP);
  console.log("ETH:", ethers.formatEther(await sepP.getBalance(w.address)));

  const mt = new ethers.Contract(SEPOLIA_MT, ["function receiveMessage(bytes,bytes) returns (bool)"], sepW);

  try {
    const r = await mt.receiveMessage.staticCall(messageBytesRaw, attestationSig);
    console.log("staticCall: PASSED!");
  } catch(e) {
    console.log("staticCall:", e.shortMessage || e.message);
    if(e.data) try { console.log("  reason:", ethers.toUtf8String(e.data)); } catch(_) {}
    return;
  }

  try {
    const tx = await mt.receiveMessage(messageBytesRaw, attestationSig, { gasLimit: 400000 });
    console.log("Mint TX:", tx.hash);
    console.log("Explorer:", `https://sepolia.etherscan.io/tx/${tx.hash}`);
    const r = await tx.wait();
    console.log("Status:", r.status === 1 ? "✓ SUCCESS" : "FAIL");
    console.log("\n══════════════════════════════");
    console.log("Burn (Base): ", `https://sepolia.basescan.org/tx/${burnTxHash}`);
    console.log("Mint (Sepolia):", `https://sepolia.etherscan.io/tx/${tx.hash}`);
    console.log("══════════════════════════════");
  } catch(e) {
    console.log("REVERT:", e.shortMessage || e.message);
    if(e.data) try { console.log("  reason:", ethers.toUtf8String(e.data)); } catch(_) {}
  }
}

main().catch(console.error);
