// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal subset of the Aave V3 Pool used by the adapter.
interface IAaveV3Pool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;

    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

/// @notice Minimal subset of the Aave V3 aToken used by the adapter.
interface IAaveV3AToken {
    function UNDERLYING_ASSET_ADDRESS() external view returns (address);

    function POOL() external view returns (address);

    function balanceOf(address account) external view returns (uint256);
}

/// @notice Aave V3 Pool subset for borrowing against supplied collateral.
interface IAaveV3CreditPool is IAaveV3Pool {
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)
        external;

    function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)
        external
        returns (uint256);

    function getUserAccountData(address user)
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );
}

/// @notice Aave price oracle: USD prices with 8 decimals (the same prices Aave liquidates with).
interface IAaveOracle {
    function getAssetPrice(address asset) external view returns (uint256);
}
