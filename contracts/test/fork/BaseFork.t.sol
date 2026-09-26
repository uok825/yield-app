// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";

import {YieldVault} from "../../src/YieldVault.sol";
import {JitLiquidityApp} from "../../src/JitLiquidityApp.sol";
import {OracleSwapApp} from "../../src/OracleSwapApp.sol";
import {YieldResolver} from "../../src/YieldResolver.sol";
import {ERC4626Adapter} from "../../src/adapters/ERC4626Adapter.sol";
import {InventoryVault} from "../../src/InventoryVault.sol";
import {CarryVault} from "../../src/CarryVault.sol";
import {IAaveV3CreditPool, IAaveOracle} from "../../src/interfaces/IAaveV3.sol";
import {IChainlinkAggregator} from "../../src/interfaces/IChainlinkAggregator.sol";
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
        resolver = new YieldResolver(AQUA, app, new OracleSwapApp(AQUA), owner, owner);

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

/// @notice Strategy B against real Base contracts: canonical Aqua, Chainlink ETH/USD, Aave USDC + WETH.
contract BaseInventoryForkTest is Test {
    IERC20 internal constant USDC = IERC20(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    IERC20 internal constant WETH = IERC20(0x4200000000000000000000000000000000000006);
    IAqua internal constant AQUA = IAqua(0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a);
    address internal constant AAVE_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address internal constant AAVE_AUSDC = 0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB;
    address internal constant AAVE_AWETH = 0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7;
    address internal constant CHAINLINK_ETH_USD = 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70;

    address internal owner = makeAddr("owner");
    address internal lp = makeAddr("lp");
    InventoryVault internal inv;
    OracleSwapApp internal swapApp;
    OracleSwapApp.Strategy internal strategy;
    ForkSwapTaker internal taker;
    bool internal enabled;

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        enabled = true;

        swapApp = new OracleSwapApp(AQUA);
        inv = new InventoryVault(
            InventoryVault.Config({
                stable: USDC,
                volatileAsset: WETH,
                aqua: AQUA,
                oracle: IChainlinkAggregator(CHAINLINK_ETH_USD),
                owner: owner,
                keeper: owner,
                targetStableBps: 5_000,
                bandBps: 500,
                maxPriceAge: 1 hours,
                depositFeeBps: 5,
                maxRebalanceLossBps: 50,
                name: "YieldSolver Inventory Balanced",
                symbol: "ysINV-B"
            })
        );
        taker = new ForkSwapTaker(AQUA, swapApp);
        strategy = OracleSwapApp.Strategy({
            maker: address(inv), taker: address(taker), spreadBps: 20, skewBps: 15, maxTradeBps: 2_000, salt: 0
        });

        vm.startPrank(owner);
        inv.setAdapter(
            address(USDC), new AaveV3Adapter(address(inv), IAaveV3Pool(AAVE_POOL), IAaveV3AToken(AAVE_AUSDC))
        );
        inv.setAdapter(
            address(WETH), new AaveV3Adapter(address(inv), IAaveV3Pool(AAVE_POOL), IAaveV3AToken(AAVE_AWETH))
        );
        inv.setSwapApp(address(swapApp), true);
        inv.shipStrategy(address(swapApp), abi.encode(strategy), 1e15, 1e24);
        vm.stopPrank();
    }

    function test_fork_inventoryCycle() public {
        if (!enabled) {
            vm.skip(true);
            return;
        }
        // $100k at 50/50 using the live Chainlink price.
        uint256 p = inv.price();
        uint256 wethIn = uint256(50_000e6) * 1e36 / p;
        deal(address(USDC), lp, 50_000e6);
        deal(address(WETH), lp, wethIn);
        vm.startPrank(lp);
        USDC.approve(address(inv), type(uint256).max);
        WETH.approve(address(inv), type(uint256).max);
        uint256 shares = inv.deposit(50_000e6, wethIn, lp, 1);
        vm.stopPrank();
        assertApproxEqAbs(inv.stableRatioBps(), 5_000, 1);

        // Lend most of both sides on Aave; accrue a day of real interest.
        vm.startPrank(owner);
        inv.allocate(address(USDC), 45_000e6);
        inv.allocate(address(WETH), wethIn * 95 / 100);
        vm.stopPrank();
        skip(1 days);
        vm.mockCall(
            CHAINLINK_ETH_USD,
            abi.encodeWithSelector(IChainlinkAggregator.latestRoundData.selector),
            abi.encode(uint80(1), int256(p * 1e8 / 1e24), block.timestamp, block.timestamp, uint80(1))
        );
        uint256 valueBefore = inv.totalValue();

        // Taker buys 1.5 WETH (more than the 5% left idle → JIT unwind from Aave WETH; ~54% stable, in band).
        uint256 idleWeth = WETH.balanceOf(address(inv));
        assertLt(idleWeth, 1.5e18);
        deal(address(USDC), address(taker), 20_000e6);
        taker.buy(strategy, address(WETH), 1.5e18);
        assertEq(WETH.balanceOf(address(taker)), 1.5e18);

        // A further 1.5 WETH would push USDC past 55%: rejected by the band.
        vm.expectPartialRevert(OracleSwapApp.OutOfBand.selector);
        taker.buy(strategy, address(WETH), 1.5e18);
        assertGe(inv.totalValue(), valueBefore);

        // …and sells 1 WETH back.
        taker.sell(strategy, address(WETH), 1e18);
        assertGe(inv.totalValue(), valueBefore);
        assertFalse(inv.isSwapping());

        // LP exits in kind through the real markets.
        vm.prank(lp);
        (uint256 s, uint256 v) = inv.redeem(shares, lp, lp, 0, 0);
        assertGt(s + inv.volatileValue(v, inv.price()), 99_900e6);
    }
}

