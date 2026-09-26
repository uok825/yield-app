// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IAaveV3Pool, IAaveV3AToken} from "../interfaces/IAaveV3.sol";
import {BaseAdapter} from "./BaseAdapter.sol";

/// @title AaveV3Adapter
/// @notice Supplies the asset to an Aave V3 pool. The aToken is passed explicitly so the adapter works across
///         Aave V3.x versions whose `getReserveData` layouts differ.
contract AaveV3Adapter is BaseAdapter {
    using SafeERC20 for IERC20;

    error PoolMismatch();
    error ShortWithdraw(uint256 requested, uint256 received);

    IAaveV3Pool public immutable pool;
    IAaveV3AToken public immutable aToken;

    constructor(address vault_, IAaveV3Pool pool_, IAaveV3AToken aToken_)
        BaseAdapter(vault_, aToken_.UNDERLYING_ASSET_ADDRESS())
    {
        if (aToken_.POOL() != address(pool_)) revert PoolMismatch();
        pool = pool_;
        aToken = aToken_;
    }

    function totalAssets() public view override returns (uint256) {
        return aToken.balanceOf(address(this));
    }

    /// @dev Bounded by the underlying cash sitting in the aToken contract (i.e. unborrowed liquidity).
    function maxWithdraw() external view override returns (uint256) {
        return Math.min(totalAssets(), IERC20(asset).balanceOf(address(aToken)));
    }

    function deposit(uint256 assets) external override onlyVault {
        IERC20(asset).forceApprove(address(pool), assets);
        pool.supply(asset, assets, address(this), 0);
    }

    function withdraw(uint256 assets, address receiver) external override onlyVault returns (uint256 withdrawn) {
        withdrawn = pool.withdraw(asset, assets, receiver);
        if (withdrawn != assets) revert ShortWithdraw(assets, withdrawn);
    }
}
