const { ethers } = require("ethers");

const burnTxHash = "0x53a23285cfee1d9392e86f6d6ca2c1cfddb4bc85d4cf2b4b47acfd971722ca38";

async function main() {
  // Get event message from Arc receipt
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

  // Get iris message
  const v2url = `https://iris-api-sandbox.circle.com/v2/messages/26?transactionHash=${burnTxHash}`;
  const v2resp = await fetch(v2url);
  const v2data = await v2resp.json();
  const irisMsg = v2data.messages[0].message;

  // Compare detailed
  const eventHex = eventMsg.startsWith('0x') ? eventMsg.slice(2) : eventMsg;
  const irisRaw = irisMsg.startsWith('0x') ? irisMsg.slice(2) : irisMsg;

  console.log("Event hex length:", eventHex.length);
  console.log("Iris raw length:", irisRaw.length);
  console.log("Same hex?:", eventHex === irisRaw);

  // Compare first and last 40 chars
  console.log("\nEvent first 60:", eventHex.slice(0, 60));
  console.log("Iris  first 60:", irisRaw.slice(0, 60));
  console.log("\nEvent last  60:", eventHex.slice(-60));
  console.log("Iris  last  60:", irisRaw.slice(-60));

  // Find first difference
  for (let i = 0; i < Math.min(eventHex.length, irisRaw.length); i++) {
    if (eventHex[i] !== irisRaw[i]) {
      console.log(`\nFirst difference at index ${i}: event=${eventHex.slice(i-2,i+20)} iris=${irisRaw.slice(i-2,i+20)}`);
      break;
    }
  }

  // Try mint with event message + iris attestation BUT try the Sepolia V1 MT too
  console.log("\n── Trying Base Sepolia (domain 6) MessageTransmitter ──");
  // Base Sepolia CCTP v2
  const BASE_MT = "0xf676Ae685854CFa31F42d00c90ca81923c92db24";
  const baseP = new ethers.JsonRpcProvider("https://sepolia.base.org");
  
  // Check if wallet has ETH on Base Sepolia
  const PK = process.env.PRIVATE_KEY;
  const w = new ethers.Wallet(PK);
  const baseEth = await baseP.getBalance(w.address);
  console.log("Base Sepolia ETH:", ethers.formatEther(baseEth));

  // Try staticCall
  const mt = new ethers.Contract(BASE_MT, ["function receiveMessage(bytes,bytes) returns (bool)"], w.connect(baseP));
  const att = v2data.messages[0].attestation;
  
  console.log("Event msgHash:", ethers.keccak256(eventMsg));
  
  try {
    const r = await mt.receiveMessage.staticCall(eventMsg, att);
    console.log("Base MT staticCall: PASSED!", r);
  } catch(e) {
    console.log("Base MT staticCall:", e.shortMessage || e.message);
  }

  // Also try Iris raw message
  const irisFull = irisMsg.startsWith('0x') ? irisMsg : '0x' + irisMsg;
  console.log("\nIris msgHash:", ethers.keccak256(irisFull));
  try {
    const r2 = await mt.receiveMessage.staticCall(irisFull, att);
    console.log("Base MT staticCall (iris): PASSED!", r2);
  } catch(e) {
    console.log("Base MT staticCall (iris):", e.shortMessage || e.message);
  }
}

main().catch(console.error);
