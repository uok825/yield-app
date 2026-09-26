// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MockERC20} from "./MockERC20.sol";
import {MockAToken} from "./MockAavePool.sol";
import {IChainlinkAggregator} from "../interfaces/IChainlinkAggregator.sol";

/// @notice Variable-debt balance view, like Aave's VariableDebtToken (non-transferable).
contract MockDebtToken {
    MockCreditMarket public immutable POOL;
    address public immutable UNDERLYING_ASSET_ADDRESS;

    constructor(MockCreditMarket pool_, address underlying_) {
        POOL = pool_;
        UNDERLYING_ASSET_ADDRESS = underlying_;
    }

    function balanceOf(address user) external view returns (uint256) {
        return POOL.debtOf(UNDERLYING_ASSET_ADDRESS, user);
    }
}

/// @notice Aave-oracle-style USD prices (8 decimals): the volatile asset from a Chainlink feed, stables at $1.
contract MockAaveOracle {
    IChainlinkAggregator public immutable FEED;
    address public immutable VOLATILE;

    constructor(IChainlinkAggregator feed_, address volatile_) {
        FEED = feed_;
        VOLATILE = volatile_;
    }

    function getAssetPrice(address asset) public view returns (uint256) {
        if (asset != VOLATILE) return 1e8;
        (, int256 answer,,,) = FEED.latestRoundData();
        return uint256(answer) * 1e8 / 10 ** FEED.decimals();
    }
}