contract ForkSwapTaker {
    IAqua internal immutable aqua;
    OracleSwapApp internal immutable app;

    constructor(IAqua aqua_, OracleSwapApp app_) {
        aqua = aqua_;
        app = app_;
    }

    function buy(OracleSwapApp.Strategy calldata s, address tokenOut, uint256 amountOut) external {
        app.swapExactOut(s, tokenOut, amountOut, type(uint256).max, address(this), "");
    }

    function sell(OracleSwapApp.Strategy calldata s, address tokenIn, uint256 amountIn) external {
        app.swapExactIn(s, tokenIn, amountIn, 0, address(this), "");
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
        IERC20(tokenIn).approve(address(aqua), amountIn);
        aqua.push(maker, address(app), hash, tokenIn, amountIn);
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

/// @notice CarryVault against real Base contracts: Aave V3 (WETH collateral, USDC variable debt, Aave oracle) and
///         real Morpho USDC vaults as sinks. Skipped unless BASE_RPC_URL is set.
contract BaseCarryForkTest is Test {
    IERC20 internal constant USDC = IERC20(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    IERC20 internal constant WETH = IERC20(0x4200000000000000000000000000000000000006);
    address internal constant AAVE_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address internal constant AAVE_AWETH = 0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7;
    address internal constant AAVE_USDC_DEBT = 0x59dca05b6c26dbd64b5381374aAaC5CD05644C28;
    address internal constant AAVE_ORACLE = 0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156;
    address internal constant STEAKHOUSE_USDC = 0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183;
    address internal constant GAUNTLET_PRIME_USDC = 0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61;

    address internal owner = makeAddr("owner");
    address internal lp = makeAddr("lp");
    CarryVault internal carry;
    bool internal enabled;

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        enabled = true;
        carry = new CarryVault(
            CarryVault.Config({
                asset: WETH,
                pool: IAaveV3CreditPool(AAVE_POOL),
                aCollateral: IERC20(AAVE_AWETH),
                debtAsset: USDC,
                debtToken: IERC20(AAVE_USDC_DEBT),
                oracle: IAaveOracle(AAVE_ORACLE),
                owner: owner,
                keeper: owner,
                maxLtvBps: 3_000,
                deleverageLtvBps: 4_000,
                name: "YieldSolver Carry WETH",
                symbol: "ycWETH"
            })
        );
        vm.startPrank(owner);
        carry.setSink(STEAKHOUSE_USDC, 10_000_000e6);
        carry.setSink(GAUNTLET_PRIME_USDC, 10_000_000e6);
        vm.stopPrank();
    }

    function test_fork_carryLifecycle() public {
        if (!enabled) {
            vm.skip(true);
            return;
        }
        deal(address(WETH), lp, 10e18);
        vm.startPrank(lp);
        WETH.approve(address(carry), 10e18);
        uint256 shares = carry.deposit(10e18, lp);
        vm.stopPrank();
        assertApproxEqAbs(carry.collateral(), 10e18, 2);

        // Borrow ~28% of collateral value in USDC and park it in Steakhouse (Morpho).
        uint256 ethUsd = IAaveOracle(AAVE_ORACLE).getAssetPrice(address(WETH)); // 8 dp
        uint256 borrow = 10 * ethUsd * 28 / 100 / 100; // USDC 6 dp
        vm.prank(owner);
        carry.open(STEAKHOUSE_USDC, borrow, 0);
        assertLe(carry.ltvBps(), 3_000);

        // A stranger can't touch a healthy position.
        vm.prank(lp);
        vm.expectPartialRevert(CarryVault.NotUnsafe.selector);
        carry.deleverage(1);

        // A day of real Aave borrow interest and real Morpho supply yield.
        skip(1 days);
        vm.roll(block.number + 43_200);
        assertGt(carry.debt(), borrow);
        assertGt(carry.stableHeld(), borrow - 2);

        // Move the stable leg to another Morpho vault.
        uint256 sh = IERC20(STEAKHOUSE_USDC).balanceOf(address(carry));
        vm.prank(owner);
        carry.rotate(STEAKHOUSE_USDC, GAUNTLET_PRIME_USDC, sh);
        assertEq(IERC20(STEAKHOUSE_USDC).balanceOf(address(carry)), 0);

        // ETH halves at the Aave oracle → LTV ~56% → anyone may deleverage.
        vm.mockCall(
            AAVE_ORACLE,
            abi.encodeWithSelector(IAaveOracle.getAssetPrice.selector, address(WETH)),
            abi.encode(ethUsd / 2)
        );
        assertGt(carry.ltvBps(), 4_000);
        vm.prank(lp);
        carry.deleverage(type(uint256).max);
        assertLt(carry.ltvBps(), 100);
        vm.clearMockedCalls();

        // LP exits: everything except the collateral backing any residual (negative-carry) debt.
        uint256 max = carry.maxRedeem(lp);
        vm.prank(lp);
        uint256 out = carry.redeem(max, lp, lp);
        assertGt(out, 9.9e18);
        assertLe(max, shares);
    }
}
