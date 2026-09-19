// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

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


/// @title CCTPAdapterV2
/// @notice CCTP v2 bridge adapter using low-level calls for Arc Testnet compatibility.
/// @dev    Arc Testnet CCTP proxies suppress return data on depositForBurn
///         when called via Solidity interface. Low-level address.call() works.
///         All external token/bridge calls use low-level encoding.
contract CCTPAdapterV2 is IBridgeAdapter {
    address public immutable tokenMessenger;

    struct CCTPIntentConfig {
        uint32 destinationDomain;
        bytes32 mintRecipient;
        bytes32 destinationCaller;
        address funder;
    }

    mapping(bytes32 => CCTPIntentConfig) public intentConfigs;

    error IntentNotConfigured(bytes32 intentId);
    error TransferFailed();
    error ApproveFailed();
    error DepositFailed();

    event BridgeInitiated(
        bytes32 indexed intentId,
        uint32 indexed destinationDomain,
        bytes32 indexed messageId
    );

    event CCTPDepositCalled(
        bytes32 indexed intentId,
        uint256 amount,
        uint32 domain
    );

    /// @param _tokenMessenger CCTP TokenMessengerV2 address on Arc Testnet
    constructor(address _tokenMessenger) {
        require(_tokenMessenger != address(0), "CCTPAdapterV2: zero messenger");
        tokenMessenger = _tokenMessenger;
    }

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

    function clearIntent(bytes32 intentId) external {
        delete intentConfigs[intentId];
    }

    /// @notice IMultiSendExecutor interface for reading batch data.
    /// @dev    The selector MUST match the executor's getBatch(uint256).
    function _getBatchFromExecutor(address executor, bytes32 intentId)
        internal view
        returns (uint256 chainId, uint256 amount, address token, uint256 status, uint256 destChain)
    {
        (bool ok, bytes memory data) = executor.staticcall(
            abi.encodeWithSignature("getBatch(uint256)", uint256(intentId))
        );
        require(ok, "CCTPAdapterV2: getBatch failed");
        (chainId, amount, token, status, destChain) =
            abi.decode(data, (uint256, uint256, address, uint256, uint256));
    }

    /// @inheritdoc IBridgeAdapter
    function sendMessage(uint256 /*destinationChain*/, bytes calldata payload)
        external
        payable
        override
        returns (bytes32)
    {
        (bytes32 intentId, address token) = abi.decode(payload, (bytes32, address));

        CCTPIntentConfig storage config = intentConfigs[intentId];
        if (config.funder == address(0)) revert IntentNotConfigured(intentId);

        (, uint256 amount, , , ) = _getBatchFromExecutor(msg.sender, intentId);
        require(amount > 0, "CCTPAdapterV2: zero amount");

        // 1. transferFrom: pull USDC from funder to adapter
        (bool tfOk, ) = token.call(
            abi.encodeWithSignature(
                "transferFrom(address,address,uint256)",
                config.funder, address(this), amount
            )
        );
        if (!tfOk) revert TransferFailed();

        // 2. approve: allow TokenMessenger to spend
        (bool appOk, ) = token.call(
            abi.encodeWithSignature(
                "approve(address,uint256)",
                tokenMessenger, amount
            )
        );
        if (!appOk) revert ApproveFailed();

        // 3. depositForBurn via low-level call — Arc Testnet workaround
        emit CCTPDepositCalled(intentId, amount, config.destinationDomain);

        (bool burnOk, ) = tokenMessenger.call(
            abi.encodeWithSignature(
                "depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)",
                amount,
                config.destinationDomain,
                config.mintRecipient,
                token,
                config.destinationCaller,
                uint256(0),
                uint32(2000)
            )
        );
        if (!burnOk) revert DepositFailed();

        bytes32 messageId = keccak256(abi.encode(block.chainid, intentId, amount, block.timestamp));
        emit BridgeInitiated(intentId, config.destinationDomain, messageId);

        delete intentConfigs[intentId];

        return messageId;
    }
}
