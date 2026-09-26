// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IJitLiquidityProvider
/// @notice Implemented by an Aqua maker whose idle tokens may be parked elsewhere (e.g. lending markets).
///         A trusted Aqua app calls `lendLiquidity` right before `AQUA.pull` and `settleLiquidity` once the
///         taker has pushed tokens back.
interface IJitLiquidityProvider {
    /// @notice Makes at least `amount` of `token` available in the maker's wallet and opens a lending window.
    function lendLiquidity(address token, uint256 amount) external;

    /// @notice Closes the lending window. Must revert if the maker ended up with fewer tokens than before.
    function settleLiquidity(address token, uint256 amount) external;
}

/// @title IJitLiquidityCallback
/// @notice Implemented by takers of `JitLiquidityApp.flash`.
interface IJitLiquidityCallback {
    /// @notice Called after `amount` of `token` was sent to the receiver.
    /// @dev Must push at least `amount + fee` of `token` to the maker via `AQUA.push(maker, app, strategyHash, ...)`.
    function onJitLiquidity(
        address token,
        uint256 amount,
        uint256 fee,
        address maker,
        bytes32 strategyHash,
        bytes calldata data
    ) external;
}