/// @title MockCreditMarket
/// @notice Minimal Aave V3 subset for testnets: supply collateral, borrow / repay variable debt, account data.
///         Debt grows through a debt index the simulator accrues at `borrowRateRay` (APR, ray), exactly how
///         Aave's variable debt behaves. No liquidations (the CarryVault keeps LTV far below thresholds).
contract MockCreditMarket {
    using SafeERC20 for IERC20;

    error UnknownReserve();
    error NotBorrowable();
    error HealthFactorTooLow();
    error OnlyOwnAccount();

    uint256 internal constant RAY = 1e27;

    struct Reserve {
        MockAToken aToken;
        MockDebtToken debtToken;
        uint16 ltvBps;
        uint16 liquidationThresholdBps;
        bool borrowable;
        uint256 debtIndex; // ray
        uint256 borrowRateRay; // APR, ray (reported like Aave's currentVariableBorrowRate)
        uint256 totalScaledDebt;
        mapping(address => uint256) scaledDebt;
    }

    MockAaveOracle public immutable ORACLE;
    address[] public reserveList;
    mapping(address => Reserve) internal _reserves;

    constructor(MockAaveOracle oracle_) {
        ORACLE = oracle_;
    }

    function initReserve(MockERC20 asset, uint16 ltvBps, uint16 liqThresholdBps, bool borrowable, uint256 borrowRateRay)
        external
    {
        Reserve storage r = _reserves[address(asset)];
        require(address(r.aToken) == address(0), "exists");
        r.aToken = new MockAToken(address(this), asset);
        r.debtToken = new MockDebtToken(this, address(asset));
        (r.ltvBps, r.liquidationThresholdBps, r.borrowable) = (ltvBps, liqThresholdBps, borrowable);
        r.debtIndex = RAY;
        r.borrowRateRay = borrowRateRay;
        reserveList.push(address(asset));
    }

    // ─── Aave V3 surface ─────────────────────────────────────────────────────

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        Reserve storage r = _reserve(asset);
        IERC20(asset).safeTransferFrom(msg.sender, address(r.aToken), amount);
        r.aToken.mint(onBehalfOf, amount);
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        Reserve storage r = _reserve(asset);
        if (amount == type(uint256).max) amount = r.aToken.balanceOf(msg.sender);
        r.aToken.burn(msg.sender, to, amount);
        _checkHealth(msg.sender);
        return amount;
    }

    function borrow(address asset, uint256 amount, uint256, uint16, address onBehalfOf) external {
        if (onBehalfOf != msg.sender) revert OnlyOwnAccount();
        Reserve storage r = _reserve(asset);
        if (!r.borrowable) revert NotBorrowable();
        uint256 scaled = Math.mulDiv(amount, RAY, r.debtIndex, Math.Rounding.Ceil);
        r.scaledDebt[msg.sender] += scaled;
        r.totalScaledDebt += scaled;
        r.aToken.lockLiquidity(msg.sender, amount); // pay out from the reserve's cash
        (,,,,, uint256 hf) = getUserAccountData(msg.sender);
        if (hf < 1e18) revert HealthFactorTooLow();
        // Borrowing must also respect LTV (not just the liquidation threshold).
        (uint256 coll, uint256 debt,,, uint256 ltv,) = getUserAccountData(msg.sender);
        if (debt * 10_000 > coll * ltv) revert HealthFactorTooLow();
    }

    function repay(address asset, uint256 amount, uint256, address onBehalfOf) external returns (uint256) {
        Reserve storage r = _reserve(asset);
        uint256 debt = debtOf(asset, onBehalfOf);
        if (amount > debt) amount = debt;
        uint256 scaled = amount == debt ? r.scaledDebt[onBehalfOf] : Math.mulDiv(amount, RAY, r.debtIndex);
        r.scaledDebt[onBehalfOf] -= scaled;
        r.totalScaledDebt -= scaled;
        IERC20(asset).safeTransferFrom(msg.sender, address(r.aToken), amount);
        return amount;
    }

    /// @return totalCollateralBase USD 8dp · totalDebtBase USD 8dp · availableBorrowsBase · liquidation threshold bps
    ///         · ltv bps (collateral-weighted) · healthFactor (1e18)
    function getUserAccountData(address user)
        public
        view
        returns (uint256, uint256, uint256, uint256, uint256, uint256)
    {
        uint256[4] memory t; // coll, debt, ltv-weighted, threshold-weighted
        for (uint256 i; i < reserveList.length; ++i) {
            (uint256 c, uint256 d) = _values(reserveList[i], user);
            Reserve storage r = _reserves[reserveList[i]];
            t[0] += c;
            t[1] += d;
            t[2] += c * r.ltvBps;
            t[3] += c * r.liquidationThresholdBps;
        }
        uint256 ltv = t[0] == 0 ? 0 : t[2] / t[0];
        uint256 thr = t[0] == 0 ? 0 : t[3] / t[0];
        uint256 maxDebt = t[0] * ltv / 10_000;
        uint256 hf = t[1] == 0 ? type(uint256).max : t[0] * thr * 1e18 / 10_000 / t[1];
        return (t[0], t[1], maxDebt > t[1] ? maxDebt - t[1] : 0, thr, ltv, hf);
    }

    /// @dev USD (8 dp) value of a user's collateral and debt in one reserve.
    function _values(address asset, address user) internal view returns (uint256 coll, uint256 debt) {
        uint256 unit = 10 ** MockERC20(asset).decimals();
        uint256 price = ORACLE.getAssetPrice(asset);
        coll = _reserves[asset].aToken.balanceOf(user) * price / unit;
        debt = debtOf(asset, user) * price / unit;
    }

    // ─── Views / simulator hooks ─────────────────────────────────────────────

    function debtOf(address asset, address user) public view returns (uint256) {
        Reserve storage r = _reserves[asset];
        return Math.mulDiv(r.scaledDebt[user], r.debtIndex, RAY, Math.Rounding.Ceil);
    }

    function aTokenOf(address asset) external view returns (address) {
        return address(_reserve(asset).aToken);
    }

    function debtTokenOf(address asset) external view returns (address) {
        return address(_reserve(asset).debtToken);
    }

    /// @notice Current variable borrow APR in ray (like ReserveData.currentVariableBorrowRate).
    function borrowRate(address asset) external view returns (uint256) {
        return _reserve(asset).borrowRateRay;
    }

    /// @notice Simulator: set the borrow APR (ray).
    function setBorrowRate(address asset, uint256 rateRay) external {
        _reserve(asset).borrowRateRay = rateRay;
    }

    /// @notice Simulator: supply-side interest on a reserve (e.g. WETH collateral earning its lending rate).
    function accrueSupplyWad(address asset, uint256 rateWad) external {
        _reserve(asset).aToken.accrueWad(rateWad);
    }

    /// @notice Simulator: grow the debt index by `rateWad / 1e18` and pay that interest to suppliers (minted).
    function accrueDebtWad(address asset, uint256 rateWad) external {
        Reserve storage r = _reserve(asset);
        uint256 before = Math.mulDiv(r.totalScaledDebt, r.debtIndex, RAY);
        r.debtIndex = r.debtIndex * (1e18 + rateWad) / 1e18;
        uint256 interest = Math.mulDiv(r.totalScaledDebt, r.debtIndex, RAY) - before;
        if (interest > 0) r.aToken.accrueFromMarket(interest);
    }

    function _reserve(address asset) internal view returns (Reserve storage r) {
        r = _reserves[asset];
        if (address(r.aToken) == address(0)) revert UnknownReserve();
    }

    function _checkHealth(address user) internal view {
        (,,,,, uint256 hf) = getUserAccountData(user);
        if (hf < 1e18) revert HealthFactorTooLow();
    }
}
