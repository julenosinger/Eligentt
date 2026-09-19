// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IBridgeAdapter} from "./interfaces/IBridgeAdapter.sol";

/// @title MultiSendExecutorV4
/// @notice Enterprise multi-chain batch execution layer with bridge intent support.
/// @dev    Fixes V3.0.3: adds createRouteIntent() to create bridge-able batches.
///         Maintains full backward compatibility with CCTPAdapter.
contract MultiSendExecutorV4 {
    string public constant version = "4.0.0";
    uint256 public constant MAX_BATCH = 256;

    enum IntentStatus { CREATED, BRIDGE_PENDING, EXECUTED, FAILED }

    struct BatchTransfer {
        address token;
        address[] recipients;
        uint256[] amounts;
    }

    struct RouteIntent {
        uint256 sourceChain;
        uint256 destinationChain;
        address token;
        address creator;
        uint256 amount;
        uint256 nonce;
    }

    /// @dev For CCTPAdapter compatibility — matches IMultiSendExecutor.BatchData
    struct BatchData {
        uint256 chainId;
        uint256 amount;
        address token;
        uint256 status;
        uint256 destinationChain;
    }

    mapping(address => uint256) public nonces;
    mapping(bytes32 => RouteIntent) internal routes;
    mapping(bytes32 => IntentStatus) internal intentStatus;
    mapping(address => address) internal adapterOf;

    uint256 private _guard = 1;

    error Reentrancy();
    error InvalidBatch();
    error LengthMismatch();
    error BatchTooLarge();
    error InvalidRecipient();
    error ZeroToken();
    error ValueMismatch();
    error TransferFailed();
    error UnknownIntent();
    error AlreadyExecuted();
    error InvalidDestination();

    modifier nonReentrant() {
        if (_guard != 1) revert Reentrancy();
        _guard = 2;
        _;
        _guard = 1;
    }

    event NativeBatchSent(address indexed sender, uint256 totalAmount, uint256 recipientsCount);
    event TokenBatchSent(address indexed sender, address indexed token, uint256 totalAmount, uint256 recipientsCount);
    event BatchCompleted(address indexed sender, address indexed token, uint256 totalAmount, uint256 recipientsCount);
    event MixedBatchExecuted(address indexed sender, uint256 totalTransfers);
    event RouteIntentCreated(bytes32 indexed intentId, address indexed sender, uint256 indexed destinationChain);
    event BridgeMessageSent(bytes32 indexed intentId, address indexed adapter, bytes32 messageId);
    event IntentFailed(bytes32 indexed intentId);
    event BridgeAdapterRegistered(address indexed account, address indexed adapter);
    event BridgeAdapterRemoved(address indexed account);

    // ── Internal helpers ────────────────────────────────────

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(0x23b872dd, from, to, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeNative(address to, uint256 amount) internal {
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _validate(address[] calldata recipients, uint256[] calldata amounts)
        internal pure returns (uint256 total)
    {
        uint256 len = recipients.length;
        if (len == 0) revert InvalidBatch();
        if (len != amounts.length) revert LengthMismatch();
        if (len > MAX_BATCH) revert BatchTooLarge();
        for (uint256 i = 0; i < len; i++) {
            if (recipients[i] == address(0)) revert InvalidRecipient();
            total += amounts[i];
        }
    }

    // ── Batch send functions ────────────────────────────────

    /// @notice Send native ETH to multiple recipients.
    function sendNativeBatch(address[] calldata recipients, uint256[] calldata amounts)
        external payable nonReentrant
    {
        uint256 total = _validate(recipients, amounts);
        if (msg.value != total) revert ValueMismatch();
        uint256 len = recipients.length;
        for (uint256 i = 0; i < len; i++) {
            _safeNative(recipients[i], amounts[i]);
        }
        emit NativeBatchSent(msg.sender, total, len);
        emit BatchCompleted(msg.sender, address(0), total, len);
    }

    /// @notice Send ERC-20 tokens to multiple recipients. Requires prior approval.
    function sendTokenBatch(address token, address[] calldata recipients, uint256[] calldata amounts)
        external nonReentrant
    {
        if (token == address(0)) revert ZeroToken();
        uint256 total = _validate(recipients, amounts);
        uint256 len = recipients.length;
        for (uint256 i = 0; i < len; i++) {
            _safeTransferFrom(token, msg.sender, recipients[i], amounts[i]);
        }
        emit TokenBatchSent(msg.sender, token, total, len);
        emit BatchCompleted(msg.sender, token, total, len);
    }

    /// @notice Send mixed (native + multiple ERC-20 tokens) in one call.
    function sendMixedBatch(BatchTransfer[] calldata transfers) external payable nonReentrant {
        uint256 n = transfers.length;
        if (n == 0 || n > MAX_BATCH) revert InvalidBatch();
        uint256 sentNative;
        uint256 totalTransfers;
        for (uint256 t = 0; t < n; t++) {
            BatchTransfer calldata bt = transfers[t];
            uint256 len = bt.recipients.length;
            if (len == 0) revert InvalidBatch();
            if (len != bt.amounts.length) revert LengthMismatch();
            if (len > MAX_BATCH) revert BatchTooLarge();
            for (uint256 i = 0; i < len; i++) {
                address to = bt.recipients[i];
                if (to == address(0)) revert InvalidRecipient();
                uint256 amt = bt.amounts[i];
                if (bt.token == address(0)) {
                    sentNative += amt;
                    _safeNative(to, amt);
                } else {
                    _safeTransferFrom(bt.token, msg.sender, to, amt);
                }
                totalTransfers++;
            }
        }
        if (msg.value != sentNative) revert ValueMismatch();
        emit MixedBatchExecuted(msg.sender, totalTransfers);
    }

    // ── Route Intent ────────────────────────────────────────

    /// @notice Create a bridge-able route intent.
    /// @dev    Does NOT pull tokens — the adapter handles that during execution.
    ///         intentId is deterministic: keccak256(chainId, sender, nonce, payload).
    function createRouteIntent(
        uint256 destinationChain,
        address token,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external nonReentrant returns (bytes32 intentId) {
        if (destinationChain == 0) revert InvalidDestination();
        uint256 total = _validate(recipients, amounts);

        uint256 nonce = nonces[msg.sender]++;
        bytes memory payload = abi.encode(token, recipients, amounts);
        intentId = keccak256(abi.encode(block.chainid, msg.sender, nonce, payload));

        routes[intentId] = RouteIntent({
            sourceChain: block.chainid,
            destinationChain: destinationChain,
            token: token,
            creator: msg.sender,
            amount: total,
            nonce: nonce
        });
        intentStatus[intentId] = IntentStatus.CREATED;

        emit RouteIntentCreated(intentId, msg.sender, destinationChain);
    }

    /// @notice Get full route intent data.
    function getRouteIntent(bytes32 intentId) external view returns (RouteIntent memory) {
        return routes[intentId];
    }

    /// @notice Get intent status from the state machine.
    function getIntentStatus(bytes32 intentId) external view returns (IntentStatus) {
        return intentStatus[intentId];
    }

    // ── CCTPAdapter compatibility ───────────────────────────

    /// @notice Returns batch data in the format expected by CCTPAdapter.
    /// @dev    The adapter calls getBatch(uint256(intentId)) via msg.sender.
    function getBatch(uint256 batchId) external view returns (BatchData memory) {
        bytes32 intentId = bytes32(batchId);
        RouteIntent storage route = routes[intentId];
        return BatchData({
            chainId: route.sourceChain,
            amount: route.amount,
            token: route.token,
            status: uint256(intentStatus[intentId]),
            destinationChain: route.destinationChain
        });
    }

    // ── Bridge execution ────────────────────────────────────

    /// @notice Execute a bridge intent via any IBridgeAdapter.
    /// @dev    adapter == address(0) is a no-op signal.
    function executeBridgeIntent(bytes32 intentId, address adapter)
        external payable nonReentrant returns (bytes32 messageId)
    {
        RouteIntent storage route = routes[intentId];
        if (route.amount == 0) revert UnknownIntent();
        if (intentStatus[intentId] != IntentStatus.CREATED) revert AlreadyExecuted();

        bytes memory payload = abi.encode(intentId, route.token);

        if (adapter == address(0)) {
            intentStatus[intentId] = IntentStatus.BRIDGE_PENDING;
            messageId = intentId;
            emit BridgeMessageSent(intentId, address(0), messageId);
        } else {
            try IBridgeAdapter(adapter).sendMessage{value: msg.value}(
                route.destinationChain, payload
            ) returns (bytes32 mid) {
                intentStatus[intentId] = IntentStatus.BRIDGE_PENDING;
                messageId = mid;
                emit BridgeMessageSent(intentId, adapter, mid);
            } catch {
                intentStatus[intentId] = IntentStatus.FAILED;
                emit IntentFailed(intentId);
            }
        }
    }

    // ── Forwarder / bridge adapter registry ─────────────────

    /// @notice Register a preferred bridge adapter. Permissionless.
    function registerBridgeAdapter(address adapter) external {
        adapterOf[msg.sender] = adapter;
        emit BridgeAdapterRegistered(msg.sender, adapter);
    }

    /// @notice Remove the registered bridge adapter.
    function removeBridgeAdapter() external {
        delete adapterOf[msg.sender];
        emit BridgeAdapterRemoved(msg.sender);
    }

    /// @notice Get the registered bridge adapter for an account.
    function getBridgeAdapter(address account) external view returns (address) {
        return adapterOf[account];
    }

    // ── Fallback ────────────────────────────────────────────

    receive() external payable {}
}
