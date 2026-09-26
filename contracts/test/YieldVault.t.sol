// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IAqua} from "@1inch/aqua/interfaces/IAqua.sol";

import {Fixture} from "./utils/Fixture.sol";
import {YieldVault} from "../src/YieldVault.sol";
import {ERC4626Adapter} from "../src/adapters/ERC4626Adapter.sol";
import {IYieldAdapter} from "../src/interfaces/IYieldAdapter.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockLendingVault} from "../src/mocks/MockLendingVault.sol";

contract YieldVaultTest is Fixture {
    // ─── Constructor / config ────────────────────────────────────────────────

    function test_constructor_setsConfig() public view {
        assertEq(vault.asset(), address(usdc));
        assertEq(address(vault.AQUA()), address(aqua));
        assertEq(vault.owner(), owner);
        assertEq(vault.keeper(), keeper);
        assertEq(vault.reserveBps(), RESERVE_BPS);
        assertEq(vault.decimals(), 12); // 6 + offset 6
        assertEq(vault.adapterCount(), 3);
        assertEq(usdc.allowance(address(vault), address(aqua)), type(uint256).max);
    }

    function test_constructor_rejectsBadParams() public {
        vm.expectRevert(YieldVault.ZeroAddress.selector);
        new YieldVault(usdc, IAqua(address(0)), owner, keeper, 1500, "n", "s");
        vm.expectRevert(YieldVault.ZeroAddress.selector);
        new YieldVault(usdc, IAqua(address(aqua)), owner, address(0), 1500, "n", "s");
        vm.expectRevert(YieldVault.InvalidBps.selector);
        new YieldVault(usdc, IAqua(address(aqua)), owner, keeper, 10_001, "n", "s");
    }

    // ─── Deposits / withdrawals ──────────────────────────────────────────────

    function test_deposit_mintsShares() public {
        uint256 shares = _deposit(alice, 1_000e6);
        assertEq(shares, 1_000e6 * 1e6);
        assertEq(vault.balanceOf(alice), shares);
        assertEq(vault.totalAssets(), 1_000e6);
        assertEq(vault.idleAssets(), 1_000e6);
    }

    function test_redeem_returnsAssets() public {
        uint256 shares = _deposit(alice, 1_000e6);
        vm.prank(alice);
        uint256 assets = vault.redeem(shares, alice, alice);
        assertEq(assets, 1_000e6);
        assertEq(usdc.balanceOf(alice), 1_000e6);
        assertEq(vault.totalSupply(), 0);
    }

    function test_withdraw_unwindsQueueInOrder() public {
        _seedAllocated(10_000e6); // idle 1500, aave 2500, fluid 3000, morpho 3000

        vm.prank(alice);
        vault.withdraw(5_000e6, alice, alice);

        assertEq(usdc.balanceOf(alice), 5_000e6);
        assertEq(vault.idleAssets(), 0);
        assertEq(aaveAdapter.totalAssets(), 0); // drained first
        assertEq(fluidAdapter.totalAssets(), 2_000e6); // 1000 taken
        assertEq(morphoAdapter.totalAssets(), 3_000e6); // best yield untouched
    }

    function test_withdraw_skipsIlliquidMarket() public {
        _seedAllocated(10_000e6);
        aavePool.borrow(usdc.balanceOf(address(aUsdc)), address(0xdead)); // Aave at 100% utilisation

        vm.prank(alice);
        vault.withdraw(4_000e6, alice, alice);

        assertEq(aaveAdapter.totalAssets(), 2_500e6);
        assertEq(fluidAdapter.totalAssets(), 500e6);
        assertEq(morphoAdapter.totalAssets(), 3_000e6);
    }

    function test_maxWithdraw_boundedByLiquidity() public {
        _seedAllocated(10_000e6);
        morpho.setBorrowed(type(uint256).max);
        assertEq(vault.maxWithdraw(alice), 7_000e6); // idle + aave + fluid
        assertLe(vault.previewRedeem(vault.maxRedeem(alice)), 7_000e6);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxWithdraw.selector, alice, 7_000e6 + 1, 7_000e6)
        );
        vault.withdraw(7_000e6 + 1, alice, alice);
    }

    function test_redeemMax_whenMarketLocked() public {
        _seedAllocated(10_000e6);
        morpho.setBorrowed(type(uint256).max);
        uint256 maxShares = vault.maxRedeem(alice);
        vm.prank(alice);
        uint256 out = vault.redeem(maxShares, alice, alice);
        assertApproxEqAbs(out, 7_000e6, 1);
    }

    function test_yieldAccrual_increasesSharePrice() public {
        _seedAllocated(10_000e6);
        uint256 before = vault.convertToAssets(1e12);
        morpho.accrue(100); // +1% on 3000
        aavePool.accrue(100); // +1% on 2500
        assertApproxEqAbs(vault.totalAssets(), 10_055e6, 2); // aToken index rounding
        assertGt(vault.convertToAssets(1e12), before);

        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        uint256 out = vault.redeem(shares, alice, alice);
        assertApproxEqAbs(out, 10_055e6, 3);
    }

    function test_inflationAttack_isUnprofitable() public {
        // Attacker deposits 1 wei and donates a large amount to skew the share price.
        usdc.mint(bob, 10_000e6 + 1);
        vm.startPrank(bob);
        usdc.approve(address(vault), 1);
        vault.deposit(1, bob);
        usdc.transfer(address(vault), 10_000e6);
        vm.stopPrank();

        uint256 victimShares = _deposit(alice, 1_000e6);
        assertGt(victimShares, 0);
        vm.prank(alice);
        uint256 victimOut = vault.redeem(victimShares, alice, alice);
        assertApproxEqRel(victimOut, 1_000e6, 0.001e18); // victim loses < 0.1%
    }

    // ─── Allocation ──────────────────────────────────────────────────────────

    function test_allocate_movesIdleToMarket() public {
        _deposit(alice, 10_000e6);
        vm.prank(keeper);
        vault.allocate(2, 8_500e6);
        assertEq(morphoAdapter.totalAssets(), 8_500e6);
        assertEq(vault.idleAssets(), 1_500e6);
        assertEq(vault.totalAssets(), 10_000e6);
    }

    function test_allocate_revertsWhenReserveBreached() public {
        _deposit(alice, 10_000e6);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(YieldVault.ReserveBreached.selector, 1_499e6, 1_500e6));
        vault.allocate(2, 8_501e6);
    }

    function test_allocate_onlyKeeperOrOwner() public {
        _deposit(alice, 10_000e6);
        vm.prank(alice);
        vm.expectRevert(YieldVault.OnlyKeeper.selector);
        vault.allocate(0, 1e6);

        vm.prank(owner);
        vault.allocate(0, 1e6);
    }

    function test_allocate_badIndex() public {
        _deposit(alice, 10_000e6);
        vm.prank(keeper);
        vm.expectRevert(YieldVault.IndexOutOfBounds.selector);
        vault.allocate(3, 1e6);
    }

    function test_deallocate_andReallocate() public {
        _seedAllocated(10_000e6);
        vm.startPrank(keeper);
        vault.deallocate(0, 1_000e6);
        assertEq(vault.idleAssets(), 2_500e6);
        vault.reallocate(1, 2, 3_000e6);
        vm.stopPrank();
        assertEq(fluidAdapter.totalAssets(), 0);
        assertEq(morphoAdapter.totalAssets(), 6_000e6);
        assertEq(vault.totalAssets(), 10_000e6);
    }

    function test_positions() public {
        _seedAllocated(10_000e6);
        (address[] memory adapters, uint256[] memory assets) = vault.positions();
        assertEq(adapters.length, 3);
        assertEq(adapters[0], address(aaveAdapter));
        assertEq(assets[0], 2_500e6);
        assertEq(assets[2], 3_000e6);
    }

    // ─── Withdraw queue ──────────────────────────────────────────────────────

    function test_setWithdrawQueue_reorders() public {
        uint256[] memory order = new uint256[](3);
        (order[0], order[1], order[2]) = (2, 0, 1);
        vm.prank(keeper);
        vault.setWithdrawQueue(order);
        assertEq(address(vault.adapterAt(0)), address(morphoAdapter));
        assertEq(address(vault.adapterAt(1)), address(aaveAdapter));
        assertEq(address(vault.adapterAt(2)), address(fluidAdapter));
    }

    function test_setWithdrawQueue_rejectsNonPermutation() public {
        uint256[] memory dup = new uint256[](3);
        (dup[0], dup[1], dup[2]) = (0, 0, 1);
        vm.startPrank(keeper);
        vm.expectRevert(YieldVault.InvalidQueue.selector);
        vault.setWithdrawQueue(dup);

        uint256[] memory oob = new uint256[](3);
        (oob[0], oob[1], oob[2]) = (0, 1, 3);
        vm.expectRevert(YieldVault.InvalidQueue.selector);
        vault.setWithdrawQueue(oob);

        vm.expectRevert(YieldVault.InvalidQueue.selector);
        vault.setWithdrawQueue(new uint256[](2));
        vm.stopPrank();
    }

    // ─── Adapter management ──────────────────────────────────────────────────

    function test_addAdapter_validations() public {
        vm.startPrank(owner);
        vm.expectRevert(YieldVault.AdapterAlreadyAdded.selector);
        vault.addAdapter(morphoAdapter);

        ERC4626Adapter foreign = new ERC4626Adapter(address(0xbeef), IERC4626(address(morpho)));
        vm.expectRevert(YieldVault.InvalidAdapter.selector);
        vault.addAdapter(foreign);

        MockERC20 dai = new MockERC20("Dai", "DAI", 18);
        MockLendingVault daiMarket = new MockLendingVault(dai, "d", "d");
        ERC4626Adapter wrongAsset = new ERC4626Adapter(address(vault), IERC4626(address(daiMarket)));
        vm.expectRevert(YieldVault.InvalidAdapter.selector);
        vault.addAdapter(wrongAsset);
        vm.stopPrank();

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper));
        vault.addAdapter(morphoAdapter);
    }

    function test_addAdapter_capped() public {
        vm.startPrank(owner);
        for (uint256 i; i < 5; ++i) {
            MockLendingVault m = new MockLendingVault(usdc, "m", "m");
            vault.addAdapter(new ERC4626Adapter(address(vault), IERC4626(address(m))));
        }
        MockLendingVault extra = new MockLendingVault(usdc, "m", "m");
        ERC4626Adapter ninth = new ERC4626Adapter(address(vault), IERC4626(address(extra)));
        vm.expectRevert(YieldVault.TooManyAdapters.selector);
        vault.addAdapter(ninth);
        vm.stopPrank();
    }

    function test_removeAdapter_requiresEmpty_andKeepsOrder() public {
        _seedAllocated(10_000e6);
        vm.prank(owner);
        vm.expectRevert(YieldVault.AdapterNotEmpty.selector);
        vault.removeAdapter(0);

        vm.prank(keeper);
        vault.deallocate(0, 2_500e6);
        vm.prank(owner);
        vault.removeAdapter(0);

        assertEq(vault.adapterCount(), 2);
        assertFalse(vault.isAdapter(address(aaveAdapter)));
        assertEq(address(vault.adapterAt(0)), address(fluidAdapter));
        assertEq(address(vault.adapterAt(1)), address(morphoAdapter));
        assertEq(vault.totalAssets(), 10_000e6);
    }

    // ─── Pause / emergency ───────────────────────────────────────────────────

    function test_pause_blocksDepositsButNotWithdrawals() public {
        _seedAllocated(10_000e6);
        vm.prank(keeper);
        vault.pause();

        usdc.mint(bob, 1e6);
        vm.startPrank(bob);
        usdc.approve(address(vault), 1e6);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxDeposit.selector, bob, 1e6, 0));
        vault.deposit(1e6, bob);
        vm.stopPrank();

        vm.prank(keeper);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.allocate(0, 1);

        vm.prank(alice);
        vault.withdraw(9_000e6, alice, alice);
        assertEq(usdc.balanceOf(alice), 9_000e6);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper));
        vault.unpause();
        vm.prank(owner);
        vault.unpause();
        assertFalse(vault.paused());
    }

    function test_emergencyUnwind_pullsEverythingLiquid() public {
        _seedAllocated(10_000e6);
        fluid.setBorrowed(type(uint256).max);
        vm.prank(owner);
        vault.emergencyUnwind();
        assertEq(vault.idleAssets(), 7_000e6);
        assertEq(fluidAdapter.totalAssets(), 3_000e6);
        assertEq(vault.totalAssets(), 10_000e6);
    }

    function test_rescueToken_notAsset() public {
        weth.mint(address(vault), 1e18);
        vm.startPrank(owner);
        vm.expectRevert(YieldVault.CannotRescueAsset.selector);
        vault.rescueToken(IERC20(address(usdc)), owner, 1);
        vault.rescueToken(IERC20(address(weth)), owner, 1e18);
        vm.stopPrank();
        assertEq(weth.balanceOf(owner), 1e18);
    }

    function test_setters() public {
        vm.startPrank(owner);
        vault.setKeeper(bob);
        vault.setReserveBps(2_000);
        vm.expectRevert(YieldVault.InvalidBps.selector);
        vault.setReserveBps(10_001);
        vm.expectRevert(YieldVault.ZeroAddress.selector);
        vault.setKeeper(address(0));
        vm.stopPrank();
        assertEq(vault.keeper(), bob);
        assertEq(vault.reserveBps(), 2_000);
    }

    function test_ownership_isTwoStep() public {
        vm.prank(owner);
        vault.transferOwnership(bob);
        assertEq(vault.owner(), owner);
        vm.prank(bob);
        vault.acceptOwnership();
        assertEq(vault.owner(), bob);
    }

    // ─── JIT hooks access control ────────────────────────────────────────────

    function test_lendLiquidity_onlyApp() public {
        vm.expectRevert(YieldVault.OnlyLiquidityApp.selector);
        vault.lendLiquidity(address(usdc), 1);
        vm.expectRevert(YieldVault.OnlyLiquidityApp.selector);
        vault.settleLiquidity(address(usdc), 1);
    }

    function test_lendLiquidity_wrongToken() public {
        vm.prank(address(app));
        vm.expectRevert(YieldVault.WrongToken.selector);
        vault.lendLiquidity(address(weth), 1);
    }

    function test_settle_withoutLend_reverts() public {
        vm.prank(address(app));
        vm.expectRevert(YieldVault.NotLending.selector);
        vault.settleLiquidity(address(usdc), 1);
    }

    function test_shipStrategy_onlyApprovedApp() public {
        vm.prank(owner);
        vm.expectRevert(YieldVault.OnlyLiquidityApp.selector);
        vault.shipStrategy(address(0xbad), abi.encode(uint256(1)), 1);
    }

    // ─── Fuzz ────────────────────────────────────────────────────────────────

    function testFuzz_depositRedeem_neverProfits(uint96 a, uint96 b) public {
        uint256 amountA = bound(uint256(a), 1, 1e15);
        uint256 amountB = bound(uint256(b), 1, 1e15);
        uint256 sharesA = _deposit(alice, amountA);
        uint256 sharesB = _deposit(bob, amountB);

        vm.prank(bob);
        uint256 outB = vault.redeem(sharesB, bob, bob);
        vm.prank(alice);
        uint256 outA = vault.redeem(sharesA, alice, alice);

        assertLe(outA, amountA);
        assertLe(outB, amountB);
        assertApproxEqAbs(outA, amountA, 1);
        assertApproxEqAbs(outB, amountB, 1);
    }

    function testFuzz_withdraw_fromAnyAllocation(uint256 seed, uint256 withdrawAmount) public {
        uint256 total = 100_000e6;
        _deposit(alice, total);
        uint256 deployable = total - total * RESERVE_BPS / 10_000;
        uint256 a0 = bound(seed, 0, deployable);
        uint256 a1 = bound(uint256(keccak256(abi.encode(seed))), 0, deployable - a0);
        uint256 a2 = deployable - a0 - a1;

        vm.startPrank(keeper);
        if (a0 > 0) vault.allocate(0, a0);
        if (a1 > 0) vault.allocate(1, a1);
        if (a2 > 0) vault.allocate(2, a2);
        vm.stopPrank();

        withdrawAmount = bound(withdrawAmount, 1, total);
        vm.prank(alice);
        vault.withdraw(withdrawAmount, alice, alice);
        assertEq(usdc.balanceOf(alice), withdrawAmount);
        assertEq(vault.totalAssets(), total - withdrawAmount);
    }
}
