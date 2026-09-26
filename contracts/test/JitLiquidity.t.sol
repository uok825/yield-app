// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";
import {AquaApp} from "@1inch/aqua/src/AquaApp.sol";

import {Fixture} from "./utils/Fixture.sol";
import {YieldVault} from "../src/YieldVault.sol";
import {JitLiquidityApp} from "../src/JitLiquidityApp.sol";
import {YieldResolver} from "../src/YieldResolver.sol";
import {IJitLiquidityCallback} from "../src/interfaces/IJitLiquidity.sol";
import {MockSwapRouter} from "../src/mocks/MockSwapRouter.sol";

/// @dev Configurable taker used to probe the app's and vault's defences.
contract EvilTaker is IJitLiquidityCallback {
    enum Mode {
        RepayExact,
        RepayShort,
        NoRepay,
        DepositDuringFlash,
        WithdrawDuringFlash,
        ReenterFlash
    }

    IAqua public immutable aqua;
    JitLiquidityApp public immutable app;
    YieldVault public immutable vault;
    Mode public mode;
    JitLiquidityApp.Strategy internal strategy;

    constructor(IAqua aqua_, JitLiquidityApp app_, YieldVault vault_) {
        aqua = aqua_;
        app = app_;
        vault = vault_;
    }

    function run(JitLiquidityApp.Strategy calldata s, uint256 amount, Mode m) external {
        mode = m;
        strategy = s;
        app.flash(s, amount, address(this), "");
    }

    function onJitLiquidity(address token, uint256 amount, uint256 fee, address maker, bytes32 hash, bytes calldata)
        external
    {
        if (mode == Mode.RepayShort) {
            _push(token, maker, hash, amount + fee - 1);
        } else if (mode == Mode.NoRepay) {
            return;
        } else if (mode == Mode.DepositDuringFlash) {
            IERC20(token).approve(address(vault), amount);
            vault.deposit(amount, address(this));
        } else if (mode == Mode.WithdrawDuringFlash) {
            vault.withdraw(1, address(this), address(this));
        } else if (mode == Mode.ReenterFlash) {
            app.flash(strategy, 1, address(this), "");
        } else {
            _push(token, maker, hash, amount + fee);
        }
    }

    function _push(address token, address maker, bytes32 hash, uint256 value) internal {
        IERC20(token).approve(address(aqua), value);
        aqua.push(maker, address(app), hash, token, value);
    }
}

/// @dev Stands in for an Aqua app to observe the vault inside a single lending window.
contract LendingProbe {
    YieldVault public immutable vault;
    IERC20 public immutable usdc;
    IAqua public immutable aqua;
    bytes32 public hash;
    bool public wasLending;
    uint256 public assetsMidFlash;
    uint256 public maxDepositMidFlash;
    uint256 public maxWithdrawMidFlash;
    uint256 public maxRedeemMidFlash;

    constructor(YieldVault vault_, IERC20 usdc_) {
        vault = vault_;
        usdc = usdc_;
        aqua = vault_.AQUA();
    }

    function setHash(bytes32 hash_) external {
        hash = hash_;
    }

    function run(uint256 amount) external {
        vault.lendLiquidity(address(usdc), amount);
        aqua.pull(address(vault), hash, address(usdc), amount, address(this));
        wasLending = vault.isLending();
        assetsMidFlash = vault.totalAssets();
        maxDepositMidFlash = vault.maxDeposit(address(1));
        maxWithdrawMidFlash = vault.maxWithdraw(address(1));
        maxRedeemMidFlash = vault.maxRedeem(address(1));
        usdc.transfer(address(vault), amount);
        vault.settleLiquidity(address(usdc), amount);
    }

    function runWithoutRepay(uint256 amount) external {
        vault.lendLiquidity(address(usdc), amount);
        aqua.pull(address(vault), hash, address(usdc), amount, address(this));
        vault.settleLiquidity(address(usdc), amount);
    }

    function runWrongSettle(uint256 amount) external {
        vault.lendLiquidity(address(usdc), amount);
        vault.settleLiquidity(address(usdc), amount - 1);
    }

    function runNested(uint256 amount) external {
        vault.lendLiquidity(address(usdc), amount);
        vault.lendLiquidity(address(usdc), amount);
    }
}

