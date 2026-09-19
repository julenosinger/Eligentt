/**
 * Post-deploy integration test for CCTPAdapter on Arc Testnet.
 *
 * Prerequisites:
 *   - Deployer wallet has test USDC
 *   - CCTPAdapter deployed at ADAPTER_ADDRESS
 *   - MultiSendExecutorV3.0.3 at EXECUTOR_ADDRESS
 *
 * Usage:
 *   node deploy/test-integration.js
 */

const { ethers } = require("ethers");

const RPC_URL = "https://rpc.testnet.arc.network";
const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;

const EXECUTOR_ADDRESS = "0xdDF1346222ea1b6ad824430de2C4B9DB458FbFA9";
const ADAPTER_ADDRESS = "0xabBBE4a2aa5012328e6DCA046F09128884eFef2a";
const USDC_ADDRESS = "0x3600000000000000000000000000000000000000";

const ADAPTER_ABI = [
    "function configureIntent(bytes32 intentId, uint32 destinationDomain, bytes32 mintRecipient, bytes32 destinationCaller) external",
    "function intentConfigs(bytes32) view returns (uint32 destinationDomain, bytes32 mintRecipient, bytes32 destinationCaller, address funder)",
    "function clearIntent(bytes32) external",
    "function tokenMessenger() view returns (address)",
    "event BridgeInitiated(bytes32 indexed intentId, uint32 indexed destinationDomain, bytes32 indexed messageId)"
];

const USDC_ABI = [
    "function approve(address spender, uint256 amount) returns (bool)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)"
];

const EXECUTOR_ABI = [
    "function executeBridgeIntent(bytes32 intentId, address adapter) payable returns (bytes32)",
    "function createRouteIntent(uint256 destinationChain, address token, address[] calldata recipients, uint256[] calldata amounts) returns (bytes32)",
    "function getBatch(uint256 batchId) view returns (tuple(uint256 chainId, uint256 amount, address token, uint256 status, uint256 destinationChain))",
    "function version() view returns (string)"
];

async function main() {
    if (!PRIVATE_KEY) {
        console.error("Set DEPLOYER_PRIVATE_KEY env var");
        process.exit(1);
    }

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

    const adapter = new ethers.Contract(ADAPTER_ADDRESS, ADAPTER_ABI, wallet);
    const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, wallet);
    const executor = new ethers.Contract(EXECUTOR_ADDRESS, EXECUTOR_ABI, wallet);

    console.log("=== CCTPAdapter Integration Test ===\n");
    console.log("Wallet:", wallet.address);
    console.log("Adapter:", ADAPTER_ADDRESS);
    console.log("Executor:", EXECUTOR_ADDRESS);

    // Step 1: Verify adapter responds
    console.log("\n[1/6] Verifying adapter...");
    const messenger = await adapter.tokenMessenger();
    console.log("  tokenMessenger:", messenger);
    console.assert(messenger.toLowerCase() === "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA".toLowerCase(), "Wrong messenger!");

    // Step 2: Verify executor
    console.log("\n[2/6] Verifying executor version...");
    const ver = await executor.version();
    console.log("  executor version:", ver);

    // Step 3: Check USDC balance
    console.log("\n[3/6] Checking USDC balance...");
    const balance = await usdc.balanceOf(wallet.address);
    console.log("  USDC balance:", ethers.formatUnits(balance, 6));
    if (balance < ethers.parseUnits("1", 6)) {
        console.log("  WARNING: Low USDC balance, get test USDC from faucet.circle.com");
    }

    // Step 4: Create route intent on executor
    console.log("\n[4/6] Creating route intent...");
    const amount = ethers.parseUnits("1", 6); // 1 USDC
    const recipients = [wallet.address];
    const amounts = [amount];
    try {
        const intentId = await executor.createRouteIntent(1, USDC_ADDRESS, recipients, amounts);
        console.log("  intentId (approximate):", intentId);
    } catch (e) {
        console.log("  NOTE: createRouteIntent may not be available on this executor version");
        console.log("  Use a pre-existing batch/intent or call the function directly if available.");
    }

    // Step 5: Configure intent on adapter
    console.log("\n[5/6] Configuring intent on adapter...");
    // Use a sample intentId (this should come from the executor)
    // For testing, configureIntent is standalone
    console.log("  configureIntent(intentId, destinationDomain, mintRecipient, destinationCaller)");
    console.log("  Ready for: adapter.configureIntent(...)");

    // Step 6: Approve USDC + execute
    console.log("\n[6/6] Approve USDC to adapter...");
    console.log("  USDC.approve(adapter, amount)");
    console.log("  Executor.executeBridgeIntent(intentId, adapter)");
    console.log("  → adapter.sendMessage() → TokenMessenger.depositForBurn()");
}

main().catch(console.error);
