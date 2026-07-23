const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

async function main() {
    const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
    if (!PRIVATE_KEY) {
        console.error("Set DEPLOYER_PRIVATE_KEY environment variable");
        process.exit(1);
    }

    const RPC_URL = "https://rpc.testnet.arc.network";
    const TOKEN_MESSENGER = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA";

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

    const abi = JSON.parse(fs.readFileSync(path.join(__dirname, "CCTPAdapter.abi"), "utf8"));
    const bytecode = "0x" + fs.readFileSync(path.join(__dirname, "CCTPAdapter.bin"), "utf8").trim();

    console.log("Deployer:", wallet.address);
    console.log("Network: Arc Testnet (5042002)");
    console.log("TokenMessenger:", TOKEN_MESSENGER);
    console.log("Bytecode length:", bytecode.length, "chars");

    const balance = await provider.getBalance(wallet.address);
    console.log("Balance:", ethers.formatEther(balance), "ETH (for gas on Arc)");

    const factory = new ethers.ContractFactory(abi, bytecode, wallet);
    console.log("\nDeploying CCTPAdapter...");

    const contract = await factory.deploy(TOKEN_MESSENGER);
    await contract.waitForDeployment();

    const address = await contract.getAddress();
    const deployTx = contract.deploymentTransaction();

    console.log("\n=== DEPLOY COMPLETE ===");
    console.log("CCTPAdapter address:", address);
    console.log("Deploy TX:", deployTx.hash);
    console.log("Block:", deployTx.blockNumber);
    console.log("Network: Arc Testnet (5042002)");

    const deployedMessenger = await contract.tokenMessenger();
    console.log("tokenMessenger():", deployedMessenger);
    console.log("tokenMessenger matches:", deployedMessenger.toLowerCase() === TOKEN_MESSENGER.toLowerCase());

    fs.writeFileSync(path.join(__dirname, "deployed.json"), JSON.stringify({
        address: address,
        deployTx: deployTx.hash,
        block: deployTx.blockNumber,
        network: "Arc Testnet",
        chainId: 5042002,
        tokenMessenger: TOKEN_MESSENGER,
        compiler: "0.8.24",
        optimizer: "enabled",
        optimizerRuns: 200
    }, null, 2));

    console.log("\nSaved to deploy/deployed.json");
}

main().catch(console.error);
