// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IAqua} from "@1inch/aqua/interfaces/IAqua.sol";
import {AquaApp} from "@1inch/aqua/AquaApp.sol";

import {IInventoryMaker, IOracleSwapCallback} from "./interfaces/IOracleSwap.sol";

/// @title OracleSwapApp
/// @notice Aqua app that sells a maker's stable/volatile inventory at oracle-anchored prices.
///
///   skewBps  = clamp(skew * (volatileShare - targetVolatileShare) / band, -skew, +skew)
///   ask      = oracle * (1 + spread - skew)      maker sells volatile
///   bid      = oracle * (1 - spread - skew)      maker buys volatile
///
///   With skew <= spread the maker never trades worse than the oracle. When the maker holds too much of the
///   volatile asset, both prices drop: buying from it gets cheaper and selling to it gets worse, which pulls
///   inventory back toward target. Trades that would leave the maker's band are rejected unless they move the
///   ratio closer to target.
contract OracleSwapApp is AquaApp {
    using Math for uint256;

    error InvalidStrategy();
    error UnauthorizedTaker(address caller, address allowed);
    error UnknownToken(address token);
    error ZeroAmount();
    error TradeTooLarge(uint256 tradeValue, uint256 maxValue);
    error OutOfBand(uint256 stableRatioBps);
    error InsufficientOutput(uint256 amountOut, uint256 minAmountOut);
    error ExcessiveInput(uint256 amountIn, uint256 maxAmountIn);

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

    /// @param maker        IInventoryMaker (e.g. InventoryVault).
    /// @param taker        Only address allowed to swap; address(0) means anyone.
    /// @param spreadBps    Half-spread around the (skewed) oracle price.
    /// @param skewBps      Maximum price skew at the band edge. Must be <= spreadBps.
    /// @param maxTradeBps  Maximum trade value as a share of the maker's total value.
    struct Strategy {
        address maker;
        address taker;
        uint16 spreadBps;
        uint16 skewBps;
        uint16 maxTradeBps;
        bytes32 salt;
    }

    /// @dev Everything needed to price one trade.
    struct Quote {
        address stable;
        address volatileAsset;
        uint256 oraclePrice; // stable units per whole volatile token, 1e18-scaled
        uint256 bid;
        uint256 ask;
        uint256 stableHeld;
        uint256 volatileHeld;
        uint256 totalValue;
        uint256 volDenominator;
    }

    struct Trade {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 amountOut;
    }

    uint256 public constant MAX_SPREAD_BPS = 1_000;
    uint256 internal constant BPS = 10_000;

    constructor(IAqua aqua_) AquaApp(aqua_) {}

    // ─── Views ───────────────────────────────────────────────────────────────

    function strategyHash(Strategy calldata strategy) public pure returns (bytes32) {
        return keccak256(abi.encode(strategy));
    }

    /// @notice Current bid/ask (stable units per whole volatile token, 1e18-scaled) and the skew applied.
    function prices(Strategy calldata strategy) external view returns (uint256 bid, uint256 ask, int256 skewBps) {
        Quote memory q = _quote(strategy);
        (bid, ask, skewBps) = (q.bid, q.ask, _skew(strategy, q));
    }

    function quoteExactIn(Strategy calldata strategy, address tokenIn, uint256 amountIn)
        external
        view
        returns (uint256 amountOut)
    {
        Quote memory q = _quote(strategy);
        (, amountOut) = _exactIn(q, tokenIn, amountIn);
        _checkTrade(strategy, q, tokenIn, amountIn, amountOut);
    }

    function quoteExactOut(Strategy calldata strategy, address tokenOut, uint256 amountOut)
        external
        view
        returns (uint256 amountIn)
    {
        Quote memory q = _quote(strategy);
        address tokenIn;
        (tokenIn, amountIn) = _exactOut(q, tokenOut, amountOut);
        _checkTrade(strategy, q, tokenIn, amountIn, amountOut);
    }

    // ─── Swaps ───────────────────────────────────────────────────────────────

    function swapExactIn(
        Strategy calldata strategy,
        address tokenIn,
        uint256 amountIn,
        uint256 minAmountOut,
        address to,
        bytes calldata data
    ) external nonReentrantStrategy(strategy.maker, keccak256(abi.encode(strategy))) returns (uint256 amountOut) {
        Quote memory q = _quote(strategy);
        Trade memory t = Trade(tokenIn, address(0), amountIn, 0);
        (t.tokenOut, t.amountOut) = _exactIn(q, tokenIn, amountIn);
        if (t.amountOut < minAmountOut) revert InsufficientOutput(t.amountOut, minAmountOut);
        _settle(strategy, q, t, to, data);
        amountOut = t.amountOut;
    }

    function swapExactOut(
        Strategy calldata strategy,
        address tokenOut,
        uint256 amountOut,
        uint256 maxAmountIn,
        address to,
        bytes calldata data
    ) external nonReentrantStrategy(strategy.maker, keccak256(abi.encode(strategy))) returns (uint256 amountIn) {
        Quote memory q = _quote(strategy);
        Trade memory t = Trade(address(0), tokenOut, 0, amountOut);
        (t.tokenIn, t.amountIn) = _exactOut(q, tokenOut, amountOut);
        if (t.amountIn > maxAmountIn) revert ExcessiveInput(t.amountIn, maxAmountIn);
        _settle(strategy, q, t, to, data);
        amountIn = t.amountIn;
    }

    // ─── Internals ───────────────────────────────────────────────────────────

    function _settle(Strategy calldata strategy, Quote memory q, Trade memory t, address to, bytes calldata data)
        internal
    {
        if (strategy.taker != address(0) && msg.sender != strategy.taker) {
            revert UnauthorizedTaker(msg.sender, strategy.taker);
        }
        _checkTrade(strategy, q, t.tokenIn, t.amountIn, t.amountOut);

        bytes32 hash = keccak256(abi.encode(strategy));
        (uint256 balanceIn,) = AQUA.rawBalances(strategy.maker, address(this), hash, t.tokenIn);

        IInventoryMaker(strategy.maker).beginSwap(t.tokenOut, t.amountOut);
        AQUA.pull(strategy.maker, hash, t.tokenOut, t.amountOut, to);
        IOracleSwapCallback(msg.sender)
            .oracleSwapCallback(t.tokenIn, t.tokenOut, t.amountIn, t.amountOut, strategy.maker, hash, data);
        _safeCheckAquaPush(strategy.maker, hash, t.tokenIn, balanceIn + t.amountIn);
        IInventoryMaker(strategy.maker).endSwap();

        emit Swap(strategy.maker, hash, msg.sender, t.tokenIn, t.tokenOut, t.amountIn, t.amountOut, q.oraclePrice);
    }

    function _quote(Strategy calldata strategy) internal view returns (Quote memory q) {
        if (
            strategy.spreadBps > MAX_SPREAD_BPS || strategy.skewBps > strategy.spreadBps || strategy.maxTradeBps == 0
                || strategy.maxTradeBps > BPS
        ) revert InvalidStrategy();

        IInventoryMaker maker = IInventoryMaker(strategy.maker);
        q.stable = maker.stable();
        q.volatileAsset = maker.volatileAsset();
        q.oraclePrice = maker.price();
        (q.stableHeld, q.volatileHeld) = maker.holdings();
        q.volDenominator = 10 ** uint256(_decimals(q.volatileAsset)) * 1e18;
        q.totalValue = q.stableHeld + q.volatileHeld.mulDiv(q.oraclePrice, q.volDenominator);

        int256 skew = _skew(strategy, q);
        uint256 askBps = uint256(int256(BPS + uint256(strategy.spreadBps)) - skew);
        uint256 bidBps = uint256(int256(BPS - uint256(strategy.spreadBps)) - skew);
        q.ask = q.oraclePrice.mulDiv(askBps, BPS, Math.Rounding.Ceil);
        q.bid = q.oraclePrice.mulDiv(bidBps, BPS);
    }

    /// @dev Positive when the maker is volatile-heavy relative to target.
    function _skew(Strategy calldata strategy, Quote memory q) internal view returns (int256) {
        if (q.totalValue == 0 || strategy.skewBps == 0) return 0;
        (uint16 targetStable, uint16 band) = IInventoryMaker(strategy.maker).profile();
        int256 stableShare = int256(q.stableHeld.mulDiv(BPS, q.totalValue));
        int256 deviation = int256(uint256(targetStable)) - stableShare; // = volatile share - volatile target
        int256 skew = deviation * int256(uint256(strategy.skewBps)) / int256(uint256(band));
        int256 cap = int256(uint256(strategy.skewBps));
        return skew > cap ? cap : (skew < -cap ? -cap : skew);
    }

    function _exactIn(Quote memory q, address tokenIn, uint256 amountIn)
        internal
        pure
        returns (address tokenOut, uint256 amountOut)
    {
        if (amountIn == 0) revert ZeroAmount();
        if (tokenIn == q.stable) {
            (tokenOut, amountOut) = (q.volatileAsset, amountIn.mulDiv(q.volDenominator, q.ask));
        } else if (tokenIn == q.volatileAsset) {
            (tokenOut, amountOut) = (q.stable, amountIn.mulDiv(q.bid, q.volDenominator));
        } else {
            revert UnknownToken(tokenIn);
        }
        if (amountOut == 0) revert ZeroAmount();
    }

    function _exactOut(Quote memory q, address tokenOut, uint256 amountOut)
        internal
        pure
        returns (address tokenIn, uint256 amountIn)
    {
        if (amountOut == 0) revert ZeroAmount();
        if (tokenOut == q.volatileAsset) {
            (tokenIn, amountIn) = (q.stable, amountOut.mulDiv(q.ask, q.volDenominator, Math.Rounding.Ceil));
        } else if (tokenOut == q.stable) {
            (tokenIn, amountIn) = (q.volatileAsset, amountOut.mulDiv(q.volDenominator, q.bid, Math.Rounding.Ceil));
        } else {
            revert UnknownToken(tokenOut);
        }
    }

    /// @dev Size limit and band rule, evaluated on the post-trade inventory.
    function _checkTrade(
        Strategy calldata strategy,
        Quote memory q,
        address tokenIn,
        uint256 amountIn,
        uint256 amountOut
    ) internal view {
        bool buysVolatile = tokenIn == q.stable; // taker buys volatile from maker
        uint256 tradeValue = buysVolatile ? amountIn : amountOut;
        uint256 maxValue = q.totalValue.mulDiv(strategy.maxTradeBps, BPS);
        if (tradeValue > maxValue) revert TradeTooLarge(tradeValue, maxValue);

        uint256 s1 = buysVolatile ? q.stableHeld + amountIn : q.stableHeld - Math.min(amountOut, q.stableHeld);
        uint256 v1 = buysVolatile ? q.volatileHeld - Math.min(amountOut, q.volatileHeld) : q.volatileHeld + amountIn;

        (uint16 targetStable, uint16 band) = IInventoryMaker(strategy.maker).profile();
        uint256 before = _distanceBps(q.stableHeld, q.volatileHeld, q, targetStable);
        uint256 after_ = _distanceBps(s1, v1, q, targetStable);
        if (after_ > band && after_ >= before) {
            uint256 total = s1 + v1.mulDiv(q.oraclePrice, q.volDenominator);
            revert OutOfBand(total == 0 ? 0 : s1.mulDiv(BPS, total));
        }
    }

    function _distanceBps(uint256 s, uint256 v, Quote memory q, uint16 targetStable) internal pure returns (uint256) {
        uint256 total = s + v.mulDiv(q.oraclePrice, q.volDenominator);
        if (total == 0) return 0;
        uint256 r = s.mulDiv(BPS, total);
        return r > targetStable ? r - targetStable : targetStable - r;
    }

    function _decimals(address token) internal view returns (uint8) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("decimals()"));
        if (!ok || data.length < 32) revert UnknownToken(token);
        return abi.decode(data, (uint8));
    }
}
