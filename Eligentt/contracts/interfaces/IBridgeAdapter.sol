// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IBridgeAdapter — bridge-agnostic transport layer
/// @notice Pluggable adapter interface compatible with MultiSendExecutorV3.0.3.
///         The executor calls sendMessage() with the destination chain and a
///         payload containing at minimum (intentId, token).
///         No specific bridge is assumed and none is required at deploy time.
interface IBridgeAdapter {
    /// @notice Deliver a cross-chain message via the adapter's transport.
    /// @param destinationChain The destination chain identifier as stored in the executor batch.
    /// @param payload Encoded data: abi.encode(intentId, token).
    /// @return messageId A transport-specific identifier for the bridged message.
    function sendMessage(uint256 destinationChain, bytes calldata payload)
        external
        payable
        returns (bytes32);
}