contract JitLiquidityTest is Fixture {
    EvilTaker internal taker;
    JitLiquidityApp.Strategy internal openStrategy;

    function setUp() public override {
        super.setUp();
        taker = new EvilTaker(IAqua(address(aqua)), app, vault);

        openStrategy = JitLiquidityApp.Strategy({
            maker: address(vault), token: address(usdc), taker: address(0), feeBps: FEE_BPS, salt: bytes32("open")
        });
        vm.prank(owner);
        vault.shipStrategy(address(app), abi.encode(openStrategy), BUDGET);
    }

    // ─── Happy path via resolver ─────────────────────────────────────────────

    function test_resolver_fromReserve_paysFeeToVault() public {
        _seedAllocated(10_000e6);
        uint256 amount = 1_000e6; // fits in 1,500 reserve
        YieldResolver.Call[] memory calls = _arbCalls(amount, 30);

        uint256 aaveBefore = aaveAdapter.totalAssets();
        vm.prank(operator);
        uint256 profit = resolver.execute(strategy, amount, calls, 0);

        uint256 fee = amount * FEE_BPS / 10_000; // 0.5 USDC
        assertEq(vault.totalAssets(), 10_000e6 + fee);
        assertEq(vault.idleAssets(), 1_500e6 + fee);
        assertEq(aaveAdapter.totalAssets(), aaveBefore); // no unwind needed
        assertApproxEqAbs(profit, amount * 30 / 10_000 - fee, 1); // router rounding
        assertEq(usdc.balanceOf(address(resolver)), profit);
        assertFalse(vault.isLending());
        assertEq(app.available(strategy), BUDGET + fee);
    }

    function test_resolver_unwindsLowestYieldFirst() public {
        _seedAllocated(10_000e6); // idle 1500, aave 2500, fluid 3000, morpho 3000
        uint256 amount = 5_000e6;
        YieldResolver.Call[] memory calls = _arbCalls(amount, 20);

        vm.prank(operator);
        resolver.execute(strategy, amount, calls, 1);

        uint256 fee = 2_500_000;
        assertEq(aaveAdapter.totalAssets(), 0);
        assertEq(fluidAdapter.totalAssets(), 2_000e6);
        assertEq(morphoAdapter.totalAssets(), 3_000e6);
        assertEq(vault.idleAssets(), 5_000e6 + fee); // principal lands idle; keeper re-allocates later
        assertEq(vault.totalAssets(), 10_000e6 + fee);
    }

    function test_resolver_feeRaisesSharePrice() public {
        _seedAllocated(10_000e6);
        uint256 priceBefore = vault.convertToAssets(1e12);
        YieldResolver.Call[] memory calls = _arbCalls(8_000e6, 50);
        vm.prank(operator);
        resolver.execute(strategy, 8_000e6, calls, 0);
        assertGt(vault.convertToAssets(1e12), priceBefore);

        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        uint256 out = vault.redeem(shares, alice, alice);
        assertApproxEqAbs(out, 10_000e6 + 4e6, 1);
    }

    function test_resolver_minProfitEnforced() public {
        _seedAllocated(10_000e6);
        YieldResolver.Call[] memory calls = _arbCalls(1_000e6, 30);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(YieldResolver.InsufficientProfit.selector, 2.5e6 - 1, 3e6));
        resolver.execute(strategy, 1_000e6, calls, 3e6);
    }

    function test_resolver_losingTradeReverts() public {
        _seedAllocated(10_000e6);
        YieldResolver.Call[] memory calls = _arbCalls(1_000e6, 0); // no edge, cannot cover fee
        vm.prank(operator);
        vm.expectRevert(); // resolver cannot fund the Aqua push
        resolver.execute(strategy, 1_000e6, calls, 0);
        assertEq(vault.totalAssets(), 10_000e6);
    }

    function test_resolver_usesOwnInventoryForFee() public {
        _seedAllocated(10_000e6);
        usdc.mint(address(resolver), 10e6); // pre-funded buffer
        YieldResolver.Call[] memory calls = _arbCalls(1_000e6, 0);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(YieldResolver.InsufficientProfit.selector, 0, 0));
        resolver.execute(strategy, 1_000e6, calls, 0); // net loss of the fee is rejected
    }

    // ─── Resolver access control ─────────────────────────────────────────────

    function test_resolver_onlyOperator() public {
        YieldResolver.Call[] memory calls;
        vm.prank(alice);
        vm.expectRevert(YieldResolver.OnlyOperator.selector);
        resolver.execute(strategy, 1, calls, 0);
    }

    function test_resolver_targetWhitelist() public {
        _seedAllocated(10_000e6);
        YieldResolver.Call[] memory calls = new YieldResolver.Call[](1);
        calls[0] = YieldResolver.Call(address(usdc), 0, abi.encodeCall(IERC20.transfer, (alice, 1)));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(YieldResolver.TargetNotAllowed.selector, address(usdc)));
        resolver.execute(strategy, 1_000e6, calls, 0);
    }

    function test_resolver_callbackOnlyFromAppDuringExecute() public {
        vm.expectRevert(YieldResolver.OnlyApp.selector);
        resolver.onJitLiquidity(address(usdc), 1, 0, address(vault), strategyHash, "");

        vm.prank(address(app));
        vm.expectRevert(YieldResolver.NotExecuting.selector);
        resolver.onJitLiquidity(address(usdc), 1, 0, address(vault), strategyHash, "");
    }

    function test_resolver_ownerAdmin() public {
        vm.startPrank(owner);
        resolver.setOperator(bob, true);
        assertTrue(resolver.isOperator(bob));
        resolver.setOperator(bob, false);
        vm.expectRevert(YieldResolver.ZeroAddress.selector);
        resolver.setTarget(address(0), true);
        vm.stopPrank();

        usdc.mint(address(resolver), 5e6);
        vm.deal(address(resolver), 1 ether);
        vm.startPrank(owner);
        resolver.sweep(usdc, owner, 5e6);
        resolver.sweepNative(payable(owner), 1 ether);
        vm.stopPrank();
        assertEq(usdc.balanceOf(owner), 5e6);
        assertEq(owner.balance, 1 ether);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        resolver.sweep(usdc, operator, 1);
    }

    // ─── App-level defences ──────────────────────────────────────────────────

    function test_flash_exclusiveTaker() public {
        _seedAllocated(10_000e6);
        vm.expectRevert(
            abi.encodeWithSelector(JitLiquidityApp.UnauthorizedTaker.selector, address(taker), address(resolver))
        );
        taker.run(strategy, 1e6, EvilTaker.Mode.RepayExact);
    }

    function test_flash_openStrategy_repayExact() public {
        _seedAllocated(10_000e6);
        usdc.mint(address(taker), 1e6); // to cover fee
        taker.run(openStrategy, 2_000e6, EvilTaker.Mode.RepayExact);
        assertEq(vault.totalAssets(), 10_000e6 + 1e6);
    }

    function test_flash_repayShort_reverts() public {
        _seedAllocated(10_000e6);
        usdc.mint(address(taker), 1e6);
        uint256 fee = 1e6;
        vm.expectRevert(
            abi.encodeWithSelector(AquaApp.MissingTakerAquaPush.selector, address(usdc), BUDGET + fee - 1, BUDGET + fee)
        );
        taker.run(openStrategy, 2_000e6, EvilTaker.Mode.RepayShort);
    }

    function test_flash_noRepay_reverts() public {
        _seedAllocated(10_000e6);
        vm.expectRevert(
            abi.encodeWithSelector(AquaApp.MissingTakerAquaPush.selector, address(usdc), BUDGET - 2_000e6, BUDGET + 1e6)
        );
        taker.run(openStrategy, 2_000e6, EvilTaker.Mode.NoRepay);
    }

    function test_flash_depositDuringFlash_blocked() public {
        _seedAllocated(10_000e6);
        vm.expectRevert(); // ERC4626ExceededMaxDeposit (maxDeposit = 0 while lending)
        taker.run(openStrategy, 2_000e6, EvilTaker.Mode.DepositDuringFlash);
    }

    function test_flash_withdrawDuringFlash_blocked() public {
        _seedAllocated(10_000e6);
        vm.expectRevert();
        taker.run(openStrategy, 2_000e6, EvilTaker.Mode.WithdrawDuringFlash);
    }

    function test_flash_reentrancy_blocked() public {
        _seedAllocated(10_000e6);
        vm.expectRevert();
        taker.run(openStrategy, 2_000e6, EvilTaker.Mode.ReenterFlash);
    }

    function test_flash_totalAssetsStableDuringLending() public {
        // Outstanding principal is counted, so share price cannot be read low mid-flash,
        // and user entry points are closed while the window is open.
        _seedAllocated(10_000e6);
        LendingProbe probe = new LendingProbe(vault, usdc);
        vm.startPrank(owner);
        vault.setLiquidityApp(address(probe), true);
        probe.setHash(vault.shipStrategy(address(probe), "probe", BUDGET));
        vm.stopPrank();

        probe.run(3_000e6);
        assertTrue(probe.wasLending());
        assertEq(probe.assetsMidFlash(), 10_000e6);
        assertEq(probe.maxDepositMidFlash(), 0);
        assertEq(probe.maxWithdrawMidFlash(), 0);
        assertEq(probe.maxRedeemMidFlash(), 0);
        assertFalse(vault.isLending());
        assertEq(vault.totalAssets(), 10_000e6);
    }

    function test_settle_requiresRepayment() public {
        _seedAllocated(10_000e6);
        LendingProbe probe = new LendingProbe(vault, usdc);
        vm.startPrank(owner);
        vault.setLiquidityApp(address(probe), true);
        probe.setHash(vault.shipStrategy(address(probe), "probe", BUDGET));
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(YieldVault.LiquidityNotReturned.selector, 0, 3_000e6));
        probe.runWithoutRepay(3_000e6);

        vm.expectRevert(YieldVault.LentAmountMismatch.selector);
        probe.runWrongSettle(3_000e6);

        vm.expectRevert(YieldVault.LendingActive.selector);
        probe.runNested(1e6);
    }

    function test_flash_overBudget_reverts() public {
        JitLiquidityApp.Strategy memory small = openStrategy;
        small.salt = bytes32("small");
        vm.prank(owner);
        vault.shipStrategy(address(app), abi.encode(small), 100e6);
        _seedAllocated(10_000e6);
        usdc.mint(address(taker), 1e6);
        vm.expectRevert(); // Aqua balance underflow
        taker.run(small, 101e6, EvilTaker.Mode.RepayExact);
    }

    function test_flash_insufficientVaultLiquidity_reverts() public {
        _seedAllocated(10_000e6);
        morpho.setBorrowed(type(uint256).max);
        usdc.mint(address(taker), 10e6);
        vm.expectRevert(abi.encodeWithSelector(YieldVault.InsufficientLiquidity.selector, 7_000e6 + 1, 7_000e6));
        taker.run(openStrategy, 7_000e6 + 1, EvilTaker.Mode.RepayExact);
    }

    function test_flash_pausedVault_reverts() public {
        _seedAllocated(10_000e6);
        vm.prank(keeper);
        vault.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        taker.run(openStrategy, 1e6, EvilTaker.Mode.RepayExact);
    }

    function test_flash_revokedApp_reverts() public {
        _seedAllocated(10_000e6);
        vm.prank(owner);
        vault.setLiquidityApp(address(app), false);
        vm.expectRevert(YieldVault.OnlyLiquidityApp.selector);
        taker.run(openStrategy, 1e6, EvilTaker.Mode.RepayExact);
    }

    function test_flash_dockedStrategy_reverts() public {
        _seedAllocated(10_000e6);
        bytes32 openHash = app.strategyHash(openStrategy);
        vm.prank(owner);
        vault.dockStrategy(address(app), openHash);
        assertEq(app.available(openStrategy), 0);
        vm.expectRevert();
        taker.run(openStrategy, 1e6, EvilTaker.Mode.RepayExact);
    }

    function test_flash_zeroAmount_andFeeCap() public {
        vm.expectRevert(JitLiquidityApp.ZeroAmount.selector);
        taker.run(openStrategy, 0, EvilTaker.Mode.RepayExact);

        JitLiquidityApp.Strategy memory greedy = openStrategy;
        greedy.feeBps = 1_001;
        vm.expectRevert(abi.encodeWithSelector(JitLiquidityApp.InvalidFee.selector, 1_001));
        taker.run(greedy, 1, EvilTaker.Mode.RepayExact);
    }

    function test_flashFee_roundsUp() public view {
        assertEq(app.flashFee(openStrategy, 1), 1);
        assertEq(app.flashFee(openStrategy, 2_000e6), 1e6);
    }

    // ─── Fuzz ────────────────────────────────────────────────────────────────

    function testFuzz_flash_vaultNeverLoses(uint256 amount, uint16 edgeBps) public {
        _seedAllocated(100_000e6);
        amount = bound(amount, 1e6, 100_000e6);
        edgeBps = uint16(bound(edgeBps, 6, 500)); // must beat the 5 bps fee
        YieldResolver.Call[] memory calls = _arbCalls(amount, edgeBps);
        uint256 before = vault.totalAssets();

        vm.prank(operator);
        resolver.execute(strategy, amount, calls, 0);

        assertEq(vault.totalAssets(), before + app.flashFee(strategy, amount));
        assertFalse(vault.isLending());
    }
}
