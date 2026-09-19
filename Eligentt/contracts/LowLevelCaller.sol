// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract LowLevelCaller {
    event Log(string step, bytes data);

    function testLowLevel(
        address tm,
        address usdc,
        address funder,
        uint256 amount,
        uint32 destDomain,
        bytes32 mintRecipient
    ) external {
        // All low-level calls, like MinimalCCTPCaller but with transferFrom
        emit Log("transferFrom_start", "");
        (bool tfOk, bytes memory tfData) = usdc.call(
            abi.encodeWithSignature("transferFrom(address,address,uint256)", funder, address(this), amount)
        );
        emit Log("transferFrom_end", abi.encode(tfOk));
        require(tfOk, "tf failed");

        emit Log("approve_start", "");
        (bool appOk, bytes memory appData) = usdc.call(
            abi.encodeWithSignature("approve(address,uint256)", tm, amount)
        );
        emit Log("approve_end", abi.encode(appOk));
        require(appOk, "app failed");

        emit Log("depositForBurn_start", "");
        (bool burnOk, bytes memory burnData) = tm.call(
            abi.encodeWithSignature("depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)",
                amount, destDomain, mintRecipient, usdc, bytes32(0), uint256(0), uint32(2000))
        );
        emit Log("depositForBurn_end", abi.encode(burnOk));
        if (!burnOk) {
            emit Log("depositForBurn_REVERT", burnData);
            assembly { revert(add(burnData, 32), mload(burnData)) }
        }
    }

    receive() external payable {}
}
