// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {Fixture} from "./utils/Fixture.sol";
import {CarryVault} from "../src/CarryVault.sol";
import {IAaveV3CreditPool, IAaveOracle} from "../src/interfaces/IAaveV3.sol";
import {IChainlinkAggregator} from "../src/interfaces/IChainlinkAggregator.sol";
import {MockCreditMarket, MockAaveOracle} from "../src/mocks/MockCreditMarket.sol";
import {MockSwapRouter} from "../src/mocks/MockSwapRouter.sol";

contract CarryVaultTest is Fixture {
    MockAaveOracle internal aaveOracle;
    MockCreditMarket internal market;
    CarryVault internal carry;

    uint256 internal constant RAY = 1e27;
    uint256 internal constant DEPOSIT = 10e18; // $30,000 at $3,000

    function setUp() public override {
        super.setUp();
        aaveOracle = new MockAaveOracle(IChainlinkAggregator(address(oracle)), address(weth));
        market = new MockCreditMarket(aaveOracle);
        market.initReserve(weth, 8_000, 8_250, false, 0);
        market.initReserve(usdc, 7_500, 8_000, true, 5 * RAY / 100); // 5% borrow APR

        // Third-party USDC liquidity to borrow from.
        usdc.mint(address(this), 1_000_000e6);
        usdc.approve(address(market), type(uint256).max);
        market.supply(address(usdc), 1_000_000e6, address(this), 0);

        carry = new CarryVault(
            CarryVault.Config({
                asset: weth,
                pool: IAaveV3CreditPool(address(market)),
                aCollateral: IERC20(market.aTokenOf(address(weth))),
                debtAsset: usdc,
                debtToken: IERC20(market.debtTokenOf(address(usdc))),
                oracle: IAaveOracle(address(aaveOracle)),
                owner: owner,
                keeper: keeper,
                maxLtvBps: 3_000,
                deleverageLtvBps: 4_000,
                name: "YieldSolver Carry WETH",
                symbol: "ycWETH"
            })
        );
        vm.startPrank(owner);
        carry.setSink(address(morpho), 1_000_000e6);
        carry.setSink(address(fluid), 1_000_000e6);
        carry.setRouter(address(router), true);
        vm.stopPrank();

        // Third-party depth in the sinks so share prices are meaningful.
        usdc.mint(address(this), 200_000e6);
        usdc.approve(address(morpho), type(uint256).max);
        usdc.approve(address(fluid), type(uint256).max);
        morpho.deposit(100_000e6, address(this));
        fluid.deposit(100_000e6, address(this));
    }

    function _supplyCarry(address who, uint256 amount) internal returns (uint256 shares) {
        weth.mint(who, amount);
        vm.startPrank(who);
        weth.approve(address(carry), amount);
        shares = carry.deposit(amount, who);
        vm.stopPrank();
    }

    function _open(uint256 amount) internal {
        vm.prank(keeper);
        carry.open(address(morpho), amount, 0);
    }

    // ─── Basics ──────────────────────────────────────────────────────────────

    function test_deposit_suppliesCollateral() public {
        uint256 shares = _supplyCarry(alice, DEPOSIT);
        assertEq(carry.collateral(), DEPOSIT);
        assertEq(carry.totalAssets(), DEPOSIT);
        assertEq(carry.ltvBps(), 0);
        assertApproxEqAbs(carry.convertToAssets(shares), DEPOSIT, 1); // virtual-share rounding
    }

    function test_open_withinLtvOnly() public {
        _supplyCarry(alice, DEPOSIT);
        _open(9_000e6); // 30% of $30k
        assertEq(carry.debt(), 9_000e6);
        assertApproxEqAbs(carry.ltvBps(), 3_000, 1);
        assertApproxEqAbs(carry.totalAssets(), DEPOSIT, 1e6); // borrowing alone creates no value

        vm.prank(keeper);
        vm.expectPartialRevert(CarryVault.LtvTooHigh.selector);
        carry.open(address(morpho), 1e6, 0);
    }

    function test_open_guards() public {
        _supplyCarry(alice, DEPOSIT);
        vm.expectRevert(CarryVault.OnlyKeeper.selector);
        carry.open(address(morpho), 1e6, 0);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CarryVault.SinkNotAllowed.selector, address(aUsdc)));
        carry.open(address(aUsdc), 1e6, 0);

        vm.prank(owner);
        carry.setSink(address(fluid), 1_000e6);
        vm.prank(keeper);
        vm.expectPartialRevert(CarryVault.SinkCapExceeded.selector);
        carry.open(address(fluid), 2_000e6, 0);
    }

    // ─── Carry P&L ───────────────────────────────────────────────────────────

    function test_carry_spreadAccruesToShares() public {
        _supplyCarry(alice, DEPOSIT);
        _open(9_000e6);
        uint256 before = carry.totalAssets();

        morpho.accrueWad(0.01e18); // sink +1%
        market.accrueDebtWad(address(usdc), 0.004e18); // debt +0.4%

        // +0.6% of $9,000 = $54 = 0.018 WETH at $3,000
        assertApproxEqAbs(carry.totalAssets() - before, 0.018e18, 1e13);
    }

    function test_carry_negativeSpreadShowsUpToo() public {
        _supplyCarry(alice, DEPOSIT);
        _open(9_000e6);
        uint256 before = carry.totalAssets();
        market.accrueDebtWad(address(usdc), 0.01e18); // debt +1%, sink flat
        assertLt(carry.totalAssets(), before); // shares mark the loss honestly
    }

    function test_close_repaysAndHarvestsProfitIntoCollateral() public {
        _supplyCarry(alice, DEPOSIT);
        _open(9_000e6);
        morpho.accrueWad(0.01e18);
        uint256 shares = IERC20(address(morpho)).balanceOf(address(carry));

        vm.prank(keeper);
        carry.close(address(morpho), shares);
        assertEq(carry.debt(), 0);
        uint256 surplus = usdc.balanceOf(address(carry));
        assertApproxEqAbs(surplus, 90e6, 1);

        router.setPrice(address(usdc), address(weth), uint256(1e30) / 3_000);
        bytes memory swap =
            abi.encodeCall(MockSwapRouter.swap, (address(usdc), address(weth), surplus, 0, address(carry)));
        uint256 collBefore = carry.collateral();
        vm.prank(keeper);
        carry.harvest(address(router), swap, surplus, 0);
        assertApproxEqAbs(carry.collateral() - collBefore, 0.03e18, 1e12);
        assertEq(usdc.balanceOf(address(carry)), 0);
    }

    function test_harvest_guards() public {
        _supplyCarry(alice, DEPOSIT);
        _open(9_000e6);
        vm.prank(keeper);
        vm.expectRevert(CarryVault.NoSurplus.selector); // no profit yet: nothing to harvest
        carry.harvest(address(router), "", 1e6, 0);

        morpho.accrueWad(0.01e18);
        router.setPrice(address(usdc), address(weth), uint256(1e30) / 3_300); // 10% worse than oracle
        bytes memory swap = abi.encodeCall(MockSwapRouter.swap, (address(usdc), address(weth), 80e6, 0, address(carry)));
        vm.prank(keeper);
        vm.expectPartialRevert(CarryVault.Slippage.selector);
        carry.harvest(address(router), swap, 80e6, 0);
    }

    function test_rotate_preservesValue() public {
        _supplyCarry(alice, DEPOSIT);
        _open(9_000e6);
        uint256 before = carry.totalAssets();
        uint256 shares = IERC20(address(morpho)).balanceOf(address(carry));
        vm.prank(keeper);
        carry.rotate(address(morpho), address(fluid), shares);
        assertEq(IERC20(address(morpho)).balanceOf(address(carry)), 0);
        assertGt(IERC20(address(fluid)).balanceOf(address(carry)), 0);
        assertApproxEqAbs(carry.totalAssets(), before, 1e9);
    }

    function test_negativeCarry_shortfallRepaidFromCollateral() public {
        uint256 shares = _supplyCarry(alice, DEPOSIT);
        _open(9_000e6);
        market.accrueDebtWad(address(usdc), 0.01e18); // borrow cost ran above the sink: $90 shortfall
        uint256 sh = IERC20(address(morpho)).balanceOf(address(carry));
        vm.prank(keeper);
        carry.close(address(morpho), sh);
        assertApproxEqAbs(carry.debt(), 90e6, 2);

        router.setPrice(address(weth), address(usdc), 3_000e6);
        uint256 sell = 0.031e18; // ~$93 of collateral
        bytes memory swap = abi.encodeCall(MockSwapRouter.swap, (address(weth), address(usdc), sell, 0, address(carry)));
        vm.prank(keeper);
        carry.repayFromCollateral(address(router), swap, sell, 0);
        assertEq(carry.debt(), 0);

        // ~$3 of stable left over from the sale goes back into collateral.
        uint256 leftover = usdc.balanceOf(address(carry));
        router.setPrice(address(usdc), address(weth), uint256(1e30) / 3_000);
        bytes memory back =
            abi.encodeCall(MockSwapRouter.swap, (address(usdc), address(weth), leftover, 0, address(carry)));
        vm.prank(keeper);
        carry.harvest(address(router), back, leftover, 0);

        uint256 redeemable = Math.min(shares, carry.maxRedeem(alice));
        vm.prank(alice);
        uint256 out = carry.redeem(redeemable, alice, alice);
        assertApproxEqAbs(out, DEPOSIT - 0.03e18, 1e15); // the $90 loss is borne by the shares
    }

    // ─── Withdrawals unwind debt ─────────────────────────────────────────────

    function test_redeemMax_unwindsCarryInSameTx() public {
        _supplyCarry(alice, DEPOSIT);
        _open(9_000e6);
        morpho.accrueWad(0.01e18);
        // Profit sits as stable until harvested, so the max redeemable is the collateral.
        uint256 max = carry.maxRedeem(alice);
        assertLt(max, carry.balanceOf(alice));

        vm.prank(alice);
        uint256 out = carry.redeem(max, alice, alice);
        assertApproxEqAbs(out, DEPOSIT, 1e12);
        assertEq(carry.debt(), 0); // unwound and repaid in the same tx
        assertApproxEqAbs(usdc.balanceOf(address(carry)), 90e6, 2); // $90 profit left for the remaining shares
    }

    function test_closeHarvestThenRedeemAll_returnsProfit() public {
        uint256 shares = _supplyCarry(alice, DEPOSIT);
        _open(9_000e6);
        morpho.accrueWad(0.01e18);
        _closeAndHarvest(3_000);
        vm.prank(alice);
        uint256 out = carry.redeem(shares, alice, alice);
        assertApproxEqAbs(out, DEPOSIT + 0.03e18, 1e12); // + $90 at $3,000
    }

    function _closeAndHarvest(uint256 ethUsd) internal {
        uint256 sh = IERC20(address(morpho)).balanceOf(address(carry));
        vm.prank(keeper);
        carry.close(address(morpho), sh);
        uint256 surplus = usdc.balanceOf(address(carry));
        if (surplus == 0) return;
        router.setPrice(address(usdc), address(weth), uint256(1e30) / ethUsd);
        bytes memory swap =
            abi.encodeCall(MockSwapRouter.swap, (address(usdc), address(weth), surplus, 0, address(carry)));
        vm.prank(keeper);
        carry.harvest(address(router), swap, surplus, 0);
    }

    function test_partialWithdraw_keepsLtvWithinLimit() public {
        _supplyCarry(alice, DEPOSIT);
        _open(9_000e6);
        vm.prank(alice);
        carry.withdraw(5e18, alice, alice);
        assertLe(carry.ltvBps(), 3_000);
        assertEq(weth.balanceOf(alice), 5e18);
    }

    function test_maxWithdraw_respectsSinkLiquidity() public {
        _supplyCarry(alice, DEPOSIT);
        _open(9_000e6);
        morpho.setBorrowed(type(uint256).max); // sink has no withdrawable liquidity
        uint256 max = carry.maxWithdraw(alice);
        // $9,000 debt stays → needs $30,000 of collateral at 30% LTV → nothing free.
        assertEq(max, 0);
        vm.prank(alice);
        vm.expectPartialRevert(ERC4626.ERC4626ExceededMaxWithdraw.selector);
        carry.withdraw(1e18, alice, alice);
    }

    // ─── Safety ──────────────────────────────────────────────────────────────

    function test_anyoneCanDeleverageWhenUnsafe() public {
        _supplyCarry(alice, DEPOSIT);
        _open(9_000e6);
        vm.prank(bob);
        vm.expectPartialRevert(CarryVault.NotUnsafe.selector);
        carry.deleverage(1_000e6);

        oracle.setAnswer(1_800e8); // ETH −40% → LTV 50%
        assertGt(carry.ltvBps(), 4_000);
        vm.prank(bob);
        carry.deleverage(type(uint256).max);
        assertEq(carry.debt(), 0);
        assertEq(carry.ltvBps(), 0);
    }

    function test_pause_blocksDepositsAndOpens_notWithdrawals() public {
        uint256 shares = _supplyCarry(alice, DEPOSIT);
        vm.prank(keeper);
        carry.pause();
        weth.mint(bob, 1e18);
        vm.startPrank(bob);
        weth.approve(address(carry), 1e18);
        vm.expectPartialRevert(ERC4626.ERC4626ExceededMaxDeposit.selector);
        carry.deposit(1e18, bob);
        vm.stopPrank();
        vm.prank(keeper);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        carry.open(address(morpho), 1e6, 0);
        vm.prank(alice);
        carry.redeem(shares, alice, alice);
    }

    function test_admin_bounds() public {
        address notUsdcVault = address(aaveWethPool.aToken());
        vm.startPrank(owner);
        vm.expectRevert(CarryVault.InvalidParam.selector);
        carry.setRisk(5_001, 6_000); // above hard cap
        vm.expectRevert(CarryVault.InvalidParam.selector);
        carry.setRisk(3_000, 3_000); // deleverage threshold must be above max LTV
        vm.expectRevert(); // not a USDC ERC-4626
        carry.setSink(notUsdcVault, 1);
        vm.expectRevert(CarryVault.CannotRescue.selector);
        carry.rescueToken(IERC20(address(usdc)), owner, 1);
        vm.stopPrank();
    }

    function test_removeSink_requiresEmpty() public {
        _supplyCarry(alice, DEPOSIT);
        _open(1_000e6);
        vm.prank(owner);
        vm.expectRevert(CarryVault.SinkNotEmpty.selector);
        carry.removeSink(address(morpho));
        vm.prank(owner);
        carry.removeSink(address(fluid));
        assertEq(carry.sinks().length, 1);
    }

    // ─── Fuzz ────────────────────────────────────────────────────────────────

    /// With sink yield ≥ borrow cost, a depositor never gets back less than they put in (minus rounding),
    /// whatever the size of the carry and the ETH price move within the safe range.
    function testFuzz_positiveCarry_neverLosesCollateral(uint256 borrowSeed, uint256 debtBps, uint256 priceSeed)
        public
    {
        uint256 shares = _supplyCarry(alice, DEPOSIT);
        _open(bound(borrowSeed, 1e6, 9_000e6));
        debtBps = bound(debtBps, 0, 100);
        morpho.accrueWad(debtBps * 1e14 + 1e14); // sink always ≥ 1 bp above the borrow cost
        market.accrueDebtWad(address(usdc), debtBps * 1e14);
        uint256 price = bound(priceSeed, 2_400, 4_000);
        oracle.setAnswer(int256(price * 1e8));

        _closeAndHarvest(price);
        vm.prank(alice);
        uint256 out = carry.redeem(shares, alice, alice);
        assertGe(out, DEPOSIT - 1e12);
        assertEq(carry.debt(), 0);
    }
}
