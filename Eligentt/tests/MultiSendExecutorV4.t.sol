// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../contracts/MultiSendExecutorV4.sol";
import {IBridgeAdapter} from "../contracts/interfaces/IBridgeAdapter.sol";

/// @notice Mock bridge adapter for testing executeBridgeIntent
contract MockBridgeAdapter is IBridgeAdapter {
    event MessageSent(uint256 destinationChain, bytes payload, bytes32 messageId);

    function sendMessage(uint256 destinationChain, bytes calldata payload)
        external payable override returns (bytes32)
    {
        bytes32 messageId = keccak256(abi.encode(destinationChain, payload, block.timestamp));
        emit MessageSent(destinationChain, payload, messageId);
        return messageId;
    }
}

/// @notice Failing mock adapter
contract FailingBridgeAdapter is IBridgeAdapter {
    function sendMessage(uint256, bytes calldata) external payable override returns (bytes32) {
        revert("adapter failed");
    }
}

/// @notice Mock ERC-20 for batch testing
contract MockERC20 {
    mapping(address => uint256) public balances;
    mapping(address => mapping(address => uint256)) public allowances;

    function mint(address to, uint256 amount) external {
        balances[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowances[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowances[from][msg.sender] >= amount, "insufficient allowance");
        require(balances[from] >= amount, "insufficient balance");
        allowances[from][msg.sender] -= amount;
        balances[from] -= amount;
        balances[to] += amount;
        return true;
    }
}

contract MultiSendExecutorV4Test is Test {
    MultiSendExecutorV4 public executor;
    MockBridgeAdapter public adapter;
    MockERC20 public token;

    address public user = address(0x100);
    address public user2 = address(0x200);
    address public recipient = address(0x300);
    address public recipient2 = address(0x400);

    uint256 public constant AMOUNT = 1000e6; // 1000 tokens
    bytes32 public intentId;

    event RouteIntentCreated(bytes32 indexed intentId, address indexed sender, uint256 indexed destinationChain);
    event BridgeMessageSent(bytes32 indexed intentId, address indexed adapter, bytes32 messageId);
    event IntentFailed(bytes32 indexed intentId);
    event NativeBatchSent(address indexed sender, uint256 totalAmount, uint256 recipientsCount);
    event TokenBatchSent(address indexed sender, address indexed token, uint256 totalAmount, uint256 recipientsCount);
    event MixedBatchExecuted(address indexed sender, uint256 totalTransfers);
    event BridgeAdapterRegistered(address indexed account, address indexed adapter);

    function setUp() public {
        executor = new MultiSendExecutorV4();
        adapter = new MockBridgeAdapter();
        token = new MockERC20();
        token.mint(user, AMOUNT * 10);

        vm.prank(user);
        token.approve(address(executor), AMOUNT * 10);

        bytes memory payload = abi.encode(address(token), _singletonRecipients(), _singletonAmounts());
        intentId = keccak256(abi.encode(block.chainid, user, 0, payload));
    }

    function _singletonRecipients() internal view returns (address[] memory r) {
        r = new address[](1);
        r[0] = recipient;
    }

    function _singletonAmounts() internal view returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = AMOUNT;
    }

    // ── sendNativeBatch ─────────────────────────────────────

    function testSendNativeBatch() public {
        uint256 value = 1 ether;
        address[] memory recs = new address[](1);
        recs[0] = recipient;
        uint256[] memory amts = new uint256[](1);
        amts[0] = value;

        uint256 beforeBal = recipient.balance;

        vm.expectEmit(true, true, false, false);
        emit NativeBatchSent(user, value, 1);
        vm.prank(user);
        executor.sendNativeBatch{value: value}(recs, amts);

        assertEq(recipient.balance, beforeBal + value);
    }

    function testSendNativeBatchRevertsValueMismatch() public {
        address[] memory recs = new address[](1);
        recs[0] = recipient;
        uint256[] memory amts = new uint256[](1);
        amts[0] = 1 ether;

        vm.prank(user);
        vm.expectRevert(MultiSendExecutorV4.ValueMismatch.selector);
        executor.sendNativeBatch{value: 0.5 ether}(recs, amts);
    }

    // ── sendTokenBatch ──────────────────────────────────────

    function testSendTokenBatch() public {
        vm.prank(user);
        vm.expectEmit(true, true, false, false);
        emit TokenBatchSent(user, address(token), AMOUNT, 1);
        executor.sendTokenBatch(address(token), _singletonRecipients(), _singletonAmounts());

        assertEq(token.balances(recipient), AMOUNT);
    }

    function testSendTokenBatchRevertsZeroToken() public {
        vm.prank(user);
        vm.expectRevert(MultiSendExecutorV4.ZeroToken.selector);
        executor.sendTokenBatch(address(0), _singletonRecipients(), _singletonAmounts());
    }

    // ── sendMixedBatch ──────────────────────────────────────

    function testSendMixedBatch() public {
        MultiSendExecutorV4.BatchTransfer[] memory transfers = new MultiSendExecutorV4.BatchTransfer[](2);
        transfers[0] = MultiSendExecutorV4.BatchTransfer({
            token: address(0),
            recipients: _singletonRecipients(),
            amounts: _singletonAmounts() // will be treated as native
        });
        transfers[1] = MultiSendExecutorV4.BatchTransfer({
            token: address(token),
            recipients: _singletonRecipients(),
            amounts: _singletonAmounts()
        });

        // First transfer is native (1 ether), second is ERC-20 (AMOUNT)
        transfers[0].amounts[0] = 1 ether;

        vm.prank(user);
        vm.expectEmit(true, false, false, false);
        emit MixedBatchExecuted(user, 2);
        executor.sendMixedBatch{value: 1 ether}(transfers);

        assertEq(recipient.balance, 1 ether);
        assertEq(token.balances(recipient), AMOUNT);
    }

    // ── createRouteIntent ───────────────────────────────────

    function testCreateRouteIntent() public {
        vm.prank(user);
        vm.expectEmit(true, true, true, false);
        emit RouteIntentCreated(intentId, user, 1);

        bytes32 id = executor.createRouteIntent(1, address(token), _singletonRecipients(), _singletonAmounts());

        assertEq(id, intentId);

        MultiSendExecutorV4.RouteIntent memory route = executor.getRouteIntent(intentId);
        assertEq(route.sourceChain, block.chainid);
        assertEq(route.destinationChain, 1);
        assertEq(route.token, address(token));
        assertEq(route.creator, user);
        assertEq(route.amount, AMOUNT);
        assertEq(route.nonce, 0);

        MultiSendExecutorV4.IntentStatus status = executor.getIntentStatus(intentId);
        assertEq(uint256(status), uint256(MultiSendExecutorV4.IntentStatus.CREATED));
    }

    function testCreateRouteIntentRevertsZeroDestination() public {
        vm.prank(user);
        vm.expectRevert(MultiSendExecutorV4.InvalidDestination.selector);
        executor.createRouteIntent(0, address(token), _singletonRecipients(), _singletonAmounts());
    }

    function testCreateRouteIntentRevertsEmptyRecipients() public {
        vm.prank(user);
        vm.expectRevert(MultiSendExecutorV4.InvalidBatch.selector);
        executor.createRouteIntent(1, address(token), new address[](0), new uint256[](0));
    }

    function testCreateRouteIntentIncrementsNonce() public {
        vm.prank(user);
        executor.createRouteIntent(1, address(token), _singletonRecipients(), _singletonAmounts());

        address[] memory recs = new address[](1);
        recs[0] = recipient2;
        uint256[] memory amts = new uint256[](1);
        amts[0] = AMOUNT;

        vm.prank(user);
        bytes memory payload2 = abi.encode(address(token), recs, amts);
        bytes32 expectedId2 = keccak256(abi.encode(block.chainid, user, 1, payload2));
        bytes32 id2 = executor.createRouteIntent(1, address(token), recs, amts);
        assertEq(id2, expectedId2);
        assertEq(executor.nonces(user), 2);
    }

    // ── executeBridgeIntent ─────────────────────────────────

    function testExecuteBridgeIntent() public {
        vm.prank(user);
        executor.createRouteIntent(7, address(token), _singletonRecipients(), _singletonAmounts());

        vm.prank(user);
        vm.expectEmit(true, true, false, false);
        emit BridgeMessageSent(intentId, address(adapter), bytes32(0));
        bytes32 messageId = executor.executeBridgeIntent(intentId, address(adapter));

        assertTrue(messageId != bytes32(0));

        MultiSendExecutorV4.IntentStatus status = executor.getIntentStatus(intentId);
        assertEq(uint256(status), uint256(MultiSendExecutorV4.IntentStatus.BRIDGE_PENDING));
    }

    function testExecuteBridgeIntentReplayFails() public {
        vm.prank(user);
        executor.createRouteIntent(1, address(token), _singletonRecipients(), _singletonAmounts());

        vm.prank(user);
        executor.executeBridgeIntent(intentId, address(adapter));

        vm.prank(user);
        vm.expectRevert(MultiSendExecutorV4.AlreadyExecuted.selector);
        executor.executeBridgeIntent(intentId, address(adapter));
    }

    function testExecuteBridgeIntentNoopAdapter() public {
        vm.prank(user);
        executor.createRouteIntent(1, address(token), _singletonRecipients(), _singletonAmounts());

        vm.prank(user);
        bytes32 messageId = executor.executeBridgeIntent(intentId, address(0));

        assertEq(messageId, intentId);

        MultiSendExecutorV4.IntentStatus status = executor.getIntentStatus(intentId);
        assertEq(uint256(status), uint256(MultiSendExecutorV4.IntentStatus.BRIDGE_PENDING));
    }

    function testExecuteBridgeIntentUnknownIntent() public {
        vm.prank(user);
        vm.expectRevert(MultiSendExecutorV4.UnknownIntent.selector);
        executor.executeBridgeIntent(bytes32(uint256(999)), address(adapter));
    }

    function testExecuteBridgeIntentFailingAdapter() public {
        FailingBridgeAdapter failAdapter = new FailingBridgeAdapter();

        vm.prank(user);
        executor.createRouteIntent(1, address(token), _singletonRecipients(), _singletonAmounts());

        vm.prank(user);
        vm.expectEmit(true, false, false, false);
        emit IntentFailed(intentId);
        executor.executeBridgeIntent(intentId, address(failAdapter));

        MultiSendExecutorV4.IntentStatus status = executor.getIntentStatus(intentId);
        assertEq(uint256(status), uint256(MultiSendExecutorV4.IntentStatus.FAILED));
    }

    // ── getBatch (CCTPAdapter compatibility) ────────────────

    function testGetBatchCompatibility() public {
        vm.prank(user);
        executor.createRouteIntent(7, address(token), _singletonRecipients(), _singletonAmounts());

        MultiSendExecutorV4.BatchData memory batch = executor.getBatch(uint256(intentId));
        assertEq(batch.chainId, block.chainid);
        assertEq(batch.amount, AMOUNT);
        assertEq(batch.token, address(token));
        assertEq(batch.status, uint256(MultiSendExecutorV4.IntentStatus.CREATED));
        assertEq(batch.destinationChain, 7);
    }

    function testGetBatchZeroForUnknown() public {
        MultiSendExecutorV4.BatchData memory batch = executor.getBatch(uint256(0xdead));
        assertEq(batch.amount, 0);
        assertEq(batch.token, address(0));
    }

    // ── Bridge adapter registry ─────────────────────────────

    function testRegisterBridgeAdapter() public {
        vm.prank(user);
        vm.expectEmit(true, true, false, false);
        emit BridgeAdapterRegistered(user, address(adapter));
        executor.registerBridgeAdapter(address(adapter));

        assertEq(executor.getBridgeAdapter(user), address(adapter));
    }

    function testRemoveBridgeAdapter() public {
        vm.prank(user);
        executor.registerBridgeAdapter(address(adapter));
        executor.removeBridgeAdapter();

        assertEq(executor.getBridgeAdapter(user), address(0));
    }

    // ── Reentrancy ──────────────────────────────────────────

    function testReentrancyGuardActive() public {
        vm.prank(user);
        executor.createRouteIntent(1, address(token), _singletonRecipients(), _singletonAmounts());

        // executeBridgeIntent uses nonReentrant, protected
        vm.prank(user);
        executor.executeBridgeIntent(intentId, address(adapter));

        // After execution, guard should be reset (status == 1 is checked by modifier)
        // If guard wasn't reset, next call would fail
        // Create a SECOND intent to verify
        vm.prank(user);
        bytes32 id2 = executor.createRouteIntent(2, address(token), _singletonRecipients(), _singletonAmounts());
        assertTrue(id2 != bytes32(0));
    }
}
