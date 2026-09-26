// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";
import {AquaApp} from "@1inch/aqua/src/AquaApp.sol";

import {IChainlinkAggregator} from "./interfaces/IChainlinkAggregator.sol";
import {IAquaYieldCallback} from "./interfaces/IAquaYield.sol";

/// @title AquaYieldApp
/// @notice Self-custody yield + liquidity for wallets, the Aqua way: the user (maker) keeps yield-bearing ERC-4626
///         lending shares (Morpho / Fluid / Aave-4626) in their own wallet and ships ONE strategy listing the markets
///         they accept. Tokens only leave the wallet for the duration of a transaction, and always come back as
///         shares of a listed market:
///
///   rebalance      keeper moves shares between two listed markets of the same asset (e.g. Morpho → Aave when Aave
///                  pays more). Value-preserving by construction: redeem, deposit, push back, check.
///   flash          JIT liquidity: withdraw assets for the taker, who must pay back `assets + fee`; the repayment is
///                  deposited and pushed back as shares. The fee accrues to the maker.
///   swapExactOut   Market making from the committed inventory at oracle ± spread with inventory skew (same pricing as
///                  OracleSwapApp); the taker pays in the other asset, which is deposited into a listed market.
///
/// One app handles all three so that a keeper rebalance and the liquidity actions share one set of Aqua budgets.
/// Budgets are share amounts; share prices grow with interest, so committed value grows without re-shipping.
contract AquaYieldApp is AquaApp {
    using SafeERC20 for IERC20;
    using Math for uint256;

    // ─── Errors ──────────────────────────────────────────────────────────────
    error InvalidStrategy();
    error InvalidMarket(address market);
    error Unauthorized(address caller);
    error FlashDisabled();
    error MarketMakingDisabled();
    error NotRepaid(uint256 received, uint256 expected);
    error ValueLost(uint256 assetsIn, uint256 assetsOut);
    error StalePrice(uint256 updatedAt);
    error InvalidPrice(int256 answer);
    error UnknownToken(address token);
    error TradeTooLarge(uint256 tradeValue, uint256 maxValue);
    error OutOfBand(uint256 stableRatioBps);
    error ExcessiveInput(uint256 amountIn, uint256 maxAmountIn);
    error ZeroAmount();

    // ─── Events ──────────────────────────────────────────────────────────────
    event Rebalanced(
        address indexed maker, bytes32 indexed strategyHash, address from, address to, uint256 shares, uint256 assets
    );
    event Flash(
        address indexed maker,
        bytes32 indexed strategyHash,
        address indexed taker,
        address market,
        uint256 assets,
        uint256 fee
    );
    event Swap(
        address indexed maker,
        bytes32 indexed strategyHash,
        address indexed taker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 oraclePrice
    );

    // ─── Types ───────────────────────────────────────────────────────────────

    /// @dev spreadBps == 0 disables market making.
    struct MarketMaking {
        address oracle; // Chainlink-style ETH/USD
        uint32 maxPriceAge;
        uint16 spreadBps;
        uint16 skewBps; // <= spreadBps: never trades worse than the oracle
        uint16 maxTradeBps; // max trade value as a share of committed value
        uint16 targetStableBps;
        uint16 bandBps;
    }

    /// @param maker            The wallet that shipped the strategy (owns the shares).
    /// @param stable           Stable asset (USDC).
    /// @param volatileAsset    Volatile asset (WETH); address(0) if only the stable side is used.
    /// @param stableMarkets    ERC-4626 markets over `stable` the maker accepts. Their shares are the Aqua tokens.
    /// @param volatileMarkets  ERC-4626 markets over `volatileAsset`.
    /// @param keeper           May rebalance between listed markets; address(0) disables rebalancing.
    /// @param taker            Only address that may use the liquidity; address(0) = anyone.
    /// @param flashFeeBps      JIT fee paid to the maker; 0 disables JIT.
    struct Strategy {
        address maker;
        address stable;
        address volatileAsset;
        address[] stableMarkets;
        address[] volatileMarkets;
        address keeper;
        address taker;
        uint16 flashFeeBps;
        MarketMaking mm;
        bytes32 salt;
    }

    struct SwapParams {
        address tokenOut;
        uint256 amountOut;
        uint256 maxAmountIn;
        address outMarket; // listed market of tokenOut to withdraw from
        address inMarket; // listed market of tokenIn to deposit the payment into
        address to;
    }

    struct Quote {
        uint256 price; // stable units per whole volatile token, 1e18-scaled
        uint256 bid;
        uint256 ask;
        uint256 stableHeld; // committed, in stable units
        uint256 volatileHeld; // committed, in volatile units
        uint256 totalValue;
        uint256 volDen;
    }

    uint256 internal constant BPS = 10_000;
    uint256 public constant MAX_FEE_BPS = 1_000;
    /// @dev Tolerated rounding loss per ERC-4626 round trip (wei of the asset).
    uint256 internal constant DUST = 10;

    constructor(IAqua aqua_) AquaApp(aqua_) {}

    // ═════════════════════════════════════════════════════════════════════════
    //  Views
    // ═════════════════════════════════════════════════════════════════════════

    function strategyHash(Strategy calldata s) public pure returns (bytes32) {
        return keccak256(abi.encode(s));
    }

    /// @notice Committed inventory (Aqua budgets, valued at current share prices).
    function holdings(Strategy calldata s) public view returns (uint256 stableAssets, uint256 volatileAssets) {
        bytes32 h = strategyHash(s);
        stableAssets = _sideAssets(s.maker, h, s.stableMarkets);
        volatileAssets = _sideAssets(s.maker, h, s.volatileMarkets);
    }

    /// @notice Current bid/ask (stable units per whole volatile, 1e18-scaled) and skew in bps.
    function prices(Strategy calldata s) external view returns (uint256 bid, uint256 ask, int256 skewBps) {
        Quote memory q = _quote(s);
        return (q.bid, q.ask, _skew(s, q));
    }

    /// @notice Input needed to buy exactly `amountOut` of `tokenOut` from the maker. Reverts if the trade is refused.
    function quoteExactOut(Strategy calldata s, address tokenOut, uint256 amountOut)
        external
        view
        returns (uint256 amountIn)
    {
        Quote memory q = _quote(s);
        address tokenIn;
        (tokenIn, amountIn) = _exactOut(s, q, tokenOut, amountOut);
        _checkTrade(s, q, tokenIn, amountIn, amountOut);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Rebalance (keeper)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Moves `shares` of the maker's position from `from` to `to` (both listed for the same asset).
    function rebalance(Strategy calldata s, address from, address to, uint256 shares)
        external
        nonReentrantStrategy(s.maker, keccak256(abi.encode(s)))
        returns (uint256 newShares)
    {
        if (s.keeper == address(0) || msg.sender != s.keeper) revert Unauthorized(msg.sender);
        if (shares == 0) revert ZeroAmount();
        if (from == to) revert InvalidMarket(to);
        address asset = _sameSide(s, from, to);
        bytes32 h = keccak256(abi.encode(s));

        AQUA.pull(s.maker, h, from, shares, address(this));
        uint256 assets = IERC4626(from).redeem(shares, address(this), address(this));
        IERC20(asset).forceApprove(to, assets);
        newShares = IERC4626(to).deposit(assets, address(this));
        uint256 back = IERC4626(to).previewRedeem(newShares);
        if (back + DUST < assets) revert ValueLost(assets, back);

        _pushToMaker(s.maker, h, to, newShares);
        emit Rebalanced(s.maker, h, from, to, shares, assets);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  JIT liquidity
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Lends `assets` of `market`'s asset to `receiver` for one call; `amount + fee` must come back.
    function flash(Strategy calldata s, address market, uint256 assets, address receiver, bytes calldata data)
        external
        nonReentrantStrategy(s.maker, keccak256(abi.encode(s)))
        returns (uint256 fee)
    {
        if (s.flashFeeBps == 0) revert FlashDisabled();
        if (s.flashFeeBps > MAX_FEE_BPS) revert InvalidStrategy();
        _checkTaker(s);
        if (assets == 0) revert ZeroAmount();
        address token = _listedAsset(s, market);
        fee = assets.mulDiv(s.flashFeeBps, BPS, Math.Rounding.Ceil);
        _settleFlash(s, market, token, assets, fee, receiver, data);
        emit Flash(s.maker, keccak256(abi.encode(s)), msg.sender, market, assets, fee);
    }

    /// @dev Pull shares → withdraw `assets` to `receiver` → taker repays `assets + fee` → deposit → push shares back.
    function _settleFlash(
        Strategy calldata s,
        address market,
        address token,
        uint256 assets,
        uint256 fee,
        address receiver,
        bytes calldata data
    ) internal {
        bytes32 h = keccak256(abi.encode(s));
        AQUA.pull(s.maker, h, market, IERC4626(market).previewWithdraw(assets), address(this));
        IERC4626(market).withdraw(assets, receiver, address(this));

        uint256 before = IERC20(token).balanceOf(address(this));
        IAquaYieldCallback(msg.sender).onAquaYieldFlash(token, assets, fee, s.maker, h, data);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        if (received < assets + fee) revert NotRepaid(received, assets + fee);
        _depositAndPush(s.maker, h, market, IERC20(token), received);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Market making
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Sells exactly `p.amountOut` of `p.tokenOut` from the maker's committed inventory at oracle ± spread.
    function swapExactOut(Strategy calldata s, SwapParams calldata p, bytes calldata data)
        external
        nonReentrantStrategy(s.maker, keccak256(abi.encode(s)))
        returns (uint256 amountIn)
    {
        _checkTaker(s);
        address tokenIn;
        uint256 price;
        (tokenIn, amountIn, price) = _priceSwap(s, p);
        _settleSwap(s, p, tokenIn, amountIn, data);
        emit Swap(s.maker, keccak256(abi.encode(s)), msg.sender, tokenIn, p.tokenOut, amountIn, p.amountOut, price);
    }

    /// @dev Quote + all checks (limit, size, band, markets). Nothing moves here.
    function _priceSwap(Strategy calldata s, SwapParams calldata p)
        internal
        view
        returns (address tokenIn, uint256 amountIn, uint256 price)
    {
        Quote memory q = _quote(s);
        (tokenIn, amountIn) = _exactOut(s, q, p.tokenOut, p.amountOut);
        if (amountIn > p.maxAmountIn) revert ExcessiveInput(amountIn, p.maxAmountIn);
        _checkTrade(s, q, tokenIn, amountIn, p.amountOut);
        if (_listedAsset(s, p.outMarket) != p.tokenOut) revert InvalidMarket(p.outMarket);
        if (_listedAsset(s, p.inMarket) != tokenIn) revert InvalidMarket(p.inMarket);
        price = q.price;
    }

    /// @dev Pull shares → withdraw `amountOut` to `p.to` → taker pays `amountIn` → deposit → push shares back.
    function _settleSwap(
        Strategy calldata s,
        SwapParams calldata p,
        address tokenIn,
        uint256 amountIn,
        bytes calldata data
    ) internal {
        bytes32 h = keccak256(abi.encode(s));
        uint256 shares = IERC4626(p.outMarket).previewWithdraw(p.amountOut);
        AQUA.pull(s.maker, h, p.outMarket, shares, address(this));
        IERC4626(p.outMarket).withdraw(p.amountOut, p.to, address(this));

        uint256 before = IERC20(tokenIn).balanceOf(address(this));
        IAquaYieldCallback(msg.sender).onAquaYieldSwap(tokenIn, p.tokenOut, amountIn, p.amountOut, s.maker, h, data);
        uint256 received = IERC20(tokenIn).balanceOf(address(this)) - before;
        if (received < amountIn) revert NotRepaid(received, amountIn);
        _depositAndPush(s.maker, h, p.inMarket, IERC20(tokenIn), received);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Internals
    // ═════════════════════════════════════════════════════════════════════════

    function _checkTaker(Strategy calldata s) internal view {
        if (s.taker != address(0) && msg.sender != s.taker) revert Unauthorized(msg.sender);
    }

    function _depositAndPush(address maker, bytes32 h, address market, IERC20 token, uint256 assets) internal {
        token.forceApprove(market, assets);
        uint256 shares = IERC4626(market).deposit(assets, address(this));
        _pushToMaker(maker, h, market, shares);
    }

    /// @dev Aqua moves the shares from this app to the maker's wallet and raises the budget accordingly.
    function _pushToMaker(address maker, bytes32 h, address token, uint256 amount) internal {
        IERC20(token).forceApprove(address(AQUA), amount);
        AQUA.push(maker, address(this), h, token, amount);
    }

    function _inList(address[] calldata list, address m) internal pure returns (bool) {
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == m) return true;
        }
        return false;
    }

    /// @dev The underlying asset of a listed market, checked against the strategy's asset for that side.
    function _listedAsset(Strategy calldata s, address market) internal view returns (address asset) {
        if (_inList(s.stableMarkets, market)) {
            asset = s.stable;
        } else if (s.volatileAsset != address(0) && _inList(s.volatileMarkets, market)) {
            asset = s.volatileAsset;
        } else {
            revert InvalidMarket(market);
        }
        if (IERC4626(market).asset() != asset) revert InvalidMarket(market);
    }

    function _sameSide(Strategy calldata s, address from, address to) internal view returns (address asset) {
        asset = _listedAsset(s, from);
        if (_listedAsset(s, to) != asset) revert InvalidMarket(to);
    }

    function _sideAssets(address maker, bytes32 h, address[] calldata markets) internal view returns (uint256 total) {
        for (uint256 i; i < markets.length; ++i) {
            (uint248 budget,) = AQUA.rawBalances(maker, address(this), h, markets[i]);
            if (budget > 0) total += IERC4626(markets[i]).convertToAssets(budget);
        }
    }

    function _quote(Strategy calldata s) internal view returns (Quote memory q) {
        MarketMaking calldata mm = s.mm;
        if (mm.spreadBps == 0) revert MarketMakingDisabled();
        if (
            s.volatileAsset == address(0) || s.volatileMarkets.length == 0 || mm.spreadBps > MAX_FEE_BPS
                || mm.skewBps > mm.spreadBps || mm.maxTradeBps == 0 || mm.maxTradeBps > BPS || mm.targetStableBps > BPS
                || mm.bandBps == 0 || mm.bandBps > BPS / 2 || mm.oracle == address(0)
        ) revert InvalidStrategy();

        (, int256 answer,, uint256 updatedAt,) = IChainlinkAggregator(mm.oracle).latestRoundData();
        if (answer <= 0) revert InvalidPrice(answer);
        if (block.timestamp > updatedAt + mm.maxPriceAge) revert StalePrice(updatedAt);
        uint256 stableDec = IERC20Metadata(s.stable).decimals();
        uint256 oracleDec = IChainlinkAggregator(mm.oracle).decimals();
        q.price = uint256(answer).mulDiv(10 ** stableDec * 1e18, 10 ** oracleDec);
        q.volDen = 10 ** uint256(IERC20Metadata(s.volatileAsset).decimals()) * 1e18;

        (q.stableHeld, q.volatileHeld) = holdings(s);
        q.totalValue = q.stableHeld + q.volatileHeld.mulDiv(q.price, q.volDen);

        int256 skew = _skew(s, q);
        uint256 askBps = uint256(int256(BPS + uint256(mm.spreadBps)) - skew);
        uint256 bidBps = uint256(int256(BPS - uint256(mm.spreadBps)) - skew);
        q.ask = q.price.mulDiv(askBps, BPS, Math.Rounding.Ceil);
        q.bid = q.price.mulDiv(bidBps, BPS);
    }

    /// @dev Positive when the committed inventory is volatile-heavy relative to target.
    function _skew(Strategy calldata s, Quote memory q) internal pure returns (int256) {
        if (q.totalValue == 0 || s.mm.skewBps == 0) return 0;
        int256 stableShare = int256(q.stableHeld.mulDiv(BPS, q.totalValue));
        int256 deviation = int256(uint256(s.mm.targetStableBps)) - stableShare;
        int256 skew = deviation * int256(uint256(s.mm.skewBps)) / int256(uint256(s.mm.bandBps));
        int256 cap = int256(uint256(s.mm.skewBps));
        return skew > cap ? cap : (skew < -cap ? -cap : skew);
    }

    function _exactOut(Strategy calldata s, Quote memory q, address tokenOut, uint256 amountOut)
        internal
        pure
        returns (address tokenIn, uint256 amountIn)
    {
        if (amountOut == 0) revert ZeroAmount();
        if (tokenOut == s.volatileAsset) {
            (tokenIn, amountIn) = (s.stable, amountOut.mulDiv(q.ask, q.volDen, Math.Rounding.Ceil));
        } else if (tokenOut == s.stable) {
            (tokenIn, amountIn) = (s.volatileAsset, amountOut.mulDiv(q.volDen, q.bid, Math.Rounding.Ceil));
        } else {
            revert UnknownToken(tokenOut);
        }
    }

    /// @dev Size limit and band rule on the post-trade committed inventory.
    function _checkTrade(Strategy calldata s, Quote memory q, address tokenIn, uint256 amountIn, uint256 amountOut)
        internal
        pure
    {
        bool buysVolatile = tokenIn == s.stable;
        uint256 tradeValue = buysVolatile ? amountIn : amountOut;
        uint256 maxValue = q.totalValue.mulDiv(s.mm.maxTradeBps, BPS);
        if (tradeValue > maxValue) revert TradeTooLarge(tradeValue, maxValue);

        uint256 s1 = buysVolatile ? q.stableHeld + amountIn : q.stableHeld - Math.min(amountOut, q.stableHeld);
        uint256 v1 = buysVolatile ? q.volatileHeld - Math.min(amountOut, q.volatileHeld) : q.volatileHeld + amountIn;
        uint256 before = _distance(q.stableHeld, q.volatileHeld, q, s.mm.targetStableBps);
        uint256 after_ = _distance(s1, v1, q, s.mm.targetStableBps);
        if (after_ > s.mm.bandBps && after_ >= before) {
            uint256 total = s1 + v1.mulDiv(q.price, q.volDen);
            revert OutOfBand(total == 0 ? 0 : s1.mulDiv(BPS, total));
        }
    }

    function _distance(uint256 st, uint256 vo, Quote memory q, uint16 target) internal pure returns (uint256) {
        uint256 total = st + vo.mulDiv(q.price, q.volDen);
        if (total == 0) return 0;
        uint256 r = st.mulDiv(BPS, total);
        return r > target ? r - target : target - r;
    }
}
