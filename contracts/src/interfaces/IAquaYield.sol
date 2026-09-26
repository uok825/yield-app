// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IAquaYieldCallback
/// @notice Implemented by takers of `AquaYieldApp`. The taker pays by transferring tokens to the app (msg.sender);
///         the app deposits them into the maker's lending market and pushes the shares back to the maker's wallet.
interface IAquaYieldCallback {
    /// @dev Must transfer at least `amount + fee` of `token` to msg.sender.
    function onAquaYieldFlash(
        address token,
        uint256 amount,
        uint256 fee,
        address maker,
        bytes32 strategyHash,
        bytes calldata data
    ) external;

    /// @dev Must transfer at least `amountIn` of `tokenIn` to msg.sender.
    function onAquaYieldSwap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address maker,
        bytes32 strategyHash,
        bytes calldata data
    ) external;
}
