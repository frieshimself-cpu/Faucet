// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Minimal ERC-20 for the integration test. Same Transfer event signature as
/// every real token, which is what the engine reads from the receipt.
contract TestToken {
    string public name = "Robinhood";
    string public symbol = "ROBIN";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor(uint256 supply) {
        totalSupply = supply;
        balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value, "balance");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        emit Transfer(msg.sender, to, value);
        return true;
    }
}

/// A constant-product ETH/token bonding curve with the Pons v2 curve's
/// external shape: buy(amountIn, minOut, recipient) is payable, requires
/// msg.value == amountIn, returns the tokens delivered to `recipient`, and
/// reverts with the same custom-error selectors the real curve uses.
contract TestCurve {
    TestToken public token;
    address public pairToken = address(0);
    bool public graduated;
    uint256 public reserveEth;
    uint256 public reserveToken;

    /// Reverts with the exact selectors the mainnet curve uses, so the
    /// engine's revert naming is exercised against the real bytes.
    function insufficientOutput(uint256 actual, uint256 minimum) private pure {
        bytes memory data = abi.encodeWithSelector(bytes4(0x71c4efed), actual, minimum);
        assembly { revert(add(data, 32), mload(data)) }
    }

    function valueMismatch(uint256 amountIn, uint256 value) private pure {
        bytes memory data = abi.encodeWithSelector(bytes4(0xbc760cfe), amountIn, value);
        assembly { revert(add(data, 32), mload(data)) }
    }

    constructor(TestToken _token) {
        token = _token;
    }

    /// Seed liquidity. The deployer transfers tokens in first.
    function seed(uint256 tokenAmount) external payable {
        reserveEth += msg.value;
        reserveToken += tokenAmount;
    }

    function getReserves() external view returns (uint256, uint256) {
        return (reserveEth, reserveToken);
    }

    function quoteOut(uint256 amountIn) public view returns (uint256) {
        uint256 amountInWithFee = amountIn * 990;
        return (amountInWithFee * reserveToken) / (reserveEth * 1000 + amountInWithFee);
    }

    function buy(uint256 amountIn, uint256 minOut, address recipient) external payable returns (uint256 out) {
        if (msg.value != amountIn) valueMismatch(amountIn, msg.value);
        out = quoteOut(amountIn);
        if (out < minOut) insufficientOutput(out, minOut);
        reserveEth += amountIn;
        reserveToken -= out;
        require(token.transfer(recipient, out), "transfer");
    }

    /// Test hook: move the price against the buyer between quote and fill.
    function drain(uint256 tokenAmount) external {
        reserveToken -= tokenAmount;
        require(token.transfer(msg.sender, tokenAmount), "transfer");
    }

    function graduate() external {
        graduated = true;
    }
}

/// The Pons fee escrow's external shape: rewards accrue per recipient,
/// balanceOf reads them, claim() pays msg.sender and reverts when empty.
contract TestEscrow {
    mapping(address => uint256) public balanceOf;
    /// Reverts with the mainnet escrow's selector for an empty claim.
    function nothingToClaim() private pure {
        bytes memory data = abi.encodeWithSelector(bytes4(0xc2caa2a6));
        assembly { revert(add(data, 32), mload(data)) }
    }

    function deposit(address recipient) external payable {
        balanceOf[recipient] += msg.value;
    }

    function claim() external {
        uint256 amount = balanceOf[msg.sender];
        if (amount == 0) nothingToClaim();
        balanceOf[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "pay");
    }
}

/// The Pons factory's launch record, with the 15-word layout observed on
/// Robinhood Chain mainnet (see pons.ts).
contract TestFactory {
    struct Record {
        address token; address curve; address deployer; address creatorRecipient; address pairToken;
        uint256 graduationThreshold; uint256 launchConfigId; int24 tickSpacing;
        uint256 f8; uint256 f9; uint256 phase; uint256 f11; uint256 f12; uint256 f13; bool exists;
    }
    mapping(address => Record) private records;

    function register(address token, address curve, address deployer, address creatorRecipient, int24 tickSpacing) external {
        records[token] = Record(token, curve, deployer, creatorRecipient, address(0), 4.2 ether, 0, tickSpacing, 0, 0, 0, 0, 0, 0, true);
    }

    function getLaunchedToken(address token) external view returns (Record memory) {
        return records[token];
    }
}

/// Uniswap v4 StateView stand-in: no pool has liquidity before graduation.
contract TestStateView {
    function getLiquidity(bytes32) external pure returns (uint128) {
        return 0;
    }
}
