// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IYieldAdapter
/// @notice Thin wrapper around one lending market. The adapter holds the market position on behalf of a single vault.
interface IYieldAdapter {
    /// @notice Underlying asset (e.g. USDC).
    function asset() external view returns (address);

    /// @notice The only address allowed to move funds through this adapter.
    function vault() external view returns (address);

    /// @notice Assets currently held in the market for the vault, valued conservatively.
    function totalAssets() external view returns (uint256);

    /// @notice Assets that can be withdrawn right now (bounded by market liquidity).
    function maxWithdraw() external view returns (uint256);

    /// @notice Supplies `assets` that the vault has already transferred to the adapter.
    function deposit(uint256 assets) external;

    /// @notice Withdraws exactly `assets` from the market to `receiver`.
    function withdraw(uint256 assets, address receiver) external returns (uint256 withdrawn);
}
