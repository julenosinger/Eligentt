// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IBridgeAdapter} from "./interfaces/IBridgeAdapter.sol";

/// @title ITokenMessengerV2 — minimal CCTP TokenMessenger interface
interface ITokenMessengerV2 {
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external returns (uint64 nonce);
}

/// @title IERC20Minimal — minimal ERC-20 for approve + transferFrom
interface IERC20Minimal {
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title IMultiSendExecutor — minimal executor interface for reading batch data
interface IMultiSendExecutor {
    struct BatchData {
        uint256 chainId;
        uint256 amount;
        address token;
        uint256 status;
        uint256 destinationChain;
    }
    function getBatch(uint256 batchId) external view returns (BatchData memory);
}

/// @title CCTPAdapter
/// @notice Circle CCTP v2 bridge adapter compatible with MultiSendExecutorV3.0.3.
/// @dev   Deployed on Arc Testnet. Routes executor intents through Circle's
///        TokenMessengerV2 depositForBurn. Requires pre-configuration of
///        CCTP-specific parameters (domain, mintRecipient) per intentId.
///
///        Flow:
///        1. User creates a route intent on MultiSendExecutorV3 (tokens locked in executor)
///        2. User approves burnToken (USDC) to CCTPAdapter
///        3. User calls configureIntent() on this adapter with CCTP params (funder = msg.sender)
///        4. User calls executeBridgeIntent(intentId, adapterAddress) on the executor
///        5. The executor calls sendMessage() on this adapter
///        6. Adapter pulls tokens from funder, approves TokenMessenger, calls depositForBurn
///
///        Real addresses (Arc Testnet):
///        - TokenMessengerV2: 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA
///        - USDC:              0x3600000000000000000000000000000000000000
contract CCTPAdapter is IBridgeAdapter {
    ITokenMessengerV2 public immutable tokenMessenger;

    struct CCTPIntentConfig {
        uint32 destinationDomain;
        bytes32 mintRecipient;
        bytes32 destinationCaller;
        address funder;
    }

    mapping(bytes32 => CCTPIntentConfig) public intentConfigs;

    error IntentNotConfigured(bytes32 intentId);
    error TransferFailed();
    error DepositFailed();

    event BridgeInitiated(
        bytes32 indexed intentId,
        uint32 indexed destinationDomain,
        bytes32 indexed messageId
    );

    /// @param _tokenMessenger CCTP TokenMessengerV2 address on the deployment chain
    constructor(address _tokenMessenger) {
        require(_tokenMessenger != address(0), "CCTPAdapter: zero messenger");
        tokenMessenger = ITokenMessengerV2(_tokenMessenger);
    }

    /// @notice Pre-configure CCTP-specific routing data for an intent.
    /// @dev    Must be called before executeBridgeIntent on the executor.
    ///         msg.sender is recorded as the funder — they must have approved
    ///         the burnToken to this adapter before executeBridgeIntent.
    function configureIntent(
        bytes32 intentId,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        bytes32 destinationCaller
    ) external {
        intentConfigs[intentId] = CCTPIntentConfig({
            destinationDomain: destinationDomain,
            mintRecipient: mintRecipient,
            destinationCaller: destinationCaller,
            funder: msg.sender
        });
    }

    /// @notice Remove a pre-configured intent (gas refund).
    function clearIntent(bytes32 intentId) external {
        delete intentConfigs[intentId];
    }

    /// @inheritdoc IBridgeAdapter
    /// @dev Called exclusively by the MultiSendExecutorV3.0.3 when executing an intent.
    ///      Pulls tokens from the funder (configureIntent caller), approves TokenMessenger,
    ///      and calls depositForBurn.
    function sendMessage(uint256 /*destinationChain*/, bytes calldata payload)
        external
        payable
        override
        returns (bytes32)
    {
        (bytes32 intentId, address token) = abi.decode(payload, (bytes32, address));

        CCTPIntentConfig storage config = intentConfigs[intentId];
        if (config.funder == address(0)) revert IntentNotConfigured(intentId);

        IMultiSendExecutor.BatchData memory batch =
            IMultiSendExecutor(msg.sender).getBatch(uint256(intentId));

        uint256 amount = batch.amount;
        require(amount > 0, "CCTPAdapter: zero amount");

        if (!IERC20Minimal(token).transferFrom(config.funder, address(this), amount)) {
            revert TransferFailed();
        }

        IERC20Minimal(token).approve(address(tokenMessenger), amount);

        uint64 nonce = tokenMessenger.depositForBurn(
            amount,
            config.destinationDomain,
            config.mintRecipient,
            token,
            config.destinationCaller,
            0,
            2000
        );

        bytes32 messageId = bytes32(uint256(nonce));
        emit BridgeInitiated(intentId, config.destinationDomain, messageId);

        delete intentConfigs[intentId];

        return messageId;
    }
}
