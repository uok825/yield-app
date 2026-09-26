// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MockERC20} from "./MockERC20.sol";

/// @notice Rebasing aToken: balance = scaledBalance * liquidityIndex / RAY, like Aave V3.
contract MockAToken {
    using SafeERC20 for IERC20;

    error OnlyPool();

    uint256 internal constant RAY = 1e27;

    address public immutable POOL;
    address public immutable UNDERLYING_ASSET_ADDRESS;
    uint8 public immutable decimals;
    string public name;
    string public symbol;

    uint256 public liquidityIndex = RAY;
    uint256 public scaledTotalSupply;
    mapping(address => uint256) public scaledBalanceOf;

    constructor(address pool_, MockERC20 underlying_) {
        POOL = pool_;
        UNDERLYING_ASSET_ADDRESS = address(underlying_);
        decimals = underlying_.decimals();
        name = string.concat("Mock Aave ", underlying_.symbol());
        symbol = string.concat("a", underlying_.symbol());
    }

    modifier onlyPool() {
        if (msg.sender != POOL) revert OnlyPool();
        _;
    }

    function balanceOf(address account) public view returns (uint256) {
        return Math.mulDiv(scaledBalanceOf[account], liquidityIndex, RAY);
    }

    function totalSupply() external view returns (uint256) {
        return Math.mulDiv(scaledTotalSupply, liquidityIndex, RAY);
    }

    function mint(address to, uint256 amount) external onlyPool {
        uint256 scaled = Math.mulDiv(amount, RAY, liquidityIndex);
        scaledBalanceOf[to] += scaled;
        scaledTotalSupply += scaled;
    }

    function burn(address from, address to, uint256 amount) external onlyPool {
        uint256 scaled = Math.mulDiv(amount, RAY, liquidityIndex, Math.Rounding.Ceil);
        scaledBalanceOf[from] -= scaled;
        scaledTotalSupply -= scaled;
        IERC20(UNDERLYING_ASSET_ADDRESS).safeTransfer(to, amount);
    }

    function accrue(uint256 bps) external onlyPool {
        uint256 supplyBefore = Math.mulDiv(scaledTotalSupply, liquidityIndex, RAY);
        liquidityIndex = liquidityIndex * (10_000 + bps) / 10_000;
        uint256 supplyAfter = Math.mulDiv(scaledTotalSupply, liquidityIndex, RAY);
        if (supplyAfter > supplyBefore) {
            MockERC20(UNDERLYING_ASSET_ADDRESS).mint(address(this), supplyAfter - supplyBefore);
        }
    }

    function lockLiquidity(address to, uint256 amount) external onlyPool {
        IERC20(UNDERLYING_ASSET_ADDRESS).safeTransfer(to, amount);
    }
}

/// @notice Minimal Aave V3 pool for a single reserve. `borrow` simulates utilisation by removing cash.
contract MockAavePool {
    using SafeERC20 for IERC20;

    error UnknownReserve();

    MockERC20 public immutable underlying;
    MockAToken public immutable aToken;

    constructor(MockERC20 underlying_) {
        underlying = underlying_;
        aToken = new MockAToken(address(this), underlying_);
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        if (asset != address(underlying)) revert UnknownReserve();
        IERC20(asset).safeTransferFrom(msg.sender, address(aToken), amount);
        aToken.mint(onBehalfOf, amount);
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        if (asset != address(underlying)) revert UnknownReserve();
        if (amount == type(uint256).max) amount = aToken.balanceOf(msg.sender);
        aToken.burn(msg.sender, to, amount);
        return amount;
    }

    function accrue(uint256 bps) external {
        aToken.accrue(bps);
    }

    /// @notice Moves `amount` of cash out of the reserve to `to`, like a borrower would.
    function borrow(uint256 amount, address to) external {
        aToken.lockLiquidity(to, amount);
    }
}
