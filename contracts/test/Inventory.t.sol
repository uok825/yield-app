// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";
import {AquaApp} from "@1inch/aqua/src/AquaApp.sol";

import {Fixture} from "./utils/Fixture.sol";
import {InventoryVault} from "../src/InventoryVault.sol";
import {OracleSwapApp} from "../src/OracleSwapApp.sol";
import {YieldResolver} from "../src/YieldResolver.sol";
import {IOracleSwapCallback} from "../src/interfaces/IOracleSwap.sol";
import {IYieldAdapter} from "../src/interfaces/IYieldAdapter.sol";
import {MockSwapRouter} from "../src/mocks/MockSwapRouter.sol";

/// @dev Direct taker of OracleSwapApp used to probe defences.
contract SwapTaker is IOracleSwapCallback {
    enum Mode {
        Pay,
        PayShort,
        DepositDuringSwap,
        RedeemDuringSwap
    }

    IAqua internal immutable aqua;
    OracleSwapApp internal immutable app;
    InventoryVault internal immutable vault;
    Mode internal mode;

    constructor(IAqua aqua_, OracleSwapApp app_, InventoryVault vault_) {
        (aqua, app, vault) = (aqua_, app_, vault_);
    }

    function buy(OracleSwapApp.Strategy calldata s, address tokenOut, uint256 amountOut, Mode m)
        external
        returns (uint256)
    {
        mode = m;
        return app.swapExactOut(s, tokenOut, amountOut, type(uint256).max, address(this), "");
    }

    function sell(OracleSwapApp.Strategy calldata s, address tokenIn, uint256 amountIn, Mode m)
        external
        returns (uint256)
    {
        mode = m;
        return app.swapExactIn(s, tokenIn, amountIn, 0, address(this), "");
    }

    function oracleSwapCallback(
        address tokenIn,
        address,
        uint256 amountIn,
        uint256,
        address maker,
        bytes32 hash,
        bytes calldata
    ) external {
        if (mode == Mode.DepositDuringSwap) {
            vault.deposit(0, 0, address(this), 0);
        } else if (mode == Mode.RedeemDuringSwap) {
            vault.redeem(1, address(this), address(this), 0, 0);
        }
        uint256 pay = mode == Mode.PayShort ? amountIn - 1 : amountIn;
        IERC20(tokenIn).approve(address(aqua), pay);
        aqua.push(maker, address(app), hash, tokenIn, pay);
    }
}

