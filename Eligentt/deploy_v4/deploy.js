const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const RPC = "https://rpc.testnet.arc.network";
const PK = process.env.DEPLOYER_PRIVATE_KEY;

async function main() {
    if (!PK) { console.error("Set DEPLOYER_PRIVATE_KEY"); process.exit(1); }
    const provider = new ethers.JsonRpcProvider(RPC);
    const wallet = new ethers.Wallet(PK, provider);

    const abi = JSON.parse(fs.readFileSync(path.join(__dirname, "MultiSendExecutorV4.abi"), "utf8"));
    const bytecode = "0x" + fs.readFileSync(path.join(__dirname, "MultiSendExecutorV4.bin"), "utf8").trim();

    console.log("Deployer:", wallet.address);
    console.log("ETH:", ethers.formatEther(await provider.getBalance(wallet.address)));
    console.log("Bytecode:", bytecode.length, "chars");

    const factory = new ethers.ContractFactory(abi, bytecode, wallet);
    console.log("\nDeploying MultiSendExecutorV4...");
    const contract = await factory.deploy();
    await contract.waitForDeployment();

    const address = await contract.getAddress();
    const deployTx = contract.deploymentTransaction();
    const receipt = await deployTx.wait();

    console.log("\n=== DEPLOY COMPLETE ===");
    console.log("MultiSendExecutorV4:", address);
    console.log("Deploy TX:", deployTx.hash);
    console.log("Block:", receipt.blockNumber);
    console.log("Gas:", receipt.gasUsed.toString());

    const ver = await contract.version();
    console.log("Version:", ver);

    fs.writeFileSync(path.join(__dirname, "deployed_v4.json"), JSON.stringify({
        address: address,
        deployTx: deployTx.hash,
        block: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        version: ver,
        network: "Arc Testnet",
        chainId: 5042002,
        compiler: "0.8.24",
        optimizer: "enabled",
        optimizerRuns: 200,
        deployer: wallet.address
    }, null, 2));
    console.log("\nSaved to deployed_v4.json");
}

main().catch(console.error);
