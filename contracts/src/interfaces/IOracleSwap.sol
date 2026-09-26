// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IInventoryMaker
/// @notice Implemented by an Aqua maker that quotes a stable/volatile pair from its own inventory.
interface IInventoryMaker {
    function stable() external view returns (address);

    function volatileAsset() external view returns (address);

    /// @notice Validated oracle price: stable units per 1 whole volatile token, scaled by 1e18.
    function price() external view returns (uint256);

    /// @notice Total holdings of each asset (idle + lending positions).
    function holdings() external view returns (uint256 stableAmount, uint256 volatileAmount);

    /// @notice Target stable share of total value and allowed deviation, both in bps.
    function profile() external view returns (uint16 targetStableBps, uint16 bandBps);

    /// @notice Makes `amountOut` of `tokenOut` available and opens a swap window.
    function beginSwap(address tokenOut, uint256 amountOut) external;

    /// @notice Closes the swap window. Reverts if the vault lost value at the oracle price.
    function endSwap() external;
}

/// @title IOracleSwapCallback
/// @notice Implemented by takers of `OracleSwapApp` swaps.
interface IOracleSwapCallback {
    /// @dev Must push at least `amountIn` of `tokenIn` to the maker via `AQUA.push(maker, app, strategyHash, ...)`.
    function oracleSwapCallback(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address maker,
        bytes32 strategyHash,
        bytes calldata data
    ) external;
}
