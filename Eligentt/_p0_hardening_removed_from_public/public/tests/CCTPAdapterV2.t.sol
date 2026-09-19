// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../contracts/CCTPAdapterV2.sol";

contract MockTM {
    event DepositForBurnCalled(uint256 amount, uint32 domain, address token);
    function depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32) external {}
    fallback() external payable {
        emit DepositForBurnCalled(0, 0, address(0));
    }
}

contract MockERC20 {
    mapping(address => uint256) public balances;
    mapping(address => mapping(address => uint256)) public allowances;
    function mint(address to, uint256 a) external { balances[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowances[msg.sender][s] = a; return true; }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        require(allowances[f][msg.sender] >= a, "allowance");
        require(balances[f] >= a, "balance");
        allowances[f][msg.sender] -= a; balances[f] -= a; balances[t] += a;
        return true;
    }
}

contract MockExecutor {
    struct BatchData { uint256 chainId; uint256 amount; address token; uint256 status; uint256 destChain; }
    mapping(uint256 => BatchData) public batches;
    function setBatch(uint256 id, uint256 amt, address tok) external {
        batches[id] = BatchData(block.chainid, amt, tok, 0, 7);
    }
    function getBatch(uint256 id) external view returns (BatchData memory) { return batches[id]; }
    function callAdapter(address a, bytes32 intentId, uint256 dc, bytes memory payload) external returns (bytes32) {
        return IBridgeAdapter(a).sendMessage(dc, payload);
    }
}

contract CCTPAdapterV2Test is Test {
    CCTPAdapterV2 public adapter;
    MockERC20 public usdc;
    MockExecutor public executor;
    address public user = address(0x100);
    address public recp = address(0x200);
    bytes32 constant INTENT = bytes32(uint256(1));
    uint256 constant AMT = 1000e6;

    event BridgeInitiated(bytes32 indexed, uint32 indexed, bytes32 indexed);
    event CCTPDepositCalled(bytes32 indexed, uint256, uint32);

    function setUp() public {
        adapter = new CCTPAdapterV2(address(0x123)); // dummy TM for isolated tests
        usdc = new MockERC20();
        executor = new MockExecutor();
        usdc.mint(user, AMT * 10);
        vm.prank(user);
        usdc.approve(address(adapter), AMT);
    }

    function testFullFlow() public {
        executor.setBatch(uint256(INTENT), AMT, address(usdc));
        vm.prank(user);
        adapter.configureIntent(INTENT, 6, bytes32(uint256(uint160(recp))), bytes32(0));
        bytes memory payload = abi.encode(INTENT, address(usdc));
        vm.expectEmit(true, true, true, true);
        emit BridgeInitiated(INTENT, 6, keccak256(abi.encode(block.chainid, INTENT, AMT, block.timestamp)));
        bytes32 msgId = executor.callAdapter(address(adapter), INTENT, 7, payload);
        assertTrue(msgId != bytes32(0));
        assertEq(usdc.balances(address(adapter)), 0);
    }

    function testRevertsNotConfigured() public {
        bytes memory payload = abi.encode(INTENT, address(usdc));
        vm.expectRevert(abi.encodeWithSelector(CCTPAdapterV2.IntentNotConfigured.selector, INTENT));
        executor.callAdapter(address(adapter), INTENT, 7, payload);
    }

    function testRevertsZeroAmount() public {
        executor.setBatch(uint256(INTENT), 0, address(usdc));
        vm.prank(user);
        adapter.configureIntent(INTENT, 6, bytes32(uint256(uint160(recp))), bytes32(0));
        bytes memory payload = abi.encode(INTENT, address(usdc));
        vm.expectRevert("CCTPAdapterV2: zero amount");
        executor.callAdapter(address(adapter), INTENT, 7, payload);
    }

    function testReplayProtection() public {
        executor.setBatch(uint256(INTENT), AMT, address(usdc));
        vm.prank(user);
        adapter.configureIntent(INTENT, 6, bytes32(uint256(uint160(recp))), bytes32(0));
        bytes memory payload = abi.encode(INTENT, address(usdc));
        executor.callAdapter(address(adapter), INTENT, 7, payload);
        // Second call reverts
        vm.expectRevert(abi.encodeWithSelector(CCTPAdapterV2.IntentNotConfigured.selector, INTENT));
        executor.callAdapter(address(adapter), INTENT, 7, payload);
    }

    function testClearIntent() public {
        vm.prank(user);
        adapter.configureIntent(INTENT, 6, bytes32(uint256(uint160(recp))), bytes32(0));
        vm.prank(user);
        adapter.clearIntent(INTENT);
        (uint32 d,,,address f) = adapter.intentConfigs(INTENT);
        assertEq(d, 0);
        assertEq(f, address(0));
    }

    function testConfigDeletedAfterUse() public {
        executor.setBatch(uint256(INTENT), AMT, address(usdc));
        vm.prank(user);
        adapter.configureIntent(INTENT, 6, bytes32(uint256(uint160(recp))), bytes32(0));
        bytes memory payload = abi.encode(INTENT, address(usdc));
        executor.callAdapter(address(adapter), INTENT, 7, payload);
        (uint32 d,,,address f) = adapter.intentConfigs(INTENT);
        assertEq(d, 0);
        assertEq(f, address(0));
    }
}
