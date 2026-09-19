const { ethers } = require("ethers");

const RPC = "https://rpc.testnet.arc.network";
const PK = process.env.DEPLOYER_PRIVATE_KEY;
const EXECUTOR = "0xdDF1346222ea1b6ad824430de2C4B9DB458FbFA9";
const ADAPTER = "0xabBBE4a2aa5012328e6DCA046F09128884eFef2a";
const USDC = "0x3600000000000000000000000000000000000000";

const S = {
    version: "0x54fd4d50",
    // sendNativeBatch(address[],uint256[]) payable - selector 0xaf2a8b2e
    sendNativeBatch: "0xaf2a8b2e",
    // batchTransferFrom(address,address[],uint256[]) - creates batch + transfers
    batchTransferFrom: "0x8c250750",
    // executeBridgeIntent(bytes32,address) payable
    executeBridgeIntent: "0xd4b69207",
    // getBatch(uint256) returns struct
    getBatch: "0x56c69e6e",
    // getBatchStatus(uint256) returns uint8
    getBatchStatus: "0x837f43f7",
    // setForwarder(address)
    setForwarder: "0x928347f6",
    // hashBatch(address,address[],uint256[],bytes) - view
    hashBatch: "0xfc675ca1",
    // version()
    getVersion: "0x54fd4d50",
};

