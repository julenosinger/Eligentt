// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20M {
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface ITokenMessengerV2 {
    function depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32) external returns (uint64);
}

contract MirrorCaller {
    event Log(string step, bytes data);

    /// @notice Mimics CCTPAdapter exactly: pull, approve, depositForBurn
    function mirrorAdapter(
        address tm,
        address usdc,
        address funder,
        uint256 amount,
        uint32 destDomain,
        bytes32 mintRecipient
    ) external {
        emit Log("transferFrom_start", "");
        bool tfOk = IERC20M(usdc).transferFrom(funder, address(this), amount);
        emit Log("transferFrom_end", abi.encode(tfOk));
        require(tfOk, "transferFrom failed");

        emit Log("approve_start", "");
        bool appOk = IERC20M(usdc).approve(tm, amount);
        emit Log("approve_end", abi.encode(appOk));
        require(appOk, "approve failed");

        emit Log("depositForBurn_start", "");
        try ITokenMessengerV2(tm).depositForBurn(amount, destDomain, mintRecipient, usdc, bytes32(0), 0, 2000) returns (uint64 nonce) {
            emit Log("depositForBurn_ok", abi.encode(nonce));
        } catch (bytes memory reason) {
            emit Log("depositForBurn_revert", reason);
            assembly { revert(add(reason, 32), mload(reason)) }
        }
    }

    receive() external payable {}
}
