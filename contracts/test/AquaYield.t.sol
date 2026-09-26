// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IAqua} from "@1inch/aqua/interfaces/IAqua.sol";

import {Fixture} from "./utils/Fixture.sol";
import {Aave4626} from "../src/Aave4626.sol";
import {AquaYieldApp} from "../src/AquaYieldApp.sol";
import {WalletResolver} from "../src/WalletResolver.sol";
import {IAquaYieldCallback} from "../src/interfaces/IAquaYield.sol";
import {IAaveV3Pool, IAaveV3AToken} from "../src/interfaces/IAaveV3.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockSwapRouter} from "../src/mocks/MockSwapRouter.sol";
import {MockOrderBook} from "../src/mocks/MockOrderBook.sol";

/// @dev ERC-4626 whose shares are only ever worth 99% of what went in — a market that would lose the maker's money.
contract LossyVault is ERC4626 {
    constructor(IERC20 asset_) ERC4626(asset_) ERC20("Lossy", "LOSS") {}

    function totalAssets() public view override returns (uint256) {
        return super.totalAssets() * 99 / 100;
    }
}

/// @dev Taker that under-repays.
contract StingyTaker is IAquaYieldCallback {
    AquaYieldApp internal immutable app;

    constructor(AquaYieldApp app_) {
        app = app_;
    }

    function borrow(AquaYieldApp.Strategy calldata s, address market, uint256 assets) external {
        app.flash(s, market, assets, address(this), "");
    }

    function onAquaYieldFlash(address token, uint256 amount, uint256 fee, address, bytes32, bytes calldata) external {
        IERC20(token).transfer(msg.sender, amount + fee - 1);
    }

    function onAquaYieldSwap(address, address, uint256, uint256, address, bytes32, bytes calldata) external {}
}

