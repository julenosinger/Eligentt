// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title TaxPayment
 * @notice Receives USDC payments for Elligentt tax report generation.
 *         Each quoteId can only be used once (anti-replay).
 *         Emits PaymentReceived so the Pages Function can verify on-chain.
 *
 * @dev Deploy on Arc Mainnet (chainId 5042). USDC address is the Arc precompile.
 *      Set via constructor; never hardcoded.
 */
interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract TaxPayment {
    address public owner;
    address public usdc;
    address public treasury;

    /// @notice Emitted on every verified payment
    event PaymentReceived(bytes32 indexed quoteId, address indexed payer, uint256 amount);

    /// @notice Emitted when owner withdraws
    event Withdrawn(address indexed to, uint256 amount);

    /// quote ID → used?
    mapping(bytes32 => bool) public usedQuotes;

    modifier onlyOwner() { require(msg.sender == owner, "Not owner"); _; }

    constructor(address _usdc, address _treasury) {
        require(_usdc     != address(0), "zero usdc");
        require(_treasury != address(0), "zero treasury");
        owner    = msg.sender;
        usdc     = _usdc;
        treasury = _treasury;
    }

    /**
     * @notice Pay for a tax report.
     * @param quoteId  Unique ID issued by the server quote endpoint.
     * @param amount   USDC amount in 6-decimal atomic units.
     *
     * The caller must have approved this contract for `amount` of USDC first.
     * The function forwards the funds directly to treasury on success.
     */
    function pay(bytes32 quoteId, uint256 amount) external {
        require(quoteId != bytes32(0), "empty quoteId");
        require(amount  > 0,          "zero amount");
        require(!usedQuotes[quoteId], "quoteId already used");

        usedQuotes[quoteId] = true;

        require(
            IERC20(usdc).transferFrom(msg.sender, treasury, amount),
            "USDC transfer failed"
        );

        emit PaymentReceived(quoteId, msg.sender, amount);
    }

    /* ── Admin ─────────────────────────────────────────────────────────── */

    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "zero treasury");
        treasury = _treasury;
    }

    function setOwner(address _owner) external onlyOwner {
        require(_owner != address(0), "zero owner");
        owner = _owner;
    }

    /// @notice Emergency withdrawal of any ERC-20 held by this contract
    function withdraw(address token, uint256 amount) external onlyOwner {
        require(IERC20(token).transfer(owner, amount), "transfer failed");
        emit Withdrawn(owner, amount);
    }
}
