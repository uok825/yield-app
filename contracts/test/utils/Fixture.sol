// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IAqua} from "@1inch/aqua/interfaces/IAqua.sol";
import {Aqua} from "@1inch/aqua/Aqua.sol";

import {YieldVault} from "../../src/YieldVault.sol";
import {JitLiquidityApp} from "../../src/JitLiquidityApp.sol";
import {YieldResolver} from "../../src/YieldResolver.sol";
import {ERC4626Adapter} from "../../src/adapters/ERC4626Adapter.sol";
import {AaveV3Adapter} from "../../src/adapters/AaveV3Adapter.sol";
import {IAaveV3Pool, IAaveV3AToken} from "../../src/interfaces/IAaveV3.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockLendingVault} from "../../src/mocks/MockLendingVault.sol";
import {MockAavePool, MockAToken} from "../../src/mocks/MockAavePool.sol";
import {MockSwapRouter} from "../../src/mocks/MockSwapRouter.sol";

/// @notice Full local stack: real Aqua, mock markets, vault with 3 adapters, JIT app and resolver.
abstract contract Fixture is Test {
    uint16 internal constant RESERVE_BPS = 1500;
    uint16 internal constant FEE_BPS = 5;
    uint256 internal constant BUDGET = 1_000_000_000e6;

    address internal owner = makeAddr("owner");
    address internal keeper = makeAddr("keeper");
    address internal operator = makeAddr("operator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    MockERC20 internal usdc;
    MockERC20 internal weth;
    Aqua internal aqua;

    MockLendingVault internal morpho;
    MockLendingVault internal fluid;
    MockAavePool internal aavePool;
    MockAToken internal aUsdc;

    YieldVault internal vault;
    ERC4626Adapter internal morphoAdapter;
    ERC4626Adapter internal fluidAdapter;
    AaveV3Adapter internal aaveAdapter;

    JitLiquidityApp internal app;
    YieldResolver internal resolver;
    MockSwapRouter internal router;
    JitLiquidityApp.Strategy internal strategy;
    bytes32 internal strategyHash;

    function setUp() public virtual {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        aqua = new Aqua();

        morpho = new MockLendingVault(usdc, "Mock Morpho USDC", "mmUSDC");
        fluid = new MockLendingVault(usdc, "Mock Fluid USDC", "fUSDC");
        aavePool = new MockAavePool(usdc);
        aUsdc = aavePool.aToken();

        vault = new YieldVault(usdc, IAqua(address(aqua)), owner, keeper, RESERVE_BPS, "YieldSolver USDC", "ysUSDC");
        morphoAdapter = new ERC4626Adapter(address(vault), IERC4626(address(morpho)));
        aaveAdapter = new AaveV3Adapter(address(vault), IAaveV3Pool(address(aavePool)), IAaveV3AToken(address(aUsdc)));
        fluidAdapter = new ERC4626Adapter(address(vault), IERC4626(address(fluid)));

        app = new JitLiquidityApp(IAqua(address(aqua)));
        resolver = new YieldResolver(IAqua(address(aqua)), app, owner, operator);
        router = new MockSwapRouter();

        vm.startPrank(owner);
        // Withdraw queue: Aave (lowest APY) → Fluid → Morpho (highest APY).
        vault.addAdapter(aaveAdapter);
        vault.addAdapter(fluidAdapter);
        vault.addAdapter(morphoAdapter);
        vault.setLiquidityApp(address(app), true);

        strategy = JitLiquidityApp.Strategy({
            maker: address(vault), token: address(usdc), taker: address(resolver), feeBps: FEE_BPS, salt: bytes32(0)
        });
        strategyHash = vault.shipStrategy(address(app), abi.encode(strategy), BUDGET);

        resolver.setTarget(address(router), true);
        resolver.approveToken(usdc, address(router), type(uint256).max);
        resolver.approveToken(weth, address(router), type(uint256).max);
        vm.stopPrank();

        vm.label(address(vault), "YieldVault");
        vm.label(address(aqua), "Aqua");
        vm.label(address(app), "JitLiquidityApp");
        vm.label(address(resolver), "YieldResolver");
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _deposit(address user, uint256 assets) internal returns (uint256 shares) {
        usdc.mint(user, assets);
        vm.startPrank(user);
        usdc.approve(address(vault), assets);
        shares = vault.deposit(assets, user);
        vm.stopPrank();
    }

    /// @dev Deposits `total` and spreads 85% across markets: Aave 25%, Fluid 30%, Morpho 30%.
    function _seedAllocated(uint256 total) internal {
        _deposit(alice, total);
        vm.startPrank(keeper);
        vault.allocate(0, total * 25 / 100);
        vault.allocate(1, total * 30 / 100);
        vault.allocate(2, total * 30 / 100);
        vm.stopPrank();
    }

    /// @dev Round-trip USDC → WETH → USDC through the router with a `edgeBps` gain on the way back.
    function _arbCalls(uint256 amount, uint256 edgeBps) internal returns (YieldResolver.Call[] memory calls) {
        router.setPrice(address(usdc), address(weth), uint256(1e30) / 3000); // 3000 USDC per WETH
        router.setPrice(address(weth), address(usdc), 3000 * 1e6 * (10_000 + edgeBps) / 10_000); // per 1e18 WETH
        uint256 wethOut = router.quote(address(usdc), address(weth), amount);

        calls = new YieldResolver.Call[](2);
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
    }
}
