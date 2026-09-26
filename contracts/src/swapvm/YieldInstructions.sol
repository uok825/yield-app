// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {Context} from "@1inch/swap-vm/libs/VM.sol";

import {IChainlinkAggregator} from "../interfaces/IChainlinkAggregator.sol";

/// @title YieldInstructions
/// @notice SwapVM instructions for liquidity that keeps earning lending yield: the maker's Aqua balances are
///         ERC-4626 shares (Morpho / Fluid / Aave-4626 positions), never idle tokens.
///
///  - `YieldOracleSwap` (opcode 64) — oracle ± spread market making on yield-bearing shares. Converts the share
///    registers to underlying assets, prices at Chainlink ± spread with an inventory skew toward the maker's target
///    stable ratio, enforces a max trade size and a ±band around the target, and converts the result back to shares.
///    Rounding always favours the maker (exact-in: out floored; exact-out: in ceiled), and because skew ≤ spread the
///    maker never trades worse than the oracle. Same pricing as `AquaYieldApp` market making, now as a composable
///    SwapVM instruction any taker can execute.
///  - `SequencerGuard` (opcode 65) — refuses to trade while the L2 sequencer is down or inside the grace period
///    after it comes back (Chainlink L2 sequencer uptime feed), when oracle prices may be stale.
abstract contract YieldInstructions {
    using Math for uint256;

    uint8 internal constant OP_YIELD_ORACLE_SWAP = 64;
    uint8 internal constant OP_SEQUENCER_GUARD = 65;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant MAX_SPREAD_BPS = 1_000;
    /// @dev Packed `YieldOracleSwap` args: stableShare | volatileShare | oracle | maxPriceAge | spread | skew |
    ///      maxTrade | targetStable | band.
    uint256 internal constant YIELD_ORACLE_SWAP_ARGS = 20 + 20 + 20 + 4 + 2 * 5;
    uint256 internal constant SEQUENCER_GUARD_ARGS = 20 + 4;

    error YieldOracleSwapBadArgs();
    error YieldOracleSwapUnknownPair(address tokenIn, address tokenOut);
    error YieldOracleSwapRecompute();
    error YieldOracleSwapStalePrice(uint256 updatedAt);
    error YieldOracleSwapInvalidPrice(int256 answer);
    error YieldOracleSwapTradeTooLarge(uint256 tradeValue, uint256 maxValue);
    error YieldOracleSwapOutOfBand(uint256 stableRatioBps);
    error YieldOracleSwapInsufficientBalance(uint256 amountOut, uint256 balanceOut);
    error SequencerDown();
    error SequencerGracePeriod(uint256 upSince);

    struct YieldOracleSwapArgs {
        address stableShare;
        address volatileShare;
        address oracle;
        uint32 maxPriceAge;
        uint16 spreadBps;
        uint16 skewBps;
        uint16 maxTradeBps;
        uint16 targetStableBps;
        uint16 bandBps;
    }

    struct Book {
        uint256 price; // stable asset units per whole volatile asset, 1e18-scaled
        uint256 volDen; // 10^volatileDecimals · 1e18
        uint256 bid;
        uint256 ask;
        uint256 stableHeld; // committed stable assets (from the Aqua share balance)
        uint256 volatileHeld; // committed volatile assets
        uint256 totalValue; // in stable units
    }

    // ─── Builders (also used off-chain through YieldSwapVMStrategies) ───────────

    function _buildYieldOracleSwap(YieldOracleSwapArgs memory a) internal pure returns (bytes memory) {
        bytes memory args = abi.encodePacked(
            a.stableShare,
            a.volatileShare,
            a.oracle,
            a.maxPriceAge,
            a.spreadBps,
            a.skewBps,
            a.maxTradeBps,
            a.targetStableBps,
            a.bandBps
        );
        return abi.encodePacked(OP_YIELD_ORACLE_SWAP, uint8(args.length), args);
    }

    function _buildSequencerGuard(address feed, uint32 gracePeriod) internal pure returns (bytes memory) {
        return abi.encodePacked(OP_SEQUENCER_GUARD, uint8(SEQUENCER_GUARD_ARGS), feed, gracePeriod);
    }

    function _parseYieldOracleSwap(bytes calldata args) internal pure returns (YieldOracleSwapArgs memory a) {
        if (args.length != YIELD_ORACLE_SWAP_ARGS) revert YieldOracleSwapBadArgs();
        a.stableShare = address(bytes20(args[0:20]));
        a.volatileShare = address(bytes20(args[20:40]));
        a.oracle = address(bytes20(args[40:60]));
        a.maxPriceAge = uint32(bytes4(args[60:64]));
        a.spreadBps = uint16(bytes2(args[64:66]));
        a.skewBps = uint16(bytes2(args[66:68]));
        a.maxTradeBps = uint16(bytes2(args[68:70]));
        a.targetStableBps = uint16(bytes2(args[70:72]));
        a.bandBps = uint16(bytes2(args[72:74]));
        if (
            a.spreadBps == 0 || a.spreadBps > MAX_SPREAD_BPS || a.skewBps > a.spreadBps || a.maxTradeBps == 0
                || a.maxTradeBps > BPS || a.targetStableBps > BPS || a.bandBps == 0 || a.bandBps > BPS / 2
                || a.oracle == address(0)
        ) revert YieldOracleSwapBadArgs();
    }

    // ─── YieldOracleSwap ─────────────────────────────────────────────────────

    /// @param args see `YieldOracleSwapArgs` (74 bytes, packed)
    function _yieldOracleSwap(Context memory ctx, bytes calldata args) internal view {
        YieldOracleSwapArgs memory a = _parseYieldOracleSwap(args);
        bool buysVolatile; // taker pays stable shares, receives volatile shares
        if (ctx.query.tokenIn == a.stableShare && ctx.query.tokenOut == a.volatileShare) buysVolatile = true;
        else if (ctx.query.tokenIn != a.volatileShare || ctx.query.tokenOut != a.stableShare) {
            revert YieldOracleSwapUnknownPair(ctx.query.tokenIn, ctx.query.tokenOut);
        }

        Book memory b = _book(a, ctx, buysVolatile);
        IERC4626 shareIn = IERC4626(ctx.query.tokenIn);
        IERC4626 shareOut = IERC4626(ctx.query.tokenOut);
        uint256 assetsIn;
        uint256 assetsOut;

        if (ctx.query.isExactIn) {
            if (ctx.swap.amountOut != 0) revert YieldOracleSwapRecompute();
            assetsIn = shareIn.convertToAssets(ctx.swap.amountIn); // floor
            assetsOut = buysVolatile ? assetsIn.mulDiv(b.volDen, b.ask) : assetsIn.mulDiv(b.bid, b.volDen);
            ctx.swap.amountOut = shareOut.convertToShares(assetsOut); // floor
        } else {
            if (ctx.swap.amountIn != 0) revert YieldOracleSwapRecompute();
            assetsOut = shareOut.previewMint(ctx.swap.amountOut); // ceil: value what leaves the maker high
            assetsIn = buysVolatile
                ? assetsOut.mulDiv(b.ask, b.volDen, Math.Rounding.Ceil)
                : assetsOut.mulDiv(b.volDen, b.bid, Math.Rounding.Ceil);
            ctx.swap.amountIn = shareIn.previewWithdraw(assetsIn); // ceil
        }
        if (ctx.swap.amountOut > ctx.swap.balanceOut) {
            revert YieldOracleSwapInsufficientBalance(ctx.swap.amountOut, ctx.swap.balanceOut);
        }
        _checkTrade(a, b, buysVolatile, assetsIn, assetsOut);
    }

    /// @dev Oracle price, committed inventory in assets, and skewed bid/ask.
    function _book(YieldOracleSwapArgs memory a, Context memory ctx, bool buysVolatile)
        internal
        view
        returns (Book memory b)
    {
        (, int256 answer,, uint256 updatedAt,) = IChainlinkAggregator(a.oracle).latestRoundData();
        if (answer <= 0) revert YieldOracleSwapInvalidPrice(answer);
        if (block.timestamp > updatedAt + a.maxPriceAge) revert YieldOracleSwapStalePrice(updatedAt);
        uint256 stableDec = IERC20Metadata(IERC4626(a.stableShare).asset()).decimals();
        uint256 volDec = IERC20Metadata(IERC4626(a.volatileShare).asset()).decimals();
        b.price = uint256(answer).mulDiv(10 ** stableDec * 1e18, 10 ** IChainlinkAggregator(a.oracle).decimals());
        b.volDen = 10 ** volDec * 1e18;

        (uint256 stableShares, uint256 volatileShares) =
            buysVolatile ? (ctx.swap.balanceIn, ctx.swap.balanceOut) : (ctx.swap.balanceOut, ctx.swap.balanceIn);
        b.stableHeld = IERC4626(a.stableShare).convertToAssets(stableShares);
        b.volatileHeld = IERC4626(a.volatileShare).convertToAssets(volatileShares);
        b.totalValue = b.stableHeld + b.volatileHeld.mulDiv(b.price, b.volDen);

        int256 skew = _skew(a, b);
        b.ask = b.price.mulDiv(uint256(int256(BPS + a.spreadBps) - skew), BPS, Math.Rounding.Ceil);
        b.bid = b.price.mulDiv(uint256(int256(BPS - a.spreadBps) - skew), BPS);
    }

    /// @dev Positive when the maker is volatile-heavy vs target: both quotes shift down (sell volatile cheaper,
    ///      buy it cheaper). |skew| ≤ skewBps ≤ spreadBps, so bid ≤ oracle ≤ ask always holds.
    function _skew(YieldOracleSwapArgs memory a, Book memory b) internal pure returns (int256) {
        if (b.totalValue == 0 || a.skewBps == 0) return 0;
        int256 stableShare = int256(b.stableHeld.mulDiv(BPS, b.totalValue));
        int256 skew = (int256(uint256(a.targetStableBps)) - stableShare) * int256(uint256(a.skewBps))
            / int256(uint256(a.bandBps));
        int256 cap = int256(uint256(a.skewBps));
        return skew > cap ? cap : (skew < -cap ? -cap : skew);
    }

    /// @dev Max trade size, and the band rule on the post-trade inventory: a trade may not leave the band unless it
    ///      moves the ratio back toward the target.
    function _checkTrade(
        YieldOracleSwapArgs memory a,
        Book memory b,
        bool buysVolatile,
        uint256 assetsIn,
        uint256 assetsOut
    ) internal pure {
        uint256 tradeValue = buysVolatile ? assetsIn : assetsOut;
        uint256 maxValue = b.totalValue.mulDiv(a.maxTradeBps, BPS);
        if (tradeValue > maxValue) revert YieldOracleSwapTradeTooLarge(tradeValue, maxValue);

        uint256 s1 = buysVolatile ? b.stableHeld + assetsIn : b.stableHeld - Math.min(assetsOut, b.stableHeld);
        uint256 v1 = buysVolatile ? b.volatileHeld - Math.min(assetsOut, b.volatileHeld) : b.volatileHeld + assetsIn;
        uint256 before = _distance(b.stableHeld, b.volatileHeld, b, a.targetStableBps);
        uint256 after_ = _distance(s1, v1, b, a.targetStableBps);
        if (after_ > a.bandBps && after_ >= before) {
            uint256 total = s1 + v1.mulDiv(b.price, b.volDen);
            revert YieldOracleSwapOutOfBand(total == 0 ? 0 : s1.mulDiv(BPS, total));
        }
    }

    function _distance(uint256 st, uint256 vo, Book memory b, uint16 target) internal pure returns (uint256) {
        uint256 total = st + vo.mulDiv(b.price, b.volDen);
        if (total == 0) return 0;
        uint256 r = st.mulDiv(BPS, total);
        return r > target ? r - target : target - r;
    }

    // ─── SequencerGuard ──────────────────────────────────────────────────────

    /// @param args feed (20 bytes) | gracePeriod seconds (4 bytes)
    function _sequencerGuard(Context memory, bytes calldata args) internal view {
        if (args.length != SEQUENCER_GUARD_ARGS) revert YieldOracleSwapBadArgs();
        address feed = address(bytes20(args[0:20]));
        uint256 grace = uint32(bytes4(args[20:24]));
        (, int256 answer, uint256 startedAt,,) = IChainlinkAggregator(feed).latestRoundData();
        if (answer != 0) revert SequencerDown(); // 0 = up, 1 = down
        if (startedAt == 0 || block.timestamp < startedAt + grace) revert SequencerGracePeriod(startedAt);
    }
}
