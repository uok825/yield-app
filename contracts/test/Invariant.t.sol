// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Fixture} from "./utils/Fixture.sol";
import {YieldVault} from "../src/YieldVault.sol";
import {JitLiquidityApp} from "../src/JitLiquidityApp.sol";
import {YieldResolver} from "../src/YieldResolver.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockLendingVault} from "../src/mocks/MockLendingVault.sol";
import {MockAavePool} from "../src/mocks/MockAavePool.sol";
import {MockSwapRouter} from "../src/mocks/MockSwapRouter.sol";

/// @dev Drives random sequences of user, keeper, market and resolver actions.
contract VaultHandler is Test {
    YieldVault internal vault;
    MockERC20 internal usdc;
    MockERC20 internal weth;
    MockLendingVault internal morpho;
    MockAavePool internal aavePool;
    YieldResolver internal resolver;
    MockSwapRouter internal router;
    JitLiquidityApp.Strategy internal strategy;
    address internal keeper;
    address internal operator;

    address[] public actors;
    uint256 public feesPaid;
    uint256 public interestAccrued;
    uint256 public deposited;
    uint256 public withdrawn;

    constructor(
        YieldVault vault_,
        MockERC20 usdc_,
        MockERC20 weth_,
        MockLendingVault morpho_,
        MockAavePool aavePool_,
        YieldResolver resolver_,
        MockSwapRouter router_,
        JitLiquidityApp.Strategy memory strategy_,
        address keeper_,
        address operator_
    ) {
        (vault, usdc, weth, morpho, aavePool, resolver, router) =
        (vault_, usdc_, weth_, morpho_, aavePool_, resolver_, router_);
        strategy = strategy_;
        keeper = keeper_;
        operator = operator_;
        for (uint256 i; i < 3; ++i) {
            actors.push(address(uint160(0x1000 + i)));
        }
        router.setPrice(address(usdc), address(weth), uint256(1e30) / 3000);
        router.setPrice(address(weth), address(usdc), 3000e6 * 10_020 / 10_000);
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function deposit(uint256 seed, uint256 amount) external {
        amount = bound(amount, 1e6, 1_000_000e6);
        address a = _actor(seed);
        usdc.mint(a, amount);
        vm.startPrank(a);
        usdc.approve(address(vault), amount);
        vault.deposit(amount, a);
        vm.stopPrank();
        deposited += amount;
    }

    function redeem(uint256 seed, uint256 shares) external {
        address a = _actor(seed);
        uint256 max = vault.maxRedeem(a);
        if (max == 0) return;
        shares = bound(shares, 1, max);
        vm.prank(a);
        uint256 out = vault.redeem(shares, a, a);
        withdrawn += out;
    }

    function allocate(uint256 idx, uint256 amount) external {
        idx = bound(idx, 0, 2);
        uint256 idle = vault.idleAssets();
        uint256 target = vault.reserveTarget();
        if (idle <= target) return;
        amount = bound(amount, 1, idle - target);
        vm.prank(keeper);
        vault.allocate(idx, amount);
    }

    function deallocate(uint256 idx, uint256 amount) external {
        idx = bound(idx, 0, 2);
        uint256 max = vault.adapterAt(idx).maxWithdraw();
        if (max == 0) return;
        amount = bound(amount, 1, max);
        vm.prank(keeper);
        vault.deallocate(idx, amount);
    }

    function accrue(uint256 bps) external {
        bps = bound(bps, 0, 50);
        uint256 before = vault.totalAssets();
        morpho.accrue(bps);
        aavePool.accrue(bps);
        interestAccrued += vault.totalAssets() - before;
    }

    function flash(uint256 amount) external {
        uint256 liquidity = vault.availableLiquidity();
        if (liquidity < 1e6) return;
        amount = bound(amount, 1e6, liquidity);
        uint256 wethOut = router.quote(address(usdc), address(weth), amount);
        YieldResolver.Call[] memory calls = new YieldResolver.Call[](2);
        calls[0] = YieldResolver.Call(
            address(router),
            0,
            abi.encodeCall(MockSwapRouter.swap, (address(usdc), address(weth), amount, 0, address(resolver)))
        );
        calls[1] = YieldResolver.Call(
            address(router),
            0,
            abi.encodeCall(MockSwapRouter.swap, (address(weth), address(usdc), wethOut, 0, address(resolver)))
        );
        uint256 before = vault.totalAssets();
        vm.prank(operator);
        resolver.execute(strategy, amount, calls, 0);
        feesPaid += vault.totalAssets() - before;
    }
}

contract VaultInvariantTest is Fixture {
    VaultHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new VaultHandler(vault, usdc, weth, morpho, aavePool, resolver, router, strategy, keeper, operator);
        targetContract(address(handler));
    }

    /// Accounting: totalAssets is exactly idle + market positions once no lending window is open.
    function invariant_totalAssetsMatchesHoldings() public view {
        (, uint256[] memory assets) = vault.positions();
        uint256 sum = usdc.balanceOf(address(vault));
        for (uint256 i; i < assets.length; ++i) {
            sum += assets[i];
        }
        assertEq(vault.totalAssets(), sum);
        assertFalse(vault.isLending());
    }

    /// Solvency: all shares together never claim more than the vault holds.
    function invariant_solvent() public view {
        assertLe(vault.convertToAssets(vault.totalSupply()), vault.totalAssets());
    }

    /// Value: the vault only grows from deposits, interest and JIT fees; flashes never lose money.
    function invariant_valueConserved() public view {
        uint256 inflows = handler.deposited() + handler.interestAccrued() + handler.feesPaid();
        uint256 accounted = vault.totalAssets() + handler.withdrawn();
        assertLe(accounted, inflows); // nothing is created out of thin air
        assertApproxEqAbs(accounted, inflows, 100); // at most wei-level rounding dust (Aave ceil-burn) is lost
    }
}
