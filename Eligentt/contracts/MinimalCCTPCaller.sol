// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MinimalCCTPCaller {
    event Log(string step, bytes data);

    /// @notice Full flow: receive USDC, approve TM, call depositForBurn
    /// @dev USDC must already be transferred to this contract.
    function testFullFlow(
        address tm,
        address usdc,
        uint256 amount,
        uint32 destDomain,
        bytes32 mintRecipient
    ) external {
        // 1. Approve TokenMessenger
        emit Log("approve_start", "");
        (bool okApprove, bytes memory appData) = usdc.call(
            abi.encodeWithSignature("approve(address,uint256)", tm, amount)
        );
        emit Log("approve_end", abi.encode(okApprove));
        require(okApprove, "approve failed");

        // 2. Call depositForBurn
        emit Log("depositForBurn_start", "");
        (bool okBurn, bytes memory burnData) = tm.call(
            abi.encodeWithSignature(
                "depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)",
                amount, destDomain, mintRecipient, usdc, bytes32(0), uint256(0), uint32(2000)
            )
        );
        emit Log("depositForBurn_end", abi.encode(okBurn));

        if (!okBurn) {
            emit Log("depositForBurn_REVERT", burnData);
            assembly { revert(add(burnData, 32), mload(burnData)) }
        }
    }

    receive() external payable {}
}
