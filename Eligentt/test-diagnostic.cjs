const { ethers } = require("ethers");

const ARC_RPC = "https://rpc.testnet.arc.network";
const EXECUTOR_V4 = "0x0a127252248ded4499C910e7E187E77C804CF19A";
const CCTP_ADAPTER_V2 = "0x4a0FA5928C50F23B0fbDC312434Aef41B1B1b8f2";
const USDC = "0x3600000000000000000000000000000000000000";
const TOKEN_MESSENGER = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA";

const PK = process.env.PRIVATE_KEY;

async function main() {
  const p = new ethers.JsonRpcProvider(ARC_RPC);
  const w = new ethers.Wallet(PK, p);
  console.log("Wallet:", w.address);

  const intentId = "0x55d3f341cfc88e1cd1900e898ee1b6d970b1259dc0da405bc6cd8c953e462ebc";
  const amount = ethers.parseUnits("30", 6);

  // ── Simulate executeBridgeIntent to see why it fails ──
  console.log("\n── Simulating executeBridgeIntent ──");
  const execAbi = [
    "function executeBridgeIntent(bytes32 intentId, address adapter) returns (bytes32)"
  ];
  const iface = new ethers.Interface(execAbi);
  const ebiData = iface.encodeFunctionData("executeBridgeIntent", [intentId, CCTP_ADAPTER_V2]);

  try {
    const result = await p.call({ to: EXECUTOR_V4, data: ebiData, from: w.address });
    console.log("executeBridgeIntent staticCall: PASSED", result);
  } catch(e) {
    console.log("executeBridgeIntent staticCall REVERTED:", e.shortMessage || e.message);
    if (e.data) {
      console.log("  data:", e.data);
      const errIface = new ethers.Interface([
        "error UnknownIntent()",
        "error AlreadyExecuted()",
        "error Reentrancy()"
      ]);
      try { const err = errIface.parseError(e.data); console.log("  decoded:", err.name); } catch(_) {}
    }
  }

  // ── Simulate the adapter directly ──
  console.log("\n── Simulating adapter.sendMessage (full path) ──");
  const payload = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "address"], [intentId, USDC]);
  const destChain = 11155111; // Ethereum Sepolia

  // sendMessage(uint256,bytes) selector
  const smSelector = ethers.id("sendMessage(uint256,bytes)").slice(0, 10).replace("0x", "");
  const encodedParams = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "bytes"], [destChain, payload]).slice(2);
  const smData = "0x" + smSelector + encodedParams;

  try {
    const result = await p.call({ to: CCTP_ADAPTER_V2, data: smData, from: EXECUTOR_V4 });
    console.log("sendMessage staticCall: PASSED", result);
  } catch(e) {
    console.log("sendMessage staticCall REVERTED:", e.shortMessage || e.message);
    if (e.data) {
      console.log("  data:", e.data);
      const errIface = new ethers.Interface([
        "error IntentNotConfigured(bytes32)",
        "error TransferFailed()",
        "error ApproveFailed()",
        "error DepositFailed()"
      ]);
      try { const err = errIface.parseError(e.data); console.log("  decoded:", err.name, err.args); } catch(_) {}
      try { console.log("  reason:", ethers.toUtf8String(e.data)); } catch(__) {}
    }
  }

  // ── Step-by-step: check each internal call ──
  console.log("\n── Step 1: intentConfigs ──");
  const cfgAbi = ["function intentConfigs(bytes32) view returns (uint32,bytes32,bytes32,address)"];
  const cfgIface = new ethers.Interface(cfgAbi);
  const cfgData = cfgIface.encodeFunctionData("intentConfigs", [intentId]);
  try {
    const r = await p.call({ to: CCTP_ADAPTER_V2, data: cfgData });
    const dec = ethers.AbiCoder.defaultAbiCoder().decode(["uint32","bytes32","bytes32","address"], r);
    console.log("  domain:", dec[0], "funder:", dec[3]);
  } catch(e) { console.log("  REVERTED:", e.shortMessage); }

  console.log("\n── Step 2: getBatch from executor ──");
  const gbIface = new ethers.Interface(["function getBatch(uint256) view returns (uint256,uint256,address,uint256,uint256)"]);
  const gbData = gbIface.encodeFunctionData("getBatch", [intentId]);
  try {
    const r = await p.call({ to: EXECUTOR_V4, data: gbData });
    const dec = ethers.AbiCoder.defaultAbiCoder().decode(["uint256","uint256","address","uint256","uint256"], r);
    console.log("  chainId:", dec[0].toString(), "amount:", dec[1].toString(), "token:", dec[2], "status:", dec[3].toString());
  } catch(e) { console.log("  REVERTED:", e.shortMessage); }

  console.log("\n── Step 3: USDC transferFrom (user→adapter) ──");
  const tfSig = "transferFrom(address,address,uint256)";
  const tfData = new ethers.Interface(["function " + tfSig]).encodeFunctionData("transferFrom", [w.address, CCTP_ADAPTER_V2, amount]);
  try {
    const r = await p.call({ to: USDC, data: tfData, from: CCTP_ADAPTER_V2 });
    console.log("  PASSED:", r);
  } catch(e) { console.log("  REVERTED:", e.shortMessage || e.message); if(e.data) console.log("  data:", e.data); }

  console.log("\n── Step 3b: Check allowance ──");
  const alIface = new ethers.Interface(["function allowance(address,address) view returns (uint256)"]);
  const alData = alIface.encodeFunctionData("allowance", [w.address, CCTP_ADAPTER_V2]);
  const al = await p.call({ to: USDC, data: alData });
  console.log("  allowance:", ethers.formatUnits(ethers.toBigInt(al), 6));

  console.log("\n── Step 3c: USDC transferFrom with raw call ──");
  const tfSelector = ethers.id("transferFrom(address,address,uint256)");
  const rawTf = tfSelector + ethers.AbiCoder.defaultAbiCoder().encode(["address","address","uint256"], [w.address, CCTP_ADAPTER_V2, amount]).slice(2);
  try {
    const r = await p.call({ to: USDC, data: rawTf, from: CCTP_ADAPTER_V2 });
    console.log("  raw call PASSED:", r);
  } catch(e) { console.log("  raw call REVERTED:", e.shortMessage || e.message); if(e.data) console.log("  data:", e.data); }

  console.log("\n═══ DONE ═══");
}

main().catch(console.error);
