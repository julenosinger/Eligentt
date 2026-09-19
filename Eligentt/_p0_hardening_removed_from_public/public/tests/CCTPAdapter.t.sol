// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../contracts/CCTPAdapter.sol";

/// @notice Mock TokenMessengerV2 for testing
contract MockTokenMessenger {
    event DepositForBurnCalled(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        uint256 nonce
    );

    uint64 private _nonce = 1;

    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 /*destinationCaller*/,
        uint256 /*maxFee*/,
        uint32 /*minFinalityThreshold*/
    ) external returns (uint64) {
        uint64 nonce_ = _nonce;
        _nonce++;
        emit DepositForBurnCalled(amount, destinationDomain, mintRecipient, burnToken, nonce_);
        return nonce_;
    }
}

/// @notice Mock ERC-20 that always succeeds on approve + transferFrom
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

/// @notice Mock MultiSendExecutor that returns batch data
contract MockExecutor {
    struct BatchData {
        uint256 chainId;
        uint256 amount;
        address token;
        uint256 status;
        uint256 destinationChain;
    }

    mapping(uint256 => BatchData) public batches;

    function setBatch(uint256 batchId, uint256 amount, address token) external {
        batches[batchId] = BatchData({
            chainId: block.chainid,
            amount: amount,
            token: token,
            status: 0,
            destinationChain: 1
        });
    }

    function getBatch(uint256 batchId) external view returns (BatchData memory) {
        return batches[batchId];
    }

    /// @notice Simulate executeBridgeIntent calling the adapter
    function callAdapter(address adapter, bytes32 intentId, uint256 destinationChain, bytes memory payload)
        external
        returns (bytes32)
    {
        return IBridgeAdapter(adapter).sendMessage(destinationChain, payload);
    }
}

contract CCTPAdapterTest is Test {
    CCTPAdapter public adapter;
    MockTokenMessenger public messenger;
    MockERC20 public usdc;
    MockExecutor public executor;

    address public user = address(0x100);
    address public recipient = address(0x200);

    bytes32 public constant INTENT_ID = bytes32(uint256(1));
    uint256 public constant AMOUNT = 1000e6; // 1000 USDC
    uint32 public constant DEST_DOMAIN = 0; // Ethereum
    bytes32 public constant MINT_RECIPIENT = bytes32(uint256(uint160(recipient)));

    event BridgeInitiated(
        bytes32 indexed intentId,
        uint32 indexed destinationDomain,
        bytes32 indexed messageId
    );

    function setUp() public {
        messenger = new MockTokenMessenger();
        adapter = new CCTPAdapter(address(messenger));
        usdc = new MockERC20();
        executor = new MockExecutor();

        usdc.mint(user, AMOUNT * 10);
        vm.prank(user);
        usdc.approve(address(adapter), AMOUNT);
    }

    /// @notice Full happy path: configure → execute → depositForBurn
    function testFullCCTPFlow() public {
        executor.setBatch(uint256(INTENT_ID), AMOUNT, address(usdc));

        vm.prank(user);
        adapter.configureIntent(INTENT_ID, DEST_DOMAIN, MINT_RECIPIENT, bytes32(0));

        bytes memory payload = abi.encode(INTENT_ID, address(usdc));

        vm.expectEmit(true, true, true, true);
        emit BridgeInitiated(INTENT_ID, DEST_DOMAIN, bytes32(uint256(1)));
        bytes32 messageId = executor.callAdapter(address(adapter), INTENT_ID, 1, payload);

        assertEq(messageId, bytes32(uint256(1)));
        assertEq(usdc.balances(address(adapter)), 0); // tokens consumed
    }

    /// @notice Revert if intent not configured
    function testRevertsIfNotConfigured() public {
        bytes memory payload = abi.encode(INTENT_ID, address(usdc));

        vm.expectRevert(abi.encodeWithSelector(CCTPAdapter.IntentNotConfigured.selector, INTENT_ID));
        executor.callAdapter(address(adapter), INTENT_ID, 1, payload);
    }

    /// @notice Revert if funder has no allowance
    function testRevertsIfNoAllowance() public {
        executor.setBatch(uint256(INTENT_ID), AMOUNT, address(usdc));

        address otherUser = address(0x300);
        vm.prank(otherUser);
        adapter.configureIntent(INTENT_ID, DEST_DOMAIN, MINT_RECIPIENT, bytes32(0));

        bytes memory payload = abi.encode(INTENT_ID, address(usdc));

        vm.expectRevert(CCTPAdapter.TransferFailed.selector);
        executor.callAdapter(address(adapter), INTENT_ID, 1, payload);
    }

    /// @notice Revert if batch has zero amount
    function testRevertsIfZeroAmount() public {
        executor.setBatch(uint256(INTENT_ID), 0, address(usdc));

        vm.prank(user);
        adapter.configureIntent(INTENT_ID, DEST_DOMAIN, MINT_RECIPIENT, bytes32(0));

        bytes memory payload = abi.encode(INTENT_ID, address(usdc));

        vm.expectRevert("CCTPAdapter: zero amount");
        executor.callAdapter(address(adapter), INTENT_ID, 1, payload);
    }

    /// @notice clearIntent removes config
    function testClearIntent() public {
        vm.prank(user);
        adapter.configureIntent(INTENT_ID, DEST_DOMAIN, MINT_RECIPIENT, bytes32(0));

        vm.prank(user);
        adapter.clearIntent(INTENT_ID);

        (uint32 domain, , , address funder) = adapter.intentConfigs(INTENT_ID);
        assertEq(domain, 0);
        assertEq(funder, address(0));
    }

    /// @notice Single-use: config is deleted after successful sendMessage
    function testConfigDeletedAfterSendMessage() public {
        executor.setBatch(uint256(INTENT_ID), AMOUNT, address(usdc));

        vm.prank(user);
        adapter.configureIntent(INTENT_ID, DEST_DOMAIN, MINT_RECIPIENT, bytes32(0));

        bytes memory payload = abi.encode(INTENT_ID, address(usdc));
        executor.callAdapter(address(adapter), INTENT_ID, 1, payload);

        (uint32 domain, , , address funder) = adapter.intentConfigs(INTENT_ID);
        assertEq(domain, 0);
        assertEq(funder, address(0));
    }
}
