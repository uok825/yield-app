// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IAaveV3Pool, IAaveV3AToken} from "./interfaces/IAaveV3.sol";

/// @title Aave4626
/// @notice Non-rebasing ERC-4626 wrapper around an Aave V3 reserve (like Aave's static aTokens). Interest shows up as
///         a rising share price instead of a growing balance, so the shares can sit in a wallet and be committed to
///         an Aqua strategy with a fixed budget.
contract Aave4626 is ERC4626 {
    using SafeERC20 for IERC20;

    error PoolMismatch();

    IAaveV3Pool public immutable POOL;
    IAaveV3AToken public immutable A_TOKEN;

    constructor(IAaveV3Pool pool_, IAaveV3AToken aToken_, string memory name_, string memory symbol_)
        ERC4626(IERC20(aToken_.UNDERLYING_ASSET_ADDRESS()))
        ERC20(name_, symbol_)
    {
        if (aToken_.POOL() != address(pool_)) revert PoolMismatch();
        POOL = pool_;
        A_TOKEN = aToken_;
    }

    function totalAssets() public view override returns (uint256) {
        return A_TOKEN.balanceOf(address(this));
    }

    /// @dev Bounded by the reserve's unborrowed cash.
    function maxWithdraw(address owner) public view override returns (uint256) {
        return Math.min(super.maxWithdraw(owner), IERC20(asset()).balanceOf(address(A_TOKEN)));
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        uint256 cash = IERC20(asset()).balanceOf(address(A_TOKEN));
        return Math.min(super.maxRedeem(owner), _convertToShares(cash, Math.Rounding.Floor));
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        super._deposit(caller, receiver, assets, shares);
        IERC20(asset()).forceApprove(address(POOL), assets);
        POOL.supply(asset(), assets, address(this), 0);
    }

    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal
        override
    {
        if (caller != owner) _spendAllowance(owner, caller, shares);
        _burn(owner, shares);
        POOL.withdraw(asset(), assets, receiver);
        emit Withdraw(caller, receiver, owner, assets, shares);
    }

    /// @dev Virtual-share offset against donation attacks, matching the asset's precision headroom.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }
}
