// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MockERC20} from "./MockERC20.sol";

/// @notice ERC-4626 lending market stand-in (Morpho vault / Fluid fToken) for testnets and tests.
///         `accrue` mints interest into the vault; `setBorrowed` simulates utilisation by locking liquidity.
contract MockLendingVault is ERC4626 {
    error LiquidityLocked(uint256 requested, uint256 available);

    uint256 public borrowed;

    constructor(MockERC20 asset_, string memory name_, string memory symbol_) ERC4626(asset_) ERC20(name_, symbol_) {}

    /// @notice Simulates interest: increases share price by `bps` of current assets.
    function accrue(uint256 bps) external {
        uint256 interest = totalAssets() * bps / 10_000;
        if (interest > 0) MockERC20(asset()).mint(address(this), interest);
    }

    /// @notice Simulates borrowers taking `amount` of liquidity (cannot be withdrawn).
    function setBorrowed(uint256 amount) external {
        borrowed = amount;
    }

    function liquidity() public view returns (uint256) {
        uint256 cash = IERC20(asset()).balanceOf(address(this));
        return cash > borrowed ? cash - borrowed : 0;
    }

    function maxWithdraw(address owner) public view override returns (uint256) {
        return Math.min(super.maxWithdraw(owner), liquidity());
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        return Math.min(super.maxRedeem(owner), _convertToShares(liquidity(), Math.Rounding.Floor));
    }
}
