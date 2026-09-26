// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MockERC20} from "./MockERC20.sol";

/// @notice Fixed-price router for testnets: stands in for a Fusion fill or a DEX leg. Mints its output.
contract MockSwapRouter {
    using SafeERC20 for IERC20;

    error NoPrice();
    error Slippage(uint256 amountOut, uint256 minOut);

    /// @dev amountOut = amountIn * price[tokenIn][tokenOut] / 1e18
    mapping(address => mapping(address => uint256)) public price;

    event Swapped(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, address to);

    function setPrice(address tokenIn, address tokenOut, uint256 priceE18) external {
        price[tokenIn][tokenOut] = priceE18;
    }

    function quote(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256) {
        uint256 p = price[tokenIn][tokenOut];
        if (p == 0) revert NoPrice();
        return amountIn * p / 1e18;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address to)
        external
        returns (uint256 amountOut)
    {
        amountOut = quote(tokenIn, tokenOut, amountIn);
        if (amountOut < minOut) revert Slippage(amountOut, minOut);
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        MockERC20(tokenOut).mint(to, amountOut);
        emit Swapped(tokenIn, tokenOut, amountIn, amountOut, to);
    }
}
