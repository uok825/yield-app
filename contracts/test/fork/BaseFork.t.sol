// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IAqua} from "@1inch/aqua/interfaces/IAqua.sol";

import {YieldVault} from "../../src/YieldVault.sol";
import {JitLiquidityApp} from "../../src/JitLiquidityApp.sol";
import {YieldResolver} from "../../src/YieldResolver.sol";
import {ERC4626Adapter} from "../../src/adapters/ERC4626Adapter.sol";
import {AaveV3Adapter} from "../../src/adapters/AaveV3Adapter.sol";
import {IAaveV3Pool, IAaveV3AToken} from "../../src/interfaces/IAaveV3.sol";

/// @notice Runs the stack against the real Base deployments: canonical 1inch Aqua, Aave V3, Fluid fUSDC and the
///         Moonwell Flagship USDC Morpho vault. Skipped unless BASE_RPC_URL is set.
///
///   BASE_RPC_URL=https://mainnet.base.org forge test --mc BaseForkTest
contract BaseForkTest is Test {
    IERC20 internal constant USDC = IERC20(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    IAqua internal constant AQUA = IAqua(0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a);
    address internal constant AAVE_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address internal constant AAVE_AUSDC = 0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB;
    address internal constant FLUID_FUSDC = 0xf42f5795D9ac7e9D757dB633D693cD548Cfd9169;
    address internal constant MORPHO_MWUSDC = 0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca;

    address internal owner = makeAddr("owner");
    address internal lp = makeAddr("lp");
    YieldVault internal vault;
    JitLiquidityApp internal app;
    YieldResolver internal resolver;
    JitLiquidityApp.Strategy internal strategy;
    bool internal enabled;

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        enabled = true;

        vault = new YieldVault(USDC, AQUA, owner, owner, 1500, "YieldSolver USDC", "ysUSDC");
        app = new JitLiquidityApp(AQUA);
        resolver = new YieldResolver(AQUA, app, owner, owner);

        vm.startPrank(owner);
        vault.addAdapter(new AaveV3Adapter(address(vault), IAaveV3Pool(AAVE_POOL), IAaveV3AToken(AAVE_AUSDC)));
        vault.addAdapter(new ERC4626Adapter(address(vault), IERC4626(FLUID_FUSDC)));
        vault.addAdapter(new ERC4626Adapter(address(vault), IERC4626(MORPHO_MWUSDC)));
        vault.setLiquidityApp(address(app), true);
        strategy = JitLiquidityApp.Strategy({
            maker: address(vault), token: address(USDC), taker: address(resolver), feeBps: 5, salt: bytes32(0)
        });
        vault.shipStrategy(address(app), abi.encode(strategy), 1e9 * 1e6);
        vm.stopPrank();
    }

    modifier onlyFork() {
        if (!enabled) {
            vm.skip(true);
            return;
        }
        _;
    }

    function test_fork_fullCycle() public onlyFork {
        deal(address(USDC), lp, 100_000e6);
        vm.startPrank(lp);
        USDC.approve(address(vault), type(uint256).max);
        vault.deposit(100_000e6, lp);
        vm.stopPrank();

        vm.startPrank(owner);
        vault.allocate(0, 25_000e6);
        vault.allocate(1, 30_000e6);
        vault.allocate(2, 30_000e6);
        vm.stopPrank();
        assertApproxEqAbs(vault.totalAssets(), 100_000e6, 5); // market rounding

        // Real interest accrues over a day.
        skip(1 days);
        vm.roll(block.number + 43_200);
        assertGt(vault.totalAssets(), 100_000e6 - 5);

        // A resolver that trades nothing would pay the fee from its own inventory: rejected as a loss,
        // and the whole flash (real market unwinds included) rolls back.
        deal(address(USDC), address(resolver), 20e6);
        uint256 before = vault.totalAssets();
        YieldResolver.Call[] memory noCalls;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(YieldResolver.InsufficientProfit.selector, 0, 0));
        resolver.execute(strategy, 40_000e6, noCalls, 0);
        assertEq(vault.totalAssets(), before);

        // LP exits fully through the real markets.
        uint256 shares = vault.balanceOf(lp);
        uint256 maxShares = vault.maxRedeem(lp);
        vm.prank(lp);
        uint256 out = vault.redeem(maxShares, lp, lp);
        assertGt(out, 99_990e6);
        assertEq(maxShares, shares);
    }

    function test_fork_jitUnwindsRealMarkets() public onlyFork {
        deal(address(USDC), lp, 100_000e6);
        vm.startPrank(lp);
        USDC.approve(address(vault), type(uint256).max);
        vault.deposit(100_000e6, lp);
        vm.stopPrank();
        vm.startPrank(owner);
        vault.allocate(0, 25_000e6);
        vault.allocate(1, 30_000e6);
        vault.allocate(2, 30_000e6);
        vm.stopPrank();

        ForkTaker taker = new ForkTaker(AQUA, app);
        JitLiquidityApp.Strategy memory open = strategy;
        open.taker = address(0);
        open.salt = bytes32("open");
        vm.prank(owner);
        vault.shipStrategy(address(app), abi.encode(open), 1e9 * 1e6);

        deal(address(USDC), address(taker), 100e6); // fee buffer
        uint256 before = vault.totalAssets();
        taker.run(open, 50_000e6);

        uint256 fee = 25e6; // 5 bps of 50k
        assertApproxEqAbs(vault.totalAssets(), before + fee, 5);
        assertFalse(vault.isLending());
        // Reserve (15k) + Aave (25k) + 10k from Fluid were unwound; Morpho untouched.
        (, uint256[] memory assets) = vault.positions();
        assertLt(assets[0], 5);
        assertApproxEqAbs(assets[1], 20_000e6, 5);
        assertApproxEqAbs(assets[2], 30_000e6, 5);
    }
}

contract ForkTaker {
    IAqua internal immutable aqua;
    JitLiquidityApp internal immutable app;

    constructor(IAqua aqua_, JitLiquidityApp app_) {
        aqua = aqua_;
        app = app_;
    }

    function run(JitLiquidityApp.Strategy calldata s, uint256 amount) external {
        app.flash(s, amount, address(this), "");
    }

    function onJitLiquidity(address token, uint256 amount, uint256 fee, address maker, bytes32 hash, bytes calldata)
        external
    {
        IERC20(token).approve(address(aqua), amount + fee);
        aqua.push(maker, address(app), hash, token, amount + fee);
    }
}
