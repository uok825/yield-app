// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";

import {ISwapVM} from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import {SwapVM} from "@1inch/swap-vm/SwapVM.sol";
import {TakerTraitsLib} from "@1inch/swap-vm/libs/TakerTraits.sol";
import {CoreInvariants} from "../lib/swap-vm/test/invariants/CoreInvariants.t.sol";

import {Fixture} from "./utils/Fixture.sol";
import {Aave4626} from "../src/Aave4626.sol";
import {AquaYieldApp} from "../src/AquaYieldApp.sol";
import {WalletResolver} from "../src/WalletResolver.sol";
import {YieldSwapVMRouter} from "../src/swapvm/YieldSwapVMRouter.sol";
import {YieldSwapVMStrategies} from "../src/swapvm/YieldSwapVMStrategies.sol";
import {YieldInstructions} from "../src/swapvm/YieldInstructions.sol";
import {SwapVMResolver} from "../src/swapvm/SwapVMResolver.sol";
import {IAaveV3Pool, IAaveV3AToken} from "../src/interfaces/IAaveV3.sol";
import {MockOracle} from "../src/mocks/MockOracle.sol";

/// @dev Chainlink L2 sequencer uptime feed stand-in (answer 0 = up, 1 = down).
contract MockSequencerFeed {
    int256 public answer;
    uint256 public startedAt;

    function set(int256 answer_, uint256 startedAt_) external {
        (answer, startedAt) = (answer_, startedAt_);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, startedAt, startedAt, 1);
    }

    function decimals() external pure returns (uint8) {
        return 0;
    }
}

