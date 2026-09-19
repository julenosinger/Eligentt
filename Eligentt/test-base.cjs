const { ethers } = require("ethers");

const burnTxHash = "0x53a23285cfee1d9392e86f6d6ca2c1cfddb4bc85d4cf2b4b47acfd971722ca38";
const PK = process.env.PRIVATE_KEY;

async function main() {
  const w = new ethers.Wallet(PK);

  // Get Iris data
  const v2url = `https://iris-api-sandbox.circle.com/v2/messages/26?transactionHash=${burnTxHash}`;
  const v2resp = await fetch(v2url);
  const v2data = await v2resp.json();
  const irisMsg = v2data.messages[0];
  const att = irisMsg.attestation;
  const irisFullMsg = irisMsg.message.startsWith('0x') ? irisMsg.message : '0x' + irisMsg.message;
  console.log("Iris status:", irisMsg.status);
  console.log("Message hash:", ethers.keccak256(irisFullMsg));

  // Base Sepolia CCTP V2 MessageTransmitter
  // Find it from the TokenMessenger on Base Sepolia
  const baseRPC = "https://sepolia.base.org";
  const baseP = new ethers.JsonRpcProvider(baseRPC);
  
  // Known Base Sepolia CCTP addresses
  const BASE_TM = "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5"; // try this
  let BASE_MT;
  
  // Try to read MT from TM
  try {
    const tm = new ethers.Contract(BASE_TM, ["function localMessageTransmitter() view returns (address)"], baseP);
    BASE_MT = await tm.localMessageTransmitter();
    console.log("MessageTransmitter:", BASE_MT);
  } catch(e) {
    // Fallback: try known V2 addresses for Base Sepolia
    console.log("TM read failed, trying known addresses...");
    const candidates = [
      "0x7865fAfC2db2093669d92c0F33AeEF291086BEFD",  // same as Sepolia V2
      "0xf676Ae685854CFa31F42d00c90ca81923c92db24",
      "0x28eA2cFFa67A59D027c3aDE8304AaE2E32001aA2",
    ];
    for (const addr of candidates) {
      try {
        const code = await baseP.getCode(addr);
        if (code && code !== '0x') {
          console.log("Found contract at:", addr, "code:", code.length, "bytes");
          BASE_MT = addr;
          break;
        }
      } catch(_) {}
    }
  }

  if (!BASE_MT) { console.log("Could not find MT"); return; }

  console.log("ETH:", ethers.formatEther(await baseP.getBalance(w.address)));
  
  const baseW = w.connect(baseP);
  const mt = new ethers.Contract(BASE_MT, ["function receiveMessage(bytes,bytes) returns (bool)"], baseW);

  // Try to check domain
  try {
    const dm = new ethers.Contract(BASE_MT, ["function localDomain() view returns (uint32)"], baseP);
    const d = await dm.localDomain();
    console.log("MT localDomain:", d.toString());
  } catch(e) { console.log("localDomain not available"); }

  // staticCall
  console.log("\n── staticCall ──");
  try {
    const r = await mt.receiveMessage.staticCall(irisFullMsg, att);
    console.log("PASSED!", r);
  } catch(e) {
    console.log("REVERT:", e.shortMessage || e.message);
    if(e.data) try { console.log("  reason:", ethers.toUtf8String(e.data)); } catch(_) {}
    return;
  }

  // Send!
  console.log("\n── Sending TX ──");
  try {
    const tx = await mt.receiveMessage(irisFullMsg, att, { gasLimit: 400000 });
    console.log("TX:", tx.hash);
    console.log("Explorer:", `https://sepolia.basescan.org/tx/${tx.hash}`);
    const r = await tx.wait();
    console.log("Status:", r.status === 1 ? "✓ SUCCESS" : "FAIL");
    console.log("Gas:", r.gasUsed.toString());

    console.log("\n═══════════════════════════════");
    console.log("Burn (Arc):  ", `https://arc-testnet.blockscout.com/tx/${burnTxHash}`);
    console.log("Mint (Base): ", `https://sepolia.basescan.org/tx/${tx.hash}`);
    console.log("═══════════════════════════════");
  } catch(e) {
    console.log("TX FAILED:", e.shortMessage || e.message);
    if(e.data) try { console.log("  reason:", ethers.toUtf8String(e.data)); } catch(_) {}
  }
}

main().catch(console.error);
