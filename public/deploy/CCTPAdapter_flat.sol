// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IBridgeAdapter {
    function sendMessage(uint256 destinationChain, bytes calldata payload)
        external
        payable
        returns (bytes32);
}

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

interface IERC20Minimal {
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

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

    constructor(address _tokenMessenger) {
        require(_tokenMessenger != address(0), "CCTPAdapter: zero messenger");
        tokenMessenger = ITokenMessengerV2(_tokenMessenger);
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

    function sendMessage(uint256, bytes calldata payload)
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
