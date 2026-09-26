// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IYieldAdapter} from "../interfaces/IYieldAdapter.sol";

/// @title BaseAdapter
/// @notice Shared plumbing: immutable vault/asset binding and access control.
abstract contract BaseAdapter is IYieldAdapter {
    error OnlyVault();
    error ZeroAddress();
    error AssetMismatch();

    address public immutable override vault;
    address public immutable override asset;

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    constructor(address vault_, address asset_) {
        if (vault_ == address(0) || asset_ == address(0)) revert ZeroAddress();
        vault = vault_;
        asset = asset_;
    }

    function _idle() internal view returns (uint256) {
        return IERC20(asset).balanceOf(address(this));
    }
}