contract AquaYieldTest is Fixture {
    AquaYieldApp internal yapp;
    WalletResolver internal wres;
    Aave4626 internal aaveUsdc;
    Aave4626 internal aaveWeth;
    address internal lp = makeAddr("lp");
    AquaYieldApp.Strategy internal s;
    bytes32 internal h;

    uint256 internal constant LP_USDC = 70_000e6;
    uint256 internal constant LP_WETH = 10e18; // $30k at $3,000

    function setUp() public override {
        super.setUp();
        yapp = new AquaYieldApp(IAqua(address(aqua)));
        wres = new WalletResolver(yapp, owner, operator);
        aaveUsdc =
            new Aave4626(IAaveV3Pool(address(aavePool)), IAaveV3AToken(address(aUsdc)), "Aave USDC 4626", "a4USDC");
        aaveWeth = new Aave4626(
            IAaveV3Pool(address(aaveWethPool)),
            IAaveV3AToken(address(aaveWethPool.aToken())),
            "Aave WETH 4626",
            "a4WETH"
        );

        vm.startPrank(owner);
        wres.setTarget(address(router), true);
        wres.setTarget(address(book), true);
        wres.approveToken(usdc, address(router), type(uint256).max);
        wres.approveToken(weth, address(router), type(uint256).max);
        wres.approveToken(usdc, address(book), type(uint256).max);
        wres.approveToken(weth, address(book), type(uint256).max);
        vm.stopPrank();

        s = _strategy(address(wres), 5, 20);
        h = _setupLp(lp, s, LP_USDC, LP_WETH);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _strategy(address taker, uint16 flashFeeBps, uint16 spreadBps)
        internal
        view
        returns (AquaYieldApp.Strategy memory st)
    {
        address[] memory stable = new address[](3);
        (stable[0], stable[1], stable[2]) = (address(morpho), address(fluid), address(aaveUsdc));
        address[] memory vol = new address[](1);
        vol[0] = address(aaveWeth);
        st = AquaYieldApp.Strategy({
            maker: lp,
            stable: address(usdc),
            volatileAsset: address(weth),
            stableMarkets: stable,
            volatileMarkets: vol,
            keeper: keeper,
            taker: taker,
            flashFeeBps: flashFeeBps,
            mm: AquaYieldApp.MarketMaking({
                oracle: address(oracle),
                maxPriceAge: 1 hours,
                spreadBps: spreadBps,
                skewBps: spreadBps / 2,
                maxTradeBps: 2_000,
                targetStableBps: 7_000,
                bandBps: 500
            }),
            salt: bytes32(0)
        });
    }

    /// @dev The LP supplies to Morpho (USDC) and Aave (WETH), keeps the shares, approves Aqua and ships.
    function _setupLp(address who, AquaYieldApp.Strategy memory st, uint256 usdcAmt, uint256 wethAmt)
        internal
        returns (bytes32)
    {
        usdc.mint(who, usdcAmt);
        weth.mint(who, wethAmt);
        vm.startPrank(who);
        usdc.approve(address(morpho), usdcAmt);
        uint256 mShares = morpho.deposit(usdcAmt, who);
        weth.approve(address(aaveWeth), wethAmt);
        uint256 wShares = aaveWeth.deposit(wethAmt, who);

        address[] memory tokens = new address[](4);
        uint256[] memory amounts = new uint256[](4);
        (tokens[0], tokens[1], tokens[2], tokens[3]) =
        (address(morpho), address(fluid), address(aaveUsdc), address(aaveWeth));
        (amounts[0], amounts[3]) = (mShares, wShares);
        for (uint256 i; i < 4; ++i) {
            IERC20(tokens[i]).approve(address(aqua), type(uint256).max);
        }
        bytes32 hash = aqua.ship(address(yapp), abi.encode(st), tokens, amounts);
        vm.stopPrank();
        return hash;
    }

    function _budget(address market) internal view returns (uint256 b) {
        (b,) = aqua.rawBalances(lp, address(yapp), h, market);
    }

    /// @dev Value of the LP's wallet positions in USDC at the oracle price.
    function _walletValue() internal view returns (uint256) {
        uint256 stableAssets = morpho.convertToAssets(morpho.balanceOf(lp)) + fluid.convertToAssets(fluid.balanceOf(lp))
            + aaveUsdc.convertToAssets(aaveUsdc.balanceOf(lp));
        uint256 wethAssets = aaveWeth.convertToAssets(aaveWeth.balanceOf(lp));
        return stableAssets + wethAssets * 3_000e6 / 1e18;
    }

    function _appHoldsNothing() internal view {
        for (uint256 i; i < 4; ++i) {
            address t = [address(morpho), address(fluid), address(aaveUsdc), address(aaveWeth)][i];
            assertEq(IERC20(t).balanceOf(address(yapp)), 0, "app kept shares");
        }
        assertEq(usdc.balanceOf(address(yapp)), 0, "app kept USDC");
        assertEq(weth.balanceOf(address(yapp)), 0, "app kept WETH");
    }

    // ─── Setup / custody ─────────────────────────────────────────────────────

    function test_ship_tokensStayInWallet() public view {
        assertEq(yapp.strategyHash(s), h);
        assertEq(morpho.balanceOf(lp), _budget(address(morpho)));
        assertGt(aaveWeth.balanceOf(lp), 0);
        (uint256 st, uint256 vo) = yapp.holdings(s);
        assertApproxEqAbs(st, LP_USDC, 1);
        assertApproxEqAbs(vo, LP_WETH, 1);
        _appHoldsNothing();
    }

    function test_yieldAccruesInWallet() public {
        uint256 before = _walletValue();
        morpho.accrue(100); // +1%
        aaveWethPool.accrue(100);
        assertApproxEqAbs(_walletValue(), before + 700e6 + 300e6, 5);
        (uint256 st,) = yapp.holdings(s);
        assertApproxEqAbs(st, LP_USDC * 101 / 100, 5); // committed value grows with the share price
    }

    // ─── Rebalance ───────────────────────────────────────────────────────────

    function test_rebalance_movesBetweenMarketsInWallet() public {
        uint256 shares = morpho.balanceOf(lp);
        uint256 before = _walletValue();
        vm.prank(keeper);
        uint256 newShares = yapp.rebalance(s, address(morpho), address(aaveUsdc), shares);

        assertEq(morpho.balanceOf(lp), 0);
        assertEq(aaveUsdc.balanceOf(lp), newShares);
        assertApproxEqAbs(_walletValue(), before, 10);
        assertEq(_budget(address(morpho)), 0);
        assertEq(_budget(address(aaveUsdc)), newShares);
        _appHoldsNothing();

        // …and back, partially.
        vm.prank(keeper);
        yapp.rebalance(s, address(aaveUsdc), address(fluid), newShares / 2);
        assertApproxEqAbs(_walletValue(), before, 20);
        _appHoldsNothing();
    }

    function test_rebalance_onlyKeeper() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AquaYieldApp.Unauthorized.selector, alice));
        yapp.rebalance(s, address(morpho), address(aaveUsdc), 1e6);

        AquaYieldApp.Strategy memory noKeeper = s;
        noKeeper.keeper = address(0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(AquaYieldApp.Unauthorized.selector, keeper));
        yapp.rebalance(noKeeper, address(morpho), address(aaveUsdc), 1e6);
    }

    function test_rebalance_onlyListedSameAssetMarkets() public {
        vm.startPrank(keeper);
        vm.expectRevert(abi.encodeWithSelector(AquaYieldApp.InvalidMarket.selector, address(aaveWeth)));
        yapp.rebalance(s, address(morpho), address(aaveWeth), 1e6); // USDC → WETH market
        LossyVault rogue = new LossyVault(usdc);
        vm.expectRevert(abi.encodeWithSelector(AquaYieldApp.InvalidMarket.selector, address(rogue)));
        yapp.rebalance(s, address(morpho), address(rogue), 1e6); // not listed
        vm.stopPrank();
    }

    function test_rebalance_refusesValueLoss() public {
        // The maker listed a market that skims deposits: the app refuses to move funds into it.
        LossyVault lossy = new LossyVault(usdc);
        address[] memory stable = new address[](2);
        (stable[0], stable[1]) = (address(morpho), address(lossy));
        AquaYieldApp.Strategy memory st = s;
        st.stableMarkets = stable;
        st.salt = bytes32("lossy");
        address[] memory tokens = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        (tokens[0], tokens[1]) = (address(morpho), address(lossy));
        amounts[0] = morpho.balanceOf(lp);
        vm.startPrank(lp);
        lossy.approve(address(aqua), type(uint256).max);
        aqua.ship(address(yapp), abi.encode(st), tokens, amounts);
        vm.stopPrank();

        vm.prank(keeper);
        vm.expectPartialRevert(AquaYieldApp.ValueLost.selector);
        yapp.rebalance(st, address(morpho), address(lossy), 1_000e6);
    }

    function test_rebalance_failsIfUserMovedShares() public {
        uint256 all = morpho.balanceOf(lp);
        vm.prank(lp);
        morpho.transfer(bob, all);
        vm.prank(keeper);
        vm.expectRevert(); // Aqua pull: transferFrom fails, nothing moves
        yapp.rebalance(s, address(morpho), address(aaveUsdc), 1_000e6);
    }

    function test_dock_revokesEverything() public {
        address[] memory tokens = new address[](4);
        (tokens[0], tokens[1], tokens[2], tokens[3]) =
        (address(morpho), address(fluid), address(aaveUsdc), address(aaveWeth));
        vm.prank(lp);
        aqua.dock(address(yapp), h, tokens);
        vm.prank(keeper);
        vm.expectRevert();
        yapp.rebalance(s, address(morpho), address(aaveUsdc), 1e6);
        (uint256 st,) = yapp.holdings(s);
        assertEq(st, 0);
    }

    // ─── JIT ─────────────────────────────────────────────────────────────────

    function _arb(uint256 amount) internal returns (WalletResolver.Call[] memory calls) {
        router.setPrice(address(usdc), address(weth), uint256(1e30) / 3000);
        router.setPrice(address(weth), address(usdc), 3000e6 * 10_030 / 10_000);
        uint256 wethOut = router.quote(address(usdc), address(weth), amount);
        calls = new WalletResolver.Call[](2);
        calls[0] = WalletResolver.Call(
            address(router),
            0,
            abi.encodeCall(MockSwapRouter.swap, (address(usdc), address(weth), amount, 0, address(wres)))
        );
        calls[1] = WalletResolver.Call(
            address(router),
            0,
            abi.encodeCall(MockSwapRouter.swap, (address(weth), address(usdc), wethOut, 0, address(wres)))
        );
    }

    function test_flash_feeLandsInWallet() public {
        uint256 before = _walletValue();
        WalletResolver.Call[] memory calls = _arb(10_000e6);
        vm.prank(operator);
        uint256 profit = wres.executeFlash(s, address(morpho), 10_000e6, calls, 1);

        uint256 fee = 5e6; // 5 bps of 10k
        assertApproxEqAbs(_walletValue(), before + fee, 5);
        assertApproxEqAbs(profit, 30e6 - fee, 1);
        _appHoldsNothing();
    }

    function test_flash_disabledOrUnauthorizedOrShort() public {
        AquaYieldApp.Strategy memory noJit = s;
        noJit.flashFeeBps = 0;
        vm.expectRevert(AquaYieldApp.FlashDisabled.selector);
        yapp.flash(noJit, address(morpho), 1e6, address(this), "");

        vm.expectRevert(abi.encodeWithSelector(AquaYieldApp.Unauthorized.selector, address(this)));
        yapp.flash(s, address(morpho), 1e6, address(this), "");

        // Open strategy (any taker), repaying 1 wei short → revert, nothing moves.
        AquaYieldApp.Strategy memory open = _strategy(address(0), 5, 20);
        open.salt = bytes32("open");
        address[] memory tokens = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        tokens[0] = address(morpho);
        amounts[0] = morpho.balanceOf(lp);
        address[] memory onlyMorpho = new address[](1);
        onlyMorpho[0] = address(morpho);
        open.stableMarkets = onlyMorpho;
        open.volatileMarkets = new address[](0);
        vm.prank(lp);
        aqua.ship(address(yapp), abi.encode(open), tokens, amounts);

        StingyTaker stingy = new StingyTaker(yapp);
        usdc.mint(address(stingy), 10e6);
        uint256 before = _walletValue();
        vm.expectPartialRevert(AquaYieldApp.NotRepaid.selector);
        stingy.borrow(open, address(morpho), 1_000e6);
        assertEq(_walletValue(), before);
    }

    // ─── Market making ───────────────────────────────────────────────────────

    function test_swap_fillsIntentFromWalletInventory() public {
        // User sells 3,100 USDC for 1 WETH; the resolver buys 1 WETH from the LP's Aave-WETH position at ask.
        uint256 id = _postOrder(bob, usdc, weth, 3_100e6, 1e18);
        WalletResolver.Call[] memory calls = new WalletResolver.Call[](1);
        calls[0] = WalletResolver.Call(address(book), 0, abi.encodeCall(MockOrderBook.fill, (id)));
        AquaYieldApp.SwapParams memory p = AquaYieldApp.SwapParams({
            tokenOut: address(weth),
            amountOut: 1e18,
            maxAmountIn: type(uint256).max,
            outMarket: address(aaveWeth),
            inMarket: address(aaveUsdc),
            to: address(wres)
        });
        uint256 before = _walletValue();
        (uint256 bid, uint256 ask,) = yapp.prices(s);
        assertLt(bid, 3_000e6 * 1e18);
        assertGe(ask, 3_000e6 * 1e18);

        vm.prank(operator);
        uint256 profit = wres.executeSwap(s, p, calls, 1);

        assertEq(weth.balanceOf(bob), 1e18);
        assertGt(_walletValue(), before); // LP sold ETH above the oracle
        assertGt(aaveUsdc.balanceOf(lp), 0); // payment deposited into the LP's Aave USDC position
        assertApproxEqAbs(aaveWeth.convertToAssets(aaveWeth.balanceOf(lp)), 9e18, 1e3);
        assertGt(profit, 0);
        _appHoldsNothing();
    }

    function test_swap_guards() public {
        AquaYieldApp.SwapParams memory p = AquaYieldApp.SwapParams({
            tokenOut: address(weth),
            amountOut: 8e18, // $24k > 20% of $100k
            maxAmountIn: type(uint256).max,
            outMarket: address(aaveWeth),
            inMarket: address(aaveUsdc),
            to: address(wres)
        });
        vm.startPrank(operator);
        vm.expectPartialRevert(AquaYieldApp.TradeTooLarge.selector);
        wres.executeSwap(s, p, new WalletResolver.Call[](0), 0);

        p.amountOut = 2e18; // stable 76% → out of band
        vm.expectPartialRevert(AquaYieldApp.OutOfBand.selector);
        wres.executeSwap(s, p, new WalletResolver.Call[](0), 0);

        p.amountOut = 1e18;
        p.inMarket = address(aaveWeth); // wrong side
        vm.expectRevert(abi.encodeWithSelector(AquaYieldApp.InvalidMarket.selector, address(aaveWeth)));
        wres.executeSwap(s, p, new WalletResolver.Call[](0), 0);

        AquaYieldApp.Strategy memory noMm = s;
        noMm.mm.spreadBps = 0;
        vm.expectRevert(AquaYieldApp.MarketMakingDisabled.selector);
        wres.executeSwap(noMm, p, new WalletResolver.Call[](0), 0);
        vm.stopPrank();

        skip(1 hours + 1);
        vm.expectPartialRevert(AquaYieldApp.StalePrice.selector);
        yapp.prices(s);
    }

    function test_resolver_accessControl() public {
        vm.expectRevert(WalletResolver.OnlyOperator.selector);
        wres.executeFlash(s, address(morpho), 1e6, new WalletResolver.Call[](0), 0);
        vm.expectRevert(WalletResolver.OnlyApp.selector);
        wres.onAquaYieldFlash(address(usdc), 1, 0, lp, h, "");
        vm.prank(address(yapp));
        vm.expectRevert(WalletResolver.NotExecuting.selector);
        wres.onAquaYieldFlash(address(usdc), 1, 0, lp, h, "");
    }

    // ─── Aave4626 ────────────────────────────────────────────────────────────

    function test_aave4626_roundTripAndLiquidity() public {
        usdc.mint(bob, 1_000e6);
        vm.startPrank(bob);
        usdc.approve(address(aaveUsdc), 1_000e6);
        uint256 shares = aaveUsdc.deposit(1_000e6, bob);
        vm.stopPrank();
        aavePool.accrue(100);
        assertApproxEqAbs(aaveUsdc.convertToAssets(shares), 1_010e6, 2);
        assertEq(aaveUsdc.balanceOf(bob), shares); // non-rebasing

        aavePool.borrow(usdc.balanceOf(address(aUsdc)), address(0xdead)); // 100% utilisation
        assertEq(aaveUsdc.maxWithdraw(bob), 0);
        assertEq(aaveUsdc.maxRedeem(bob), 0);
    }

    // ─── Fuzz ────────────────────────────────────────────────────────────────

    function testFuzz_rebalance_preservesValue(uint256 shareSeed, uint8 route, uint16 accrueBps) public {
        morpho.accrue(bound(accrueBps, 0, 500));
        address[3] memory m = [address(morpho), address(fluid), address(aaveUsdc)];
        uint256 first = bound(shareSeed, 1e6, morpho.balanceOf(lp));
        vm.prank(keeper);
        yapp.rebalance(s, address(morpho), m[1 + route % 2], first);
        uint256 before = _walletValue();
        uint256 moved = IERC20(m[1 + route % 2]).balanceOf(lp);
        vm.prank(keeper);
        yapp.rebalance(s, m[1 + route % 2], m[2 - route % 2], moved);
        assertApproxEqAbs(_walletValue(), before, 20);
        _appHoldsNothing();
    }

    function testFuzz_swap_neverLosesValueAtOracle(uint256 amountSeed, uint256 priceSeed, bool buyEth) public {
        oracle.setAnswer(int256(bound(priceSeed, 2_500e8, 3_500e8)));
        uint256 price = uint256(oracle.answer()) * 1e16; // USDC units per ETH × 1e18 → per-wei math below
        AquaYieldApp.SwapParams memory p;
        p.to = address(this);
        p.maxAmountIn = type(uint256).max;
        if (buyEth) {
            (p.tokenOut, p.outMarket, p.inMarket) = (address(weth), address(aaveWeth), address(morpho));
            p.amountOut = bound(amountSeed, 1e15, 1.5e18);
        } else {
            (p.tokenOut, p.outMarket, p.inMarket) = (address(usdc), address(morpho), address(aaveWeth));
            p.amountOut = bound(amountSeed, 1e6, 3_000e6);
        }
        uint256 v0 = _valueAt(price);
        AquaYieldApp.Strategy memory open = _openFor(address(this));
        try yapp.swapExactOut(open, p, "") {} catch {}
        assertGe(_valueAt(price) + 20, v0);
    }

    // Test contract acts as taker for the fuzz: pays whatever is asked.
    function onAquaYieldSwap(address tokenIn, address, uint256 amountIn, uint256, address, bytes32, bytes calldata)
        external
    {
        MockERC20(tokenIn).mint(msg.sender, amountIn);
    }

    function onAquaYieldFlash(address, uint256, uint256, address, bytes32, bytes calldata) external {}

    function _openFor(address taker) internal returns (AquaYieldApp.Strategy memory open) {
        open = _strategy(taker, 5, 20);
        open.salt = bytes32("fuzz");
        address[] memory tokens = new address[](4);
        uint256[] memory amounts = new uint256[](4);
        (tokens[0], tokens[1], tokens[2], tokens[3]) =
        (address(morpho), address(fluid), address(aaveUsdc), address(aaveWeth));
        (amounts[0], amounts[3]) = (morpho.balanceOf(lp), aaveWeth.balanceOf(lp));
        vm.prank(lp);
        aqua.ship(address(yapp), abi.encode(open), tokens, amounts);
    }

    function _valueAt(uint256 priceE18) internal view returns (uint256) {
        uint256 stableAssets = morpho.convertToAssets(morpho.balanceOf(lp)) + fluid.convertToAssets(fluid.balanceOf(lp))
            + aaveUsdc.convertToAssets(aaveUsdc.balanceOf(lp));
        uint256 wethAssets = aaveWeth.convertToAssets(aaveWeth.balanceOf(lp));
        return stableAssets + wethAssets * priceE18 / 1e36;
    }
}