async function main() {
    if (!PK) { console.error("Set DEPLOYER_PRIVATE_KEY"); process.exit(1); }
    const p = new ethers.JsonRpcProvider(RPC);
    const w = new ethers.Wallet(PK, p);
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    console.log("Wallet:", w.address);
    console.log("ETH:", ethers.formatEther(await p.getBalance(w.address)));

    const usdc = new ethers.Contract(USDC, [
        "function approve(address,uint256) returns (bool)",
        "function balanceOf(address) view returns (uint256)",
        "function allowance(address,address) view returns (uint256)"
    ], w);
    const adapter = new ethers.Contract(ADAPTER, [
        "function tokenMessenger() view returns (address)",
        "function configureIntent(bytes32, uint32, bytes32, bytes32) external",
        "function intentConfigs(bytes32) view returns (uint32,bytes32,bytes32,address)",
        "event BridgeInitiated(bytes32 indexed, uint32 indexed, bytes32 indexed)"
    ], w);

    const usdcBal = await usdc.balanceOf(w.address);
    console.log("USDC:", ethers.formatUnits(usdcBal, 6));

    // ── 1. Register adapter (setForwarder) ──────────────
    console.log("\n══ 1. Registering adapter as forwarder ══");
    const fwData = S.setForwarder + abiCoder.encode(["address"], [ADAPTER]).slice(2);
    const tx1 = await w.sendTransaction({ to: EXECUTOR, data: fwData, gasLimit: 200000 });
    const r1 = await tx1.wait();
    console.log("setForwarder TX:", tx1.hash, "status:", r1.status === 1 ? "OK" : "FAIL");

    // Check storage: mapping(address=>address) at slot 3
    // slot = keccak256(abi.encode(uint256(uint160(addr)), uint256(3)))
    const keyPadded = ethers.zeroPadValue(w.address, 32);
    const slot3Padded = ethers.zeroPadValue("0x03", 32);
    const fwSlot = ethers.keccak256(ethers.concat([keyPadded, slot3Padded]));
    const fwRaw = await p.getStorage(EXECUTOR, fwSlot);
    const fwAddr = "0x" + fwRaw.slice(26);
    console.log("Forwarder stored:", fwAddr, fwAddr.toLowerCase() === ADAPTER.toLowerCase() ? "OK" : "CHECKING ALT SLOT");

    // Try alternative: slot = keccak256(abi.encodePacked(address, uint256))
    const fwSlotAlt = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
            ["address", "uint256"], [w.address, 3]
        )
    );
    const fwRawAlt = await p.getStorage(EXECUTOR, fwSlotAlt);
    const fwAddrAlt = "0x" + fwRawAlt.slice(26);
    console.log("Forwarder alt slot:", fwAddrAlt, fwAddrAlt.toLowerCase() === ADAPTER.toLowerCase() ? "OK" : "N/A");

    // ── 2. Create batch via batchTransferFrom ──────────────
    console.log("\n══ 2. Creating batch (batchTransferFrom) ══");
    const amount = ethers.parseUnits("0.1", 6); // 0.1 USDC
    const self = w.address;

    // batchTransferFrom(address token, address[] recipients, uint256[] amounts)
    const batchCalldata = S.batchTransferFrom + abiCoder.encode(
        ["address", "address[]", "uint256[]"],
        [USDC, [self], [amount]]
    ).slice(2);

    // Approve USDC to executor first (needed for transferFrom)
    console.log("Approving USDC to executor...");
    const appTx = await usdc.approve(EXECUTOR, amount);
    await appTx.wait();
    console.log("USDC approved to executor:", ethers.formatUnits(amount, 6));

    let batchId = null;
    try {
        const tx2 = await w.sendTransaction({ to: EXECUTOR, data: batchCalldata, gasLimit: 500000 });
        const r2 = await tx2.wait();
        console.log("batchTransferFrom TX:", tx2.hash, "status:", r2.status === 1 ? "OK" : "FAIL");
        console.log("Block:", r2.blockNumber, "Gas used:", r2.gasUsed.toString());

        for (const log of r2.logs) {
            if (log.address.toLowerCase() === EXECUTOR.toLowerCase() && log.topics.length >= 2) {
                batchId = log.topics[1];
                console.log("Event topic:", log.topics[0], "-> batchId:", batchId);
            }
        }
    } catch(e) {
        console.log("batchTransferFrom REVERT:", e.shortMessage || e.message);
        if (e.data) {
            console.log("  data:", e.data);
            try {
                // Try decoding revert reason
                const reason = ethers.toUtf8String(e.data);
                console.log("  reason:", reason);
            } catch {}
        }
    }

    // ── 3. Try sendNativeBatch as alternative ──────────────
    console.log("\n══ 3. Try sendNativeBatch (direct native send) ══");
    const tiny = ethers.parseEther("0.000001");
    const nativeCalldata = S.sendNativeBatch + abiCoder.encode(
        ["address[]", "uint256[]"],
        [[self], [tiny]]
    ).slice(2);
    try {
        const tx3 = await w.sendTransaction({ to: EXECUTOR, data: nativeCalldata, value: tiny, gasLimit: 300000 });
        const r3 = await tx3.wait();
        console.log("sendNativeBatch TX:", tx3.hash, "status:", r3.status === 1 ? "OK" : "FAIL");
    } catch(e) {
        console.log("sendNativeBatch REVERT:", e.shortMessage || e.message);
        if (e.data) console.log("  data:", e.data);
    }

    // ── 4. If we have batchId, execute bridge intent ──────
    if (batchId) {
        console.log("\n══ 4. Bridge intent flow ══");
        console.log("batchId:", batchId);

        // Verify batch
        try {
            const gbData = S.getBatch + abiCoder.encode(["uint256"], [batchId]).slice(2);
            const raw = await p.call({ to: EXECUTOR, data: gbData });
            const dec = abiCoder.decode(["uint256", "uint256", "address", "uint256", "uint256"], raw);
            console.log("Batch data:", {
                chainId: dec[0].toString(),
                amount: ethers.formatUnits(dec[1], 6),
                token: dec[2],
                status: dec[3].toString(),
                destChain: dec[4].toString()
            });
        } catch(e) {
            console.log("getBatch error:", e.shortMessage);
        }

        // Approve USDC to adapter
        console.log("Approving USDC to adapter...");
        const appTx2 = await usdc.approve(ADAPTER, amount);
        await appTx2.wait();
        console.log("USDC approved to adapter");

        // Configure intent
        const destDomain = 0; // Ethereum
        const mintRecipient = ethers.zeroPadValue(w.address, 32);
        console.log("Configuring intent:", { batchId, destDomain, mintRecipient });
        try {
            const cfgTx = await adapter.configureIntent(batchId, destDomain, mintRecipient, ethers.ZeroHash);
            await cfgTx.wait();
            console.log("configureIntent TX:", cfgTx.hash);
            const cfg = await adapter.intentConfigs(batchId);
            console.log("Config:", { domain: cfg[0], funder: cfg[3] });
        } catch(e) {
            console.log("configureIntent REVERT:", e.shortMessage || e.message);
        }

        // Execute bridge intent
        console.log("Executing bridge intent...");
        const ebiData = S.executeBridgeIntent + abiCoder.encode(
            ["bytes32", "address"], [batchId, ADAPTER]
        ).slice(2);
        try {
            const tx4 = await w.sendTransaction({ to: EXECUTOR, data: ebiData, gasLimit: 1500000 });
            const r4 = await tx4.wait();
            console.log("executeBridgeIntent TX:", tx4.hash, "status:", r4.status === 1 ? "OK" : "FAIL");
            console.log("Block:", r4.blockNumber, "Gas:", r4.gasUsed.toString());

            for (const log of r4.logs) {
                const info = `  [${log.address.slice(0,10)}] topic0=${log.topics[0]?.slice(0,14)}...`;
                console.log(info);
                if (log.address.toLowerCase() === ADAPTER.toLowerCase()) {
                    console.log("  >>> BridgeInitiated event! <<<");
                    console.log("  intentId:", log.topics[1]);
                    console.log("  destinationDomain:", ethers.toNumber(log.topics[2]));
                    console.log("  messageId:", log.topics[3]);
                }
                if (log.address.toLowerCase() === EXECUTOR.toLowerCase() && log.topics.length >= 3) {
                    console.log("  >>> Executor event <<<");
                    console.log("  topics:", log.topics.map(t => t.slice(0, 18)));
                }
            }
        } catch(e) {
            console.log("executeBridgeIntent REVERT:", e.shortMessage || e.message);
            if (e.data) {
                console.log("  data:", e.data);
                try { console.log("  reason:", ethers.toUtf8String(e.data)); } catch {}
            }
        }

        // Check batch status after
        try {
            const bsData = S.getBatchStatus + abiCoder.encode(["uint256"], [batchId]).slice(2);
            const raw = await p.call({ to: EXECUTOR, data: bsData });
            const status = abiCoder.decode(["uint8"], raw)[0];
            const statusNames = {0: "CREATED", 1: "BRIDGE_PENDING", 2: "EXECUTED", 3: "FAILED"};
            console.log("\n══ 5. Final batch status ══");
            console.log("Status:", status, `(${statusNames[status] || "UNKNOWN"})`);
        } catch(e) {
            console.log("getBatchStatus error:", e.shortMessage);
        }
    }

    console.log("\n══ INTEGRATION TEST COMPLETE ══");
}

main().catch(console.error);