contract SwapVMTest is Fixture, CoreInvariants {
    YieldSwapVMRouter internal svm;
    YieldSwapVMStrategies internal builder;
    SwapVMResolver internal sres;
    AquaYieldApp internal yapp;
    WalletResolver internal wres;
    Aave4626 internal aaveUsdc;
    Aave4626 internal aaveWeth;
    address internal lp = makeAddr("lp");
    address internal user = makeAddr("user");

    AquaYieldApp.Strategy internal ys; // the wallet's AquaYieldApp strategy (JIT + rebalance + MM)
    bytes32 internal yh;
    YieldSwapVMStrategies.Params internal sp; // the wallet's SwapVM strategy over the same shares
    ISwapVM.Order internal order;
    bytes32 internal oh;

    uint256 internal constant LP_USDC = 70_000e6;
    uint256 internal constant LP_WETH = 10e18; // $30k at $3,000 → exactly on the 70/30 target

    function setUp() public override {
        super.setUp();
        yapp = new AquaYieldApp(IAqua(address(aqua)));
        wres = new WalletResolver(yapp, owner, operator);
        svm = new YieldSwapVMRouter(address(aqua), address(weth), owner);
        builder = new YieldSwapVMStrategies();
        sres = new SwapVMResolver(ISwapVM(address(svm)), owner, operator);
        aaveUsdc =
            new Aave4626(IAaveV3Pool(address(aavePool)), IAaveV3AToken(address(aUsdc)), "Aave USDC 4626", "a4USDC");
        aaveWeth = new Aave4626(
            IAaveV3Pool(address(aaveWethPool)), IAaveV3AToken(address(aaveWethPool.aToken())), "Aave WETH 4626", "a4WETH"
        );

        vm.startPrank(owner);
        sres.setTarget(address(book), true);
        sres.approveToken(usdc, address(book), type(uint256).max);
        sres.approveToken(weth, address(book), type(uint256).max);
        vm.stopPrank();

        _setupLp();
    }

    // ─── Setup ───────────────────────────────────────────────────────────────

    function _params() internal view returns (YieldSwapVMStrategies.Params memory) {
        return YieldSwapVMStrategies.Params({
            maker: lp,
            stableShare: address(morpho),
            volatileShare: address(aaveWeth),
            oracle: address(oracle),
            maxPriceAge: 1 hours,
            spreadBps: 20,
            skewBps: 10,
            maxTradeBps: 2_000,
            targetStableBps: 7_000,
            bandBps: 500,
            sequencerFeed: address(0),
            sequencerGrace: 0,
            salt: bytes32(0)
        });
    }

    /// @dev The LP supplies to Morpho (USDC) and Aave (WETH), keeps the shares, approves Aqua once, and ships TWO
    ///      strategies over the same shares: AquaYieldApp (JIT / rebalance / MM) and a SwapVM YieldOracleSwap order.
    function _setupLp() internal {
        usdc.mint(lp, LP_USDC);
        weth.mint(lp, LP_WETH);
        vm.startPrank(lp);
        usdc.approve(address(morpho), LP_USDC);
        uint256 mShares = morpho.deposit(LP_USDC, lp);
        weth.approve(address(aaveWeth), LP_WETH);
        uint256 wShares = aaveWeth.deposit(LP_WETH, lp);
        morpho.approve(address(aqua), type(uint256).max);
        aaveWeth.approve(address(aqua), type(uint256).max);

        address[] memory stable = new address[](1);
        stable[0] = address(morpho);
        address[] memory vol = new address[](1);
        vol[0] = address(aaveWeth);
        ys = AquaYieldApp.Strategy({
            maker: lp,
            stable: address(usdc),
            volatileAsset: address(weth),
            stableMarkets: stable,
            volatileMarkets: vol,
            keeper: keeper,
            taker: address(wres),
            flashFeeBps: 5,
            mm: AquaYieldApp.MarketMaking(address(oracle), 1 hours, 20, 10, 2_000, 7_000, 500),
            salt: bytes32(0)
        });
        address[] memory tokens = new address[](2);
        (tokens[0], tokens[1]) = (address(morpho), address(aaveWeth));
        uint256[] memory amounts = new uint256[](2);
        (amounts[0], amounts[1]) = (mShares, wShares);
        yh = aqua.ship(address(yapp), abi.encode(ys), tokens, amounts);

        sp = _params();
        order = builder.buildOrder(sp);
        (bytes memory strat, bytes32 hash) = builder.strategy(sp);
        oh = aqua.ship(address(svm), strat, tokens, amounts);
        vm.stopPrank();
        assertEq(oh, hash, "builder hash");
        assertEq(oh, svm.hash(order), "SwapVM order hash = Aqua strategy hash");
    }

    function _takerData(bool exactIn, bool aToB, uint256 threshold) internal view returns (bytes memory) {
        return TakerTraitsLib.build(
            TakerTraitsLib.Args({
                taker: address(this),
                isExactIn: exactIn,
                shouldUnwrapWeth: false,
                isStrictThresholdAmount: false,
                isFirstTransferFromTaker: false,
                useTransferFromAndAquaPush: true,
                isAToB: aToB,
                threshold: threshold == 0 ? bytes("") : abi.encodePacked(threshold),
                to: address(0),
                deadline: 0,
                hasPreTransferInCallback: false,
                hasPreTransferOutCallback: false,
                preTransferInHookData: "",
                postTransferInHookData: "",
                preTransferOutHookData: "",
                postTransferOutHookData: "",
                preTransferInCallbackData: "",
                preTransferOutCallbackData: "",
                instructionsArgs: "",
                signature: ""
            })
        );
    }

    /// @dev isAToB for a trade paying `tokenIn`.
    function _aToB(address tokenIn) internal view returns (bool) {
        return tokenIn < (tokenIn == address(morpho) ? address(aaveWeth) : address(morpho));
    }

    function _quote(address tokenIn, bool exactIn, uint256 amount) internal returns (uint256 i, uint256 o) {
        (i, o,) = svm.quote(order, amount, _takerData(exactIn, _aToB(tokenIn), 0));
    }

    function _usd(address share, uint256 shares) internal view returns (uint256) {
        uint256 assets = IERC4626(share).convertToAssets(shares);
        return share == address(morpho) ? assets : assets * 3_000e6 / 1e18;
    }

    function _walletValue() internal view returns (uint256) {
        return _usd(address(morpho), morpho.balanceOf(lp)) + _usd(address(aaveWeth), aaveWeth.balanceOf(lp));
    }

    // ─── Pricing ─────────────────────────────────────────────────────────────

    function test_order_isAquaBacked_andShippedNextToAquaYieldApp() public view {
        (uint256 bSvm,) = aqua.rawBalances(lp, address(svm), oh, address(morpho));
        (uint256 bApp,) = aqua.rawBalances(lp, address(yapp), yh, address(morpho));
        assertEq(bSvm, morpho.balanceOf(lp), "SwapVM budget = wallet shares");
        assertEq(bApp, morpho.balanceOf(lp), "AquaYieldApp budget = same wallet shares");
        assertEq(morpho.balanceOf(address(svm)), 0);
        assertEq(morpho.balanceOf(address(aqua)), 0, "Aqua holds nothing: shares stay in the wallet");
    }

    function test_quote_exactIn_buyWeth_atAsk() public {
        // On target (70/30) → no skew: ask = 3000 · 1.002.
        (, uint256 out) = _quote(address(morpho), true, 3_006e6);
        uint256 wethOut = aaveWeth.convertToAssets(out);
        assertApproxEqAbs(wethOut, 1e18, 1e12, "3006 USDC buys ~1 WETH at 3006");
        assertLe(_usd(address(aaveWeth), out), 3_006e6, "never above oracle value");
    }

    function test_quote_exactIn_sellWeth_atBid() public {
        (, uint256 out) = _quote(address(aaveWeth), true, aaveWeth.convertToShares(1e18));
        assertApproxEqAbs(morpho.convertToAssets(out), 2_994e6, 2, "1 WETH sells for 3000 x 0.998");
    }

    function test_quote_exactOut_roundsUp() public {
        uint256 sharesOut = aaveWeth.convertToShares(1e18);
        (uint256 inShares,) = _quote(address(morpho), false, sharesOut);
        assertGe(morpho.convertToAssets(inShares), 3_006e6, "pays at least the ask");
        assertLe(morpho.convertToAssets(inShares), 3_006e6 + 2);
    }

    function test_quote_skew_whenStableHeavy() public {
        oracle.setAnswer(2_500e8); // ETH down → 70k / (70k + 25k) = 73.7% stable, above the 70% target
        (, uint256 out) = _quote(address(morpho), true, 250.5e6);
        // stable-heavy: skew < 0 → the ask rises above 2500 · 1.002, so fewer WETH per USDC
        assertLt(aaveWeth.convertToAssets(out), 0.1e18);
        (, uint256 out2) = _quote(address(aaveWeth), true, aaveWeth.convertToShares(1e18));
        // …and the bid for WETH (which the maker wants) improves above 2500 · 0.998, but never above the oracle
        assertGt(morpho.convertToAssets(out2), 2_495e6);
        assertLe(morpho.convertToAssets(out2), 2_500e6, "skew <= spread");
    }

    function test_yieldAccrual_fewerSharesForSameAssets() public {
        uint256 sharesOut = morpho.previewWithdraw(3_000e6);
        morpho.accrue(500); // +5% share price
        uint256 sharesOutAfter = morpho.previewWithdraw(3_000e6);
        assertLt(sharesOutAfter, sharesOut, "each share is worth more");
        (uint256 inShares,) = _quote(address(aaveWeth), false, sharesOutAfter);
        // Priced in assets, not shares: 3000 USDC costs between 3000/3000 and 3000/2994 WETH (bid, plus at most
        // the skew — the wallet is now stable-heavy after the Morpho yield, so it bids a little more for WETH).
        uint256 wethIn = aaveWeth.convertToAssets(inShares);
        assertLe(wethIn, 3_000e18 / uint256(2_994) + 1e12);
        assertGe(wethIn, 1e18);
    }

    // ─── Guards ──────────────────────────────────────────────────────────────

    function test_revert_stalePrice() public {
        vm.warp(block.timestamp + 2 hours);
        bytes memory td = _takerData(true, _aToB(address(morpho)), 0);
        vm.expectPartialRevert(YieldInstructions.YieldOracleSwapStalePrice.selector);
        svm.quote(order, 1_000e6, td);
    }

    function test_revert_tradeTooLarge() public {
        bytes memory td = _takerData(true, _aToB(address(morpho)), 0);
        vm.expectPartialRevert(YieldInstructions.YieldOracleSwapTradeTooLarge.selector);
        svm.quote(order, 20_001e6, td); // > 20% of $100k
    }

    function test_revert_outOfBand() public {
        // Buying WETH pushes the wallet stable-heavy; 5.5k of 100k moves 70% → 74.5%... first get near the edge.
        oracle.setAnswer(2_800e8); // 70k / 98k = 71.4% stable
        bytes memory td = _takerData(true, _aToB(address(morpho)), 0);
        vm.expectPartialRevert(YieldInstructions.YieldOracleSwapOutOfBand.selector);
        svm.quote(order, 19_000e6, td); // → ~83% stable, band is 70 ± 5
    }

    function test_sequencerGuard() public {
        MockSequencerFeed feed = new MockSequencerFeed();
        YieldSwapVMStrategies.Params memory p = _params();
        (p.sequencerFeed, p.sequencerGrace, p.salt) = (address(feed), 1 hours, bytes32(uint256(1)));
        ISwapVM.Order memory o = builder.buildOrder(p);
        (bytes memory strat,) = builder.strategy(p);
        address[] memory tokens = new address[](2);
        (tokens[0], tokens[1]) = (address(morpho), address(aaveWeth));
        uint256[] memory amounts = new uint256[](2);
        (amounts[0], amounts[1]) = (morpho.balanceOf(lp), aaveWeth.balanceOf(lp));
        vm.prank(lp);
        aqua.ship(address(svm), strat, tokens, amounts);
        bytes memory td = _takerData(true, _aToB(address(morpho)), 0);

        vm.warp(10 days);
        oracle.setAnswer(3_000e8);
        feed.set(1, block.timestamp - 3 hours); // down
        vm.expectRevert(YieldInstructions.SequencerDown.selector);
        svm.quote(o, 1_000e6, td);

        feed.set(0, block.timestamp - 10 minutes); // back up, inside the grace period
        vm.expectPartialRevert(YieldInstructions.SequencerGracePeriod.selector);
        svm.quote(o, 1_000e6, td);

        feed.set(0, block.timestamp - 2 hours);
        (, uint256 out,) = svm.quote(o, 1_000e6, td);
        assertGt(out, 0);
    }

    // ─── Fusion-style fill through the resolver ─────────────────────────────

    /// @dev A user sells 1 WETH for 2,990 USDC. The resolver buys 2,990 USDC worth of the wallet's Morpho shares via
    ///      SwapVM, redeems them, fills the order, and pays the wallet in freshly minted Aave-WETH shares.
    function test_resolver_fillsOrderFromWalletShares() public {
        weth.mint(user, 1e18);
        vm.startPrank(user);
        weth.approve(address(book), 1e18);
        uint256 id = book.createOrder(address(weth), address(usdc), 1e18, 2_990e6);
        vm.stopPrank();

        uint256 value0 = _walletValue();
        uint256 m0 = morpho.balanceOf(lp);
        uint256 w0 = aaveWeth.balanceOf(lp);
        (uint256 appBudget0,) = aqua.rawBalances(lp, address(yapp), yh, address(morpho));

        uint256 sharesOut = morpho.previewWithdraw(2_990e6);
        SwapVMResolver.Call[] memory calls = new SwapVMResolver.Call[](1);
        calls[0] = SwapVMResolver.Call(address(book), 0, abi.encodeCall(book.fill, (id)));
        vm.prank(operator);
        uint256 profit = sres.executeSwap(order, address(morpho), sharesOut, type(uint256).max, calls, 1);

        assertEq(usdc.balanceOf(user), 2_990e6, "user filled");
        assertEq(morpho.balanceOf(lp), m0 - sharesOut, "wallet sold Morpho shares");
        assertGt(aaveWeth.balanceOf(lp), w0, "wallet got paid in Aave-WETH shares");
        assertGe(_walletValue(), value0, "wallet no poorer at the oracle price (earns the spread)");
        assertApproxEqRel(profit, 1e18 - uint256(2_990e18) / 2_994, 1e15, "resolver keeps the auction surplus");
        // SwapVM budget moved; AquaYieldApp's view of the same wallet is untouched.
        (uint256 svmBudget,) = aqua.rawBalances(lp, address(svm), oh, address(morpho));
        assertEq(svmBudget, m0 - sharesOut);
        (uint256 appBudget,) = aqua.rawBalances(lp, address(yapp), yh, address(morpho));
        assertEq(appBudget, appBudget0);
        for (uint256 i; i < 2; ++i) {
            address t = [address(morpho), address(aaveWeth)][i];
            assertEq(IERC20(t).balanceOf(address(svm)), 0, "router keeps nothing");
            assertEq(IERC20(t).balanceOf(address(sres)), 0, "resolver keeps no shares");
        }
    }

    /// @dev The same wallet shares keep serving AquaYieldApp after a SwapVM fill: a second user order is filled by
    ///      WalletResolver through AquaYieldApp from the very same Morpho position.
    function test_sharedLiquidity_bothAppsUseTheSameShares() public {
        test_resolver_fillsOrderFromWalletShares();
        vm.startPrank(owner);
        wres.setTarget(address(book), true);
        wres.approveToken(usdc, address(book), type(uint256).max);
        wres.approveToken(weth, address(book), type(uint256).max);
        vm.stopPrank();
        address user2 = makeAddr("user2");
        weth.mint(user2, 1e18);
        vm.startPrank(user2);
        weth.approve(address(book), 1e18);
        uint256 id = book.createOrder(address(weth), address(usdc), 1e18, 2_990e6);
        vm.stopPrank();

        uint256 m0 = morpho.balanceOf(lp);
        uint256 value0 = _walletValue();
        WalletResolver.Call[] memory calls = new WalletResolver.Call[](1);
        calls[0] = WalletResolver.Call(address(book), 0, abi.encodeCall(book.fill, (id)));
        vm.prank(operator);
        wres.executeSwap(
            ys,
            AquaYieldApp.SwapParams({
                tokenOut: address(usdc),
                amountOut: 2_990e6,
                maxAmountIn: type(uint256).max,
                outMarket: address(morpho),
                inMarket: address(aaveWeth),
                to: address(wres)
            }),
            calls,
            1
        );
        assertEq(usdc.balanceOf(user2), 2_990e6, "second order filled by the other app");
        assertLt(morpho.balanceOf(lp), m0, "from the same Morpho shares");
        assertGe(_walletValue(), value0, "and the wallet earned the spread again");
    }

    function test_resolver_rejectsLoss() public {
        weth.mint(user, 1e18);
        vm.startPrank(user);
        weth.approve(address(book), 1e18);
        uint256 id = book.createOrder(address(weth), address(usdc), 1e18, 3_100e6); // above the bid
        vm.stopPrank();
        SwapVMResolver.Call[] memory calls = new SwapVMResolver.Call[](1);
        calls[0] = SwapVMResolver.Call(address(book), 0, abi.encodeCall(book.fill, (id)));
        uint256 sharesOut = morpho.previewWithdraw(3_100e6);
        vm.prank(operator);
        vm.expectRevert(); // cannot mint the WETH shares it owes: 1 WETH < 3100/2994
        sres.executeSwap(order, address(morpho), sharesOut, type(uint256).max, calls, 0);
    }

    function test_resolver_callbackOnlyFromRouterDuringExecute() public {
        vm.expectRevert(SwapVMResolver.OnlyRouter.selector);
        sres.preTransferInCallback(lp, address(sres), address(morpho), address(aaveWeth), 1, 1, oh, "");
        vm.prank(address(svm));
        vm.expectRevert(SwapVMResolver.NotExecuting.selector);
        sres.preTransferInCallback(lp, address(sres), address(morpho), address(aaveWeth), 1, 1, oh, "");
    }

    function test_onlyOperator() public {
        vm.expectRevert(SwapVMResolver.OnlyOperator.selector);
        sres.executeSwap(order, address(morpho), 1, 1, new SwapVMResolver.Call[](0), 0);
    }

    // ─── Fuzz: the maker never loses at the oracle price ────────────────────

    function testFuzz_exactIn_neverAboveOracleValue(uint256 usdIn, bool buyWeth) public {
        usdIn = bound(usdIn, 1e6, 19_000e6);
        address tokenIn = buyWeth ? address(morpho) : address(aaveWeth);
        address tokenOut = buyWeth ? address(aaveWeth) : address(morpho);
        uint256 amountIn =
            buyWeth ? morpho.convertToShares(usdIn) : aaveWeth.convertToShares(usdIn * 1e18 / 3_000e6);
        bytes memory td = _takerData(true, _aToB(tokenIn), 0);
        try svm.quote(order, amountIn, td) returns (uint256, uint256 out, bytes32) {
            assertLe(_usd(tokenOut, out), _usd(tokenIn, amountIn), "maker gives no more value than it gets");
        } catch {
            // refused (band / size) — also fine for the maker
        }
    }

    // ─── 1inch SwapVM core invariants on our program ─────────────────────────

    function _executeSwap(
        SwapVM swapVM,
        ISwapVM.Order memory o,
        address tokenIn,
        address,
        uint256 amount,
        bytes memory takerData
    ) internal override returns (uint256 amountIn, uint256 amountOut) {
        // Mint enough input shares for any quote of this size, then swap as the taker (this contract).
        IERC4626 share = IERC4626(tokenIn);
        IERC20 asset = IERC20(share.asset());
        uint256 assets = tokenIn == address(morpho) ? 1_000_000e6 : 500e18;
        (tokenIn == address(morpho) ? usdc : weth).mint(address(this), assets);
        asset.approve(address(share), assets);
        share.deposit(assets, address(this));
        IERC20(tokenIn).approve(address(swapVM), type(uint256).max);
        (amountIn, amountOut,) = swapVM.swap(o, amount, takerData);
    }

    function test_coreInvariants_buyWeth() public {
        _coreInvariants(address(morpho), address(aaveWeth), 300e6);
    }

    function test_coreInvariants_sellWeth() public {
        _coreInvariants(address(aaveWeth), address(morpho), aaveWeth.convertToShares(0.1e18));
    }

    function _coreInvariants(address tokenIn, address tokenOut, uint256 unit) internal {
        InvariantConfig memory c = _getDefaultConfig();
        uint256[] memory amounts = new uint256[](3);
        (amounts[0], amounts[1], amounts[2]) = (unit, unit * 3, unit * 5);
        c.testAmounts = amounts;
        uint256[] memory outs = new uint256[](3);
        // Largest trade in the suite is 2 × 5 units ≈ $3k: stays inside the ±5pp band around 70/30.
        uint256 outUnit = tokenOut == address(aaveWeth) ? aaveWeth.convertToShares(0.1e18) : 300e6;
        (outs[0], outs[1], outs[2]) = (outUnit, outUnit * 3, outUnit * 5);
        c.testAmountsExactOut = outs;
        c.symmetryTolerance = 1e12; // share↔asset conversions on both legs (≤ 1e-6 of an 18-dp token)
        c.monotonicityToleranceBps = 1; // oracle price is flat in size; only rounding moves it
        c.additivityTolerance = 1e12;
        c.exactInTakerData = _takerData(true, _aToB(tokenIn), 0);
        c.exactOutTakerData = _takerData(false, _aToB(tokenIn), 0);
        assertAllInvariantsWithConfig(SwapVM(payable(address(svm))), order, tokenIn, tokenOut, c);
    }
}
