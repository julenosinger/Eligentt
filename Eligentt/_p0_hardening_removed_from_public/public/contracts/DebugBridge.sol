// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ITokenMessengerV2 {
    function depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32) external returns (uint64);
}
interface IERC20M {
    function approve(address,uint256) external returns (bool);
    function transferFrom(address,address,uint256) external returns (bool);
}

contract DebugBridge {
    event Log(string step, bytes data);

    function testDepositForBurn(address tm, address usdc, uint32 domain, bytes32 recipient) external {
        uint256 amt = 1000; // 0.001 USDC

        // Step 1: pull USDC
        emit Log("transferFrom_begin", "");
        bool ok = IERC20M(usdc).transferFrom(msg.sender, address(this), amt);
        emit Log("transferFrom_end", abi.encode(ok));
        require(ok, "tf failed");

        // Step 2: approve TM
        emit Log("approve_begin", "");
        bool ok2 = IERC20M(usdc).approve(tm, amt);
        emit Log("approve_end", abi.encode(ok2));
        require(ok2, "approve failed");

        // Step 3: depositForBurn
        emit Log("depositForBurn_begin", "");
        try ITokenMessengerV2(tm).depositForBurn(amt, domain, recipient, usdc, bytes32(0), 0, 2000) returns (uint64 nonce) {
            emit Log("depositForBurn_success", abi.encode(nonce));
        } catch (bytes memory reason) {
            emit Log("depositForBurn_revert", reason);
        }
    }
}
