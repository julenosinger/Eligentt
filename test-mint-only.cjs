const { ethers } = require("ethers");

const burnTxHash = "0x53a23285cfee1d9392e86f6d6ca2c1cfddb4bc85d4cf2b4b47acfd971722ca38";
const SEPOLIA_MT = "0x7865fAfC2db2093669d92c0F33AeEF291086BEFD";
const PK = process.env.PRIVATE_KEY;

async function main() {
  const w = new ethers.Wallet(PK);

  // Get event message from Arc receipt (the corrupted one attesters signed)
  const arcP = new ethers.JsonRpcProvider("https://rpc.testnet.arc.network");
  const receipt = await arcP.getTransactionReceipt(burnTxHash);
  const MT = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275";
  let eventMsg;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() === MT.toLowerCase() && log.topics[0] === '0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036') {
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['bytes'], log.data);
      eventMsg = ethers.hexlify(decoded[0]);
      break;
    }
  }

  // Get attestation from Iris
  const v2url = `https://iris-api-sandbox.circle.com/v2/messages/26?transactionHash=${burnTxHash}`;
  const v2resp = await fetch(v2url);
  const v2data = await v2resp.json();
  const irisMsg = v2data.messages[0];
  const attestation = irisMsg.attestation;
  const irisFullMsg = irisMsg.message.startsWith('0x') ? irisMsg.message : '0x' + irisMsg.message;

  console.log("Event message hash:", ethers.keccak256(eventMsg));
  console.log("Iris message hash:", ethers.keccak256(irisFullMsg));
  console.log("Attestation length:", (attestation.length-2)/2);

  const sepP = new ethers.JsonRpcProvider("https://sepolia.gateway.tenderly.co");
  const sepW = w.connect(sepP);
  const eth = await sepP.getBalance(w.address);
  console.log("Sepolia ETH:", ethers.formatEther(eth));

  const mt = new ethers.Contract(SEPOLIA_MT, ["function receiveMessage(bytes,bytes) returns (bool)"], sepW);

  // Try 1: Event message
  console.log("\n── Try 1: Event message (from Arc receipt) ──");
  try {
    const r = await mt.receiveMessage.staticCall(eventMsg, attestation);
    console.log("PASSED!", r);
    const tx = await mt.receiveMessage(eventMsg, attestation, { gasLimit: 400000 });
    console.log("TX:", tx.hash);
    console.log("Explorer:", `https://sepolia.etherscan.io/tx/${tx.hash}`);
    const rr = await tx.wait();
    console.log("Status:", rr.status === 1 ? "✓ SUCCESS" : "FAIL");
  } catch(e) {
    console.log("REVERT:", e.shortMessage || e.message);
    if(e.data) try { console.log("  reason:", ethers.toUtf8String(e.data)); } catch(_) {}
  }

  // Try 2: Full Iris message
  console.log("\n── Try 2: Iris V2 message ──");
  try {
    const r = await mt.receiveMessage.staticCall(irisFullMsg, attestation);
    console.log("PASSED!", r);
    const tx = await mt.receiveMessage(irisFullMsg, attestation, { gasLimit: 400000 });
    console.log("TX:", tx.hash);
    console.log("Explorer:", `https://sepolia.etherscan.io/tx/${tx.hash}`);
    const rr = await tx.wait();
    console.log("Status:", rr.status === 1 ? "✓ SUCCESS" : "FAIL");
  } catch(e) {
    console.log("REVERT:", e.shortMessage || e.message);
    if(e.data) try { console.log("  reason:", ethers.toUtf8String(e.data)); } catch(_) {}
  }
}

main().catch(console.error);
