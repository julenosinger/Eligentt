// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {CCTPAdapter} from "../contracts/CCTPAdapter.sol";

/// @title DeployCCTPAdapter
/// @notice Foundry deploy script for CCTPAdapter on Arc Testnet.
/// @dev    Run with: forge script script/DeployCCTPAdapter.s.sol --rpc-url $ARC_RPC --broadcast
contract DeployCCTPAdapter is Script {
    // Arc Testnet CCTP TokenMessengerV2 (Circle)
    address constant TOKEN_MESSENGER = 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        CCTPAdapter adapter = new CCTPAdapter(TOKEN_MESSENGER);

        vm.stopBroadcast();

        console.log("CCTPAdapter deployed at:", address(adapter));
        console.log("TokenMessenger:", TOKEN_MESSENGER);
    }
}