contract InventoryTest is Fixture {
    uint256 internal constant SEED = 100_000e6; // $100k: 70k USDC + 10 WETH

    SwapTaker internal taker;
    OracleSwapApp.Strategy internal openStrategy;

    function setUp() public override {
        super.setUp();
        taker = new SwapTaker(IAqua(address(aqua)), swapApp, inv);
        openStrategy = swapStrategy;
        openStrategy.taker = address(0);
        openStrategy.salt = bytes32("open");
        vm.prank(owner);
        inv.shipStrategy(address(swapApp), abi.encode(openStrategy), BUDGET, 1e30);
    }

    function _value() internal view returns (uint256) {
        return inv.totalValue();
    }

    // ─── Deposits / redemptions ──────────────────────────────────────────────

    function test_deposit_atTarget() public {
        uint256 shares = _seedInventory(alice, SEED);
        assertEq(shares, SEED * 1e12);
        assertEq(inv.totalValue(), SEED);
        assertEq(inv.stableRatioBps(), 7_000);
        (uint256 s, uint256 v) = inv.holdings();
        assertEq(s, 70_000e6);
        assertEq(v, 10e18);
    }

    function test_deposit_firstMustBeInBand() public {
        usdc.mint(alice, 1_000e6);
        vm.startPrank(alice);
        usdc.approve(address(inv), 1_000e6);
        vm.expectRevert(abi.encodeWithSelector(InventoryVault.OutOfBand.selector, 10_000));
        inv.deposit(1_000e6, 0, alice, 0);
        vm.stopPrank();
    }

    function test_deposit_singleAsset_inBandOrImproving() public {
        _seedInventory(alice, SEED);
        // +4k USDC → 74k/104k = 71.2% (in band)
        usdc.mint(bob, 20_000e6);
        vm.startPrank(bob);
        usdc.approve(address(inv), type(uint256).max);
        inv.deposit(4_000e6, 0, bob, 0);
        // +17k USDC → 91k/121k = 75.2%: past the band edge
        vm.expectPartialRevert(InventoryVault.OutOfBand.selector);
        inv.deposit(17_000e6, 0, bob, 0);
        vm.stopPrank();

        // ETH crashes 40%: ratio ~79% (out of band). Depositing WETH improves it → allowed.
        oracle.setAnswer(1_800e8);
        assertGt(inv.stableRatioBps(), 7_500);
        weth.mint(bob, 1e18);
        vm.startPrank(bob);
        weth.approve(address(inv), 1e18);
        inv.deposit(0, 1e18, bob, 0);
        // …but more USDC makes it worse → rejected.
        vm.expectPartialRevert(InventoryVault.OutOfBand.selector);
        inv.deposit(1_000e6, 0, bob, 0);
        vm.stopPrank();
    }

    function test_deposit_sharesProportionalToValue() public {
        _seedInventory(alice, SEED);
        uint256 bobShares = _seedInventory(bob, 10_000e6);
        assertApproxEqRel(bobShares, inv.balanceOf(alice) / 10, 1e12);
    }

    function test_deposit_feeStaysInPool() public {
        vm.prank(owner);
        inv.setParams(1 hours, 10, 50); // 10 bps deposit fee
        _seedInventory(alice, SEED);
        uint256 bobShares = _seedInventory(bob, SEED);
        assertLt(bobShares, inv.balanceOf(alice)); // bob paid the fee
        uint256 aliceShares = inv.balanceOf(alice);
        vm.prank(alice);
        (uint256 s,) = inv.redeem(aliceShares, alice, alice, 0, 0);
        assertGt(s, 70_000e6); // alice captured part of bob's fee
    }

    function test_redeem_inKind() public {
        uint256 shares = _seedInventory(alice, SEED);
        vm.prank(alice);
        (uint256 s, uint256 v) = inv.redeem(shares / 2, alice, alice, 0, 0);
        // Virtual shares keep a ~1e-11 sliver in the pool.
        assertApproxEqRel(s, 35_000e6, 1e9);
        assertApproxEqRel(v, 5e18, 1e9);
        assertEq(usdc.balanceOf(alice), s);
        assertEq(weth.balanceOf(alice), v);
    }

    function test_redeem_worksWhenPausedAndOracleStale() public {
        uint256 shares = _seedInventory(alice, SEED);
        vm.prank(keeper);
        inv.pause();
        oracle.setUpdatedAt(block.timestamp);
        skip(1 days);
        vm.expectRevert(abi.encodeWithSelector(InventoryVault.StalePrice.selector, block.timestamp - 1 days, 1 hours));
        inv.totalValue();

        vm.prank(alice);
        (uint256 s, uint256 v) = inv.redeem(shares, alice, alice, 0, 0);
        assertApproxEqRel(s, 70_000e6, 1e9);
        assertApproxEqRel(v, 10e18, 1e9);
    }

    function test_redeem_slippageAndAllowance() public {
        uint256 shares = _seedInventory(alice, SEED);
        vm.prank(alice);
        vm.expectRevert(InventoryVault.Slippage.selector);
        inv.redeem(shares, alice, alice, 70_001e6, 0);

        vm.prank(bob);
        vm.expectRevert();
        inv.redeem(shares, bob, alice, 0, 0);

        vm.prank(alice);
        inv.approve(bob, shares);
        vm.prank(bob);
        inv.redeem(shares, bob, alice, 0, 0);
        assertGt(usdc.balanceOf(bob), 0);
    }

    function test_oracle_invalidAndStale() public {
        _seedInventory(alice, SEED);
        oracle.setAnswer(0);
        vm.expectRevert(abi.encodeWithSelector(InventoryVault.InvalidPrice.selector, int256(0)));
        inv.price();

        oracle.setAnswer(3_000e8);
        skip(1 hours + 1);
        vm.expectPartialRevert(InventoryVault.StalePrice.selector);
        inv.price();
    }

    function test_inflationDonation_isUnprofitable() public {
        // Attacker makes a dust first deposit (in band), then donates a large amount to skew share price.
        usdc.mint(bob, 70_000e6 + 7);
        weth.mint(bob, 10e18 + 1e9);
        vm.startPrank(bob);
        usdc.approve(address(inv), 7);
        weth.approve(address(inv), 1e9);
        inv.deposit(7, 1e9, bob, 0); // 7 wei USDC + 1e9 wei WETH ≈ 70/30 by value
        usdc.transfer(address(inv), 70_000e6);
        weth.transfer(address(inv), 10e18);
        vm.stopPrank();

        uint256 victimShares = _seedInventory(alice, 10_000e6);
        assertGt(victimShares, 0);
        vm.prank(alice);
        (uint256 s, uint256 v) = inv.redeem(victimShares, alice, alice, 0, 0);
        uint256 out = s + inv.volatileValue(v, inv.price());
        assertApproxEqRel(out, 10_000e6, 0.001e18); // victim loses < 0.1%
    }

    // ─── Pricing ─────────────────────────────────────────────────────────────

    function test_prices_atTarget_noSkew() public {
        _seedInventory(alice, SEED);
        (uint256 bid, uint256 ask, int256 skew) = swapApp.prices(swapStrategy);
        assertEq(skew, 0);
        assertEq(bid, 2_994e6 * 1e18); // 3000 * (1 - 0.20%)
        assertEq(ask, 3_006e6 * 1e18); // 3000 * (1 + 0.20%)
    }

    function test_prices_skewWhenVolatileHeavy() public {
        _seedInventory(alice, SEED);
        oracle.setAnswer(3_600e8); // ETH +20% → ETH share 33.9%, stable share 66.0%
        (uint256 bid, uint256 ask, int256 skew) = swapApp.prices(swapStrategy);
        assertGt(skew, 0);
        assertLe(skew, int256(uint256(SKEW_BPS)));
        uint256 p = 3_600e6 * 1e18;
        assertLt(ask, p * 10_020 / 10_000); // ETH cheaper to buy from the vault
        assertGe(ask, p); // …but never below oracle
        assertLt(bid, p * 9_980 / 10_000); // and worse to sell to the vault
    }

    function test_prices_skewCappedAtBandEdge() public {
        _seedInventory(alice, SEED);
        oracle.setAnswer(9_000e8); // wildly ETH-heavy
        (,, int256 skew) = swapApp.prices(swapStrategy);
        assertEq(skew, int256(uint256(SKEW_BPS)));
    }

    function test_strategy_rejectsSkewAboveSpread() public {
        _seedInventory(alice, SEED);
        OracleSwapApp.Strategy memory bad = swapStrategy;
        bad.skewBps = SPREAD_BPS + 1;
        vm.expectRevert(OracleSwapApp.InvalidStrategy.selector);
        swapApp.prices(bad);
    }

    // ─── Filling intents from inventory via the resolver ─────────────────────

    function test_fill_userBuysEth_withUsdc() public {
        _seedInventory(alice, SEED);
        // User: give 3,030 USDC, want 1 WETH (resolver buys 1 WETH from vault at 3,006).
        uint256 id = _postOrder(bob, usdc, weth, 3_030e6, 1e18);
        uint256 before = _value();

        vm.prank(operator);
        uint256 profit = resolver.executeSwap(swapStrategy, address(weth), 1e18, type(uint256).max, _fillCalls(id), 1);

        assertEq(weth.balanceOf(bob), 1e18);
        assertEq(profit, 24e6); // 3,030 − 3,006
        assertEq(_value(), before + 6e6); // vault earns ask − oracle = 6 USDC
        (uint256 s, uint256 v) = inv.holdings();
        assertEq(s, 73_006e6);
        assertEq(v, 9e18);
        assertFalse(inv.isSwapping());
    }

    function test_fill_userSellsEth_forUsdc() public {
        _seedInventory(alice, SEED);
        // User: give 1 WETH, want 2,980 USDC. Resolver buys 2,980 USDC from vault paying WETH at bid 2,994.
        uint256 id = _postOrder(bob, weth, usdc, 1e18, 2_980e6);
        uint256 before = _value();

        vm.prank(operator);
        uint256 profit =
            resolver.executeSwap(swapStrategy, address(usdc), 2_980e6, type(uint256).max, _fillCalls(id), 1);

        assertEq(usdc.balanceOf(bob), 2_980e6);
        uint256 wethPaid = 1e18 - profit;
        assertApproxEqAbs(wethPaid, uint256(2_980e6) * 1e18 / 2_994e6, 1);
        assertGt(_value(), before); // vault bought ETH below oracle
    }

    function test_fill_unprofitableOrderReverts() public {
        _seedInventory(alice, SEED);
        uint256 id = _postOrder(bob, usdc, weth, 3_000e6, 1e18); // pays less than ask
        vm.prank(operator);
        vm.expectRevert(); // resolver cannot fund the Aqua push
        resolver.executeSwap(swapStrategy, address(weth), 1e18, type(uint256).max, _fillCalls(id), 0);
    }

    function test_fill_maxAmountInRespected() public {
        _seedInventory(alice, SEED);
        uint256 id = _postOrder(bob, usdc, weth, 3_030e6, 1e18);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(OracleSwapApp.ExcessiveInput.selector, 3_006e6, 3_000e6));
        resolver.executeSwap(swapStrategy, address(weth), 1e18, 3_000e6, _fillCalls(id), 0);
    }

    function test_fill_unwindsLendingJustInTime() public {
        _seedInventory(alice, SEED);
        vm.startPrank(keeper);
        inv.allocate(address(weth), 10e18); // all WETH lent out on Aave
        inv.allocate(address(usdc), 60_000e6);
        vm.stopPrank();
        assertEq(weth.balanceOf(address(inv)), 0);

        uint256 id = _postOrder(bob, usdc, weth, 3_030e6, 1e18);
        vm.prank(operator);
        resolver.executeSwap(swapStrategy, address(weth), 1e18, type(uint256).max, _fillCalls(id), 1);
        assertEq(weth.balanceOf(bob), 1e18);
        assertApproxEqAbs(invWethAdapter.totalAssets(), 9e18, 1);
    }

    function test_fill_lendingYieldCounts() public {
        _seedInventory(alice, SEED);
        vm.startPrank(keeper);
        inv.allocate(address(weth), 10e18);
        inv.allocate(address(usdc), 70_000e6);
        vm.stopPrank();
        aavePool.accrue(100); // +1% USDC
        aaveWethPool.accrue(100); // +1% WETH
        assertApproxEqAbs(_value(), 101_000e6, 2);
    }

    // ─── Guards ──────────────────────────────────────────────────────────────

    function test_guard_tradeTooLarge() public {
        _seedInventory(alice, SEED);
        // 20% of $100k = $20k. Buying 7 WETH (~$21k) is too big.
        vm.expectPartialRevert(OracleSwapApp.TradeTooLarge.selector);
        taker.buy(openStrategy, address(weth), 7e18, SwapTaker.Mode.Pay);
    }

    function test_guard_bandBlocksDriftAway() public {
        _seedInventory(alice, SEED);
        usdc.mint(address(taker), 1_000_000e6);
        // Buying 1.5 WETH → stable 74.5% (in band) OK; another 0.5 → 76% → rejected.
        taker.buy(openStrategy, address(weth), 1.5e18, SwapTaker.Mode.Pay);
        vm.expectPartialRevert(OracleSwapApp.OutOfBand.selector);
        taker.buy(openStrategy, address(weth), 0.5e18, SwapTaker.Mode.Pay);
    }

    function test_guard_outOfBandAllowsTradesBackTowardTarget() public {
        _seedInventory(alice, SEED);
        oracle.setAnswer(1_800e8); // stable ratio ~79.5%: out of band
        usdc.mint(address(taker), 1_000_000e6);
        weth.mint(address(taker), 100e18);

        vm.expectPartialRevert(OracleSwapApp.OutOfBand.selector); // vault selling more ETH makes it worse
        taker.buy(openStrategy, address(weth), 0.1e18, SwapTaker.Mode.Pay);

        uint256 before = inv.stableRatioBps();
        taker.sell(openStrategy, address(weth), 1e18, SwapTaker.Mode.Pay); // vault buys ETH → back toward 70%
        assertLt(inv.stableRatioBps(), before);
    }

    function test_guard_exclusiveTaker() public {
        _seedInventory(alice, SEED);
        usdc.mint(address(taker), 10_000e6);
        vm.expectRevert(
            abi.encodeWithSelector(OracleSwapApp.UnauthorizedTaker.selector, address(taker), address(resolver))
        );
        taker.buy(swapStrategy, address(weth), 1e18, SwapTaker.Mode.Pay);
    }

    function test_guard_shortPaymentReverts() public {
        _seedInventory(alice, SEED);
        usdc.mint(address(taker), 10_000e6);
        vm.expectPartialRevert(AquaApp.MissingTakerAquaPush.selector);
        taker.buy(openStrategy, address(weth), 1e18, SwapTaker.Mode.PayShort);
    }

    function test_guard_noDepositOrRedeemDuringSwap() public {
        _seedInventory(alice, SEED);
        usdc.mint(address(taker), 10_000e6);
        vm.expectRevert(InventoryVault.SwapActive.selector);
        taker.buy(openStrategy, address(weth), 1e18, SwapTaker.Mode.DepositDuringSwap);
        vm.expectRevert(InventoryVault.SwapActive.selector);
        taker.buy(openStrategy, address(weth), 1e18, SwapTaker.Mode.RedeemDuringSwap);
    }

    function test_guard_pausedAndStale() public {
        _seedInventory(alice, SEED);
        usdc.mint(address(taker), 10_000e6);
        vm.prank(keeper);
        inv.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        taker.buy(openStrategy, address(weth), 1e18, SwapTaker.Mode.Pay);
        vm.prank(owner);
        inv.unpause();

        skip(1 hours + 1);
        vm.expectPartialRevert(InventoryVault.StalePrice.selector);
        taker.buy(openStrategy, address(weth), 1e18, SwapTaker.Mode.Pay);
    }

    function test_guard_swapWindowOnlyApp() public {
        vm.expectRevert(InventoryVault.OnlySwapApp.selector);
        inv.beginSwap(address(usdc), 1);
        vm.expectRevert(InventoryVault.OnlySwapApp.selector);
        inv.endSwap();
        vm.prank(address(swapApp));
        vm.expectRevert(InventoryVault.NotSwapping.selector);
        inv.endSwap();
    }

    function test_guard_revokedApp() public {
        _seedInventory(alice, SEED);
        vm.prank(owner);
        inv.setSwapApp(address(swapApp), false);
        usdc.mint(address(taker), 10_000e6);
        vm.expectRevert(InventoryVault.OnlySwapApp.selector);
        taker.buy(openStrategy, address(weth), 1e18, SwapTaker.Mode.Pay);
    }

    // ─── Keeper rebalance ────────────────────────────────────────────────────

    function _rebalanceBuyEth(uint256 usdcIn) internal view returns (bytes memory) {
        return abi.encodeCall(MockSwapRouter.swap, (address(usdc), address(weth), usdcIn, 0, address(inv)));
    }

    function test_rebalance_restoresBand() public {
        _seedInventory(alice, SEED);
        oracle.setAnswer(1_800e8); // stable ~79.5%
        router.setPrice(address(usdc), address(weth), uint256(1e30) / 1_801); // ~5 bps worse than oracle
        uint256 before = inv.stableRatioBps();

        vm.prank(keeper);
        inv.rebalance(address(router), _rebalanceBuyEth(8_000e6), address(usdc), 8_000e6, 1);
        assertLt(inv.stableRatioBps(), before);
        assertLe(inv.stableRatioBps(), 7_500);
    }

    function test_rebalance_mustImprove() public {
        _seedInventory(alice, SEED);
        router.setPrice(address(usdc), address(weth), uint256(1e30) / 3_000);
        // At target already: any trade moves away.
        vm.prank(keeper);
        vm.expectRevert(InventoryVault.RebalanceMustImprove.selector);
        inv.rebalance(address(router), _rebalanceBuyEth(1_000e6), address(usdc), 1_000e6, 0);
    }

    function test_rebalance_lossCapped() public {
        _seedInventory(alice, SEED);
        oracle.setAnswer(1_800e8);
        // 39% worse than oracle on $8k ≈ $3.1k ≈ 3.4% of vault value > 0.5% cap
        router.setPrice(address(usdc), address(weth), uint256(1e30) / 2_500);
        vm.prank(keeper);
        vm.expectPartialRevert(InventoryVault.ValueLost.selector);
        inv.rebalance(address(router), _rebalanceBuyEth(8_000e6), address(usdc), 8_000e6, 0);
    }

    function test_rebalance_onlyKeeperAndWhitelistedTarget() public {
        vm.expectRevert(InventoryVault.OnlyKeeper.selector);
        inv.rebalance(address(router), "", address(usdc), 1, 0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(InventoryVault.TargetNotAllowed.selector, address(usdc)));
        inv.rebalance(address(usdc), "", address(usdc), 1, 0);
    }

    // ─── Admin ───────────────────────────────────────────────────────────────

    function test_admin_adapterRules() public {
        _seedInventory(alice, SEED);
        vm.prank(keeper);
        inv.allocate(address(usdc), 10_000e6);

        vm.startPrank(owner);
        vm.expectRevert(InventoryVault.AdapterNotEmpty.selector);
        inv.setAdapter(address(usdc), IYieldAdapter(address(0)));
        vm.expectRevert(InventoryVault.InvalidAdapter.selector);
        inv.setAdapter(address(weth), invUsdcAdapter); // wrong asset
        vm.expectRevert(abi.encodeWithSelector(InventoryVault.UnknownToken.selector, address(0xdead)));
        inv.setAdapter(address(0xdead), invUsdcAdapter);
        vm.stopPrank();
    }

    function test_admin_paramsBounds() public {
        vm.startPrank(owner);
        vm.expectRevert(InventoryVault.InvalidParam.selector);
        inv.setProfile(10_001, 500);
        vm.expectRevert(InventoryVault.InvalidParam.selector);
        inv.setProfile(7_000, 0);
        vm.expectRevert(InventoryVault.InvalidParam.selector);
        inv.setParams(0, 0, 0);
        vm.expectRevert(InventoryVault.InvalidParam.selector);
        inv.setParams(1, 101, 0);
        inv.setProfile(5_000, 500);
        vm.stopPrank();
        (uint16 t, uint16 b) = inv.profile();
        assertEq(t, 5_000);
        assertEq(b, 500);
    }

    function test_admin_rescue() public {
        vm.startPrank(owner);
        vm.expectRevert(InventoryVault.CannotRescueAsset.selector);
        inv.rescueToken(IERC20(address(weth)), owner, 1);
        vm.stopPrank();
    }

    // ─── Fuzz ────────────────────────────────────────────────────────────────

    /// Any accepted swap, in either direction, at any price in a ±30% range, never lowers the vault's value
    /// measured at the oracle price.
    function testFuzz_swapNeverLosesValue(uint256 priceSeed, uint256 amountSeed, bool buyEth) public {
        _seedInventory(alice, SEED);
        int256 p = int256(bound(priceSeed, 2_100e8, 3_900e8));
        oracle.setAnswer(p);
        usdc.mint(address(taker), 10_000_000e6);
        weth.mint(address(taker), 10_000e18);

        uint256 before = _value();
        if (buyEth) {
            uint256 amount = bound(amountSeed, 1e12, 5e18);
            try taker.buy(openStrategy, address(weth), amount, SwapTaker.Mode.Pay) {} catch {}
        } else {
            uint256 amount = bound(amountSeed, 1e12, 5e18);
            try taker.sell(openStrategy, address(weth), amount, SwapTaker.Mode.Pay) {} catch {}
        }
        assertGe(_value(), before);
        assertFalse(inv.isSwapping());
    }

    function testFuzz_depositRedeem_noFreeValue(uint256 value) public {
        _seedInventory(alice, SEED);
        value = bound(value, 10e6, 1_000_000e6);
        uint256 shares = _seedInventory(bob, value);
        vm.prank(bob);
        (uint256 s, uint256 v) = inv.redeem(shares, bob, bob, 0, 0);
        assertLe(s + inv.volatileValue(v, inv.price()), value);
    }
}
