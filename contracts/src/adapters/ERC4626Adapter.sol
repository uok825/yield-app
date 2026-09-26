// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {BaseAdapter} from "./BaseAdapter.sol";

/// @title ERC4626Adapter
/// @notice Adapter for any ERC-4626 lending vault: Morpho (MetaMorpho) vaults and Fluid fTokens both qualify.
contract ERC4626Adapter is BaseAdapter {
    using SafeERC20 for IERC20;

    IERC4626 public immutable target;

    constructor(address vault_, IERC4626 target_) BaseAdapter(vault_, target_.asset()) {
        target = target_;
    }

    function totalAssets() external view override returns (uint256) {
        return target.previewRedeem(target.balanceOf(address(this)));
    }

    function maxWithdraw() external view override returns (uint256) {
        return target.maxWithdraw(address(this));
    }

    function deposit(uint256 assets) external override onlyVault {
        IERC20(asset).forceApprove(address(target), assets);
        target.deposit(assets, address(this));
    }

    function withdraw(uint256 assets, address receiver) external override onlyVault returns (uint256) {
        target.withdraw(assets, receiver, address(this));
        return assets;
    }
}
