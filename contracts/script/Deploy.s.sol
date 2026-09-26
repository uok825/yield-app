// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";
import {Aqua} from "@1inch/aqua/src/Aqua.sol";

import {YieldVault} from "../src/YieldVault.sol";
import {InventoryVault} from "../src/InventoryVault.sol";
import {JitLiquidityApp} from "../src/JitLiquidityApp.sol";
import {OracleSwapApp} from "../src/OracleSwapApp.sol";
import {YieldResolver} from "../src/YieldResolver.sol";
import {ERC4626Adapter} from "../src/adapters/ERC4626Adapter.sol";
import {AaveV3Adapter} from "../src/adapters/AaveV3Adapter.sol";
import {IYieldAdapter} from "../src/interfaces/IYieldAdapter.sol";
import {IAaveV3Pool, IAaveV3AToken} from "../src/interfaces/IAaveV3.sol";
import {IChainlinkAggregator} from "../src/interfaces/IChainlinkAggregator.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockLendingVault} from "../src/mocks/MockLendingVault.sol";
import {MockAavePool} from "../src/mocks/MockAavePool.sol";
import {MockSwapRouter} from "../src/mocks/MockSwapRouter.sol";
import {MockOracle} from "../src/mocks/MockOracle.sol";
import {MockOrderBook} from "../src/mocks/MockOrderBook.sol";

/// @title Deploy
/// @notice Deploys both YieldSolver strategies and the shared resolver.
///
///  Strategy A · Yield + JIT: YieldVault (USDC) over Aave / Fluid / Morpho, lending JIT via JitLiquidityApp.
///  Strategy B · Inventory MM: three InventoryVault profiles (USDC/WETH 70/30, 50/50, 30/70, ±5pp band) quoting via
///  OracleSwapApp, idle inventory lent on Aave USDC / Aave WETH.
///
///  Mock mode (no `USDC` env var, e.g. Base Sepolia): deploys test USDC/WETH, ERC-4626 markets, Aave-like pools for
///  USDC and WETH, a settable Chainlink-style oracle, a fixed-price router and an order book, so every flow can be
///  exercised on a testnet.
///
///  Live mode (`USDC` set): real markets from env — MORPHO_VAULT, FLUID_VAULT, AAVE_POOL + AAVE_ATOKEN for A;
///  WETH, ORACLE (defaults to Chainlink ETH/USD on Base), AAVE_WETH_ATOKEN for B. Without WETH, B is skipped.
///
///  1inch Fusion: mock mode deploys the official LOP v4 + SimpleSettlement (unmodified submodules). Live mode on
///  Base uses the canonical deployments (override with LIMIT_ORDER_PROTOCOL / FUSION_SETTLEMENT).
///
///  Aqua: `AQUA` if set, else the canonical 1inch deployment if it has code on this chain, else a fresh one.
///
///  Optional: OWNER, KEEPER, OPERATOR (default: deployer), RESERVE_BPS (1500), FLASH_FEE_BPS (5), SPREAD_BPS (10),
///  SKEW_BPS (8), MAX_TRADE_BPS (2000), BAND_BPS (500), DEPOSIT_FEE_BPS (5), PRICE_MAX_AGE (3600; 365 days in
///  mock mode), MAX_REBALANCE_LOSS_BPS (50).
///
///    forge script script/Deploy.s.sol --rpc-url base_sepolia --account <keystore> --broadcast --verify
contract Deploy is Script {
    address internal constant CANONICAL_AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
    address internal constant CHAINLINK_ETH_USD_BASE = 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70;
    address internal constant LOP_BASE = 0x111111125421cA6dc452d289314280a0f8842A65;
    address internal constant FUSION_SETTLEMENT_BASE = 0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5;

    struct Deployment {
        bool mock;
        address usdc;
        address weth;
        address aqua;
        // Strategy A
        address vault;
        address app;
        address[] adapters;
        bytes32 strategyHash;
        address morphoMarket;
        address fluidMarket;
        address aavePool;
        address aaveAToken;
        // Strategy B
        address oracle;
        address swapApp;
        address aaveWethPool;
        address aaveWethAToken;
        address[] inventoryVaults;
        bytes32[] inventoryStrategyHashes;
        // Shared
        address resolver;
        address router;
        address orderBook;
        // 1inch Fusion (LOP v4 + SimpleSettlement)
        address limitOrderProtocol;
        address fusionSettlement;
        address fusionAccessToken;
    }

    struct Params {
        address deployer;
        address owner;
        address keeper;
        address operator;
        uint16 reserveBps;
        uint16 feeBps;
        uint16 spreadBps;
        uint16 skewBps;
        uint16 maxTradeBps;
        uint16 bandBps;
        uint16 depositFeeBps;
        uint16 maxRebalanceLossBps;
        uint32 priceMaxAge;
    }

    uint16[3] internal PROFILES = [7_000, 5_000, 3_000];
    string[3] internal PROFILE_NAMES = ["Stable 70/30", "Balanced 50/50", "ETH-heavy 30/70"];
    string[3] internal PROFILE_SYMBOLS = ["ysINV-S", "ysINV-B", "ysINV-E"];

    function run() external returns (Deployment memory d) {
        d.usdc = vm.envOr("USDC", address(0));
        d.mock = d.usdc == address(0);
        Params memory p = _params(d.mock);

        vm.startBroadcast();
        _deployAqua(d);
        if (d.mock) _deployMocks(d);
        else _readLive(d);

        d.app = address(new JitLiquidityApp(IAqua(d.aqua)));
        d.swapApp = address(new OracleSwapApp(IAqua(d.aqua)));
        d.resolver = address(
            new YieldResolver(IAqua(d.aqua), JitLiquidityApp(d.app), OracleSwapApp(d.swapApp), p.deployer, p.operator)
        );

        _deployStrategyA(d, p);
        if (d.weth != address(0) && d.oracle != address(0)) _deployStrategyB(d, p);
        _wireResolver(d);
        _handOver(d, p);
        vm.stopBroadcast();

        _log(d, p);
        _write(d, p);
    }

    // ─── Setup ───────────────────────────────────────────────────────────────

    function _params(bool mock) internal view returns (Params memory p) {
        p.deployer = msg.sender;
        p.owner = vm.envOr("OWNER", msg.sender);
        p.keeper = vm.envOr("KEEPER", msg.sender);
        p.operator = vm.envOr("OPERATOR", msg.sender);
        p.reserveBps = uint16(vm.envOr("RESERVE_BPS", uint256(1500)));
        p.feeBps = uint16(vm.envOr("FLASH_FEE_BPS", uint256(5)));
        p.spreadBps = uint16(vm.envOr("SPREAD_BPS", uint256(10)));
        p.skewBps = uint16(vm.envOr("SKEW_BPS", uint256(8)));
        p.maxTradeBps = uint16(vm.envOr("MAX_TRADE_BPS", uint256(2000)));
        p.bandBps = uint16(vm.envOr("BAND_BPS", uint256(500)));
        p.depositFeeBps = uint16(vm.envOr("DEPOSIT_FEE_BPS", uint256(5)));
        p.maxRebalanceLossBps = uint16(vm.envOr("MAX_REBALANCE_LOSS_BPS", uint256(50)));
        p.priceMaxAge = uint32(vm.envOr("PRICE_MAX_AGE", mock ? uint256(365 days) : uint256(1 hours)));
        require(p.skewBps <= p.spreadBps, "SKEW_BPS must be <= SPREAD_BPS");
    }

    function _deployAqua(Deployment memory d) internal {
        d.aqua = vm.envOr("AQUA", address(0));
        if (d.aqua == address(0)) {
            d.aqua = CANONICAL_AQUA.code.length > 0 ? CANONICAL_AQUA : address(new Aqua());
        }
    }

    function _deployMocks(Deployment memory d) internal {
        MockERC20 usdc = new MockERC20("Test USD Coin", "USDC", 6);
        MockERC20 weth = new MockERC20("Test Wrapped Ether", "WETH", 18);
        (d.usdc, d.weth) = (address(usdc), address(weth));

        d.morphoMarket = address(new MockLendingVault(usdc, "Mock Morpho USDC", "mmUSDC"));
        d.fluidMarket = address(new MockLendingVault(usdc, "Mock Fluid USDC", "mfUSDC"));
        MockAavePool usdcPool = new MockAavePool(usdc);
        (d.aavePool, d.aaveAToken) = (address(usdcPool), address(usdcPool.aToken()));
        MockAavePool wethPool = new MockAavePool(weth);
        (d.aaveWethPool, d.aaveWethAToken) = (address(wethPool), address(wethPool.aToken()));

        d.oracle = address(new MockOracle(8, 3_000e8, msg.sender));
        MockSwapRouter router = new MockSwapRouter();
        d.router = address(router);
        router.setPrice(d.usdc, d.weth, uint256(1e30) / 3000); // 3000 USDC / WETH
        router.setPrice(d.weth, d.usdc, 3006e6); // +0.2% on the way back
        d.orderBook = address(new MockOrderBook());

        // Official, unmodified 1inch LOP v4 + Fusion SimpleSettlement (1inch has no testnet deployment).
        d.limitOrderProtocol = deployCode("LimitOrderProtocol.sol:LimitOrderProtocol", abi.encode(d.weth));
        d.fusionAccessToken = address(new MockERC20("Fusion Access Token", "FAT", 0));
        d.fusionSettlement = deployCode(
            "SimpleSettlement.sol:SimpleSettlement",
            abi.encode(d.limitOrderProtocol, d.fusionAccessToken, d.weth, msg.sender)
        );
    }

    function _readLive(Deployment memory d) internal view {
        d.morphoMarket = vm.envOr("MORPHO_VAULT", address(0));
        d.fluidMarket = vm.envOr("FLUID_VAULT", address(0));
        d.aavePool = vm.envOr("AAVE_POOL", address(0));
        d.aaveAToken = vm.envOr("AAVE_ATOKEN", address(0));
        d.weth = vm.envOr("WETH", address(0));
        d.aaveWethAToken = vm.envOr("AAVE_WETH_ATOKEN", address(0));
        d.aaveWethPool = d.aaveWethAToken == address(0) ? address(0) : d.aavePool;
        d.oracle = vm.envOr("ORACLE", block.chainid == 8453 ? CHAINLINK_ETH_USD_BASE : address(0));
        d.limitOrderProtocol = vm.envOr("LIMIT_ORDER_PROTOCOL", block.chainid == 8453 ? LOP_BASE : address(0));
        d.fusionSettlement = vm.envOr("FUSION_SETTLEMENT", block.chainid == 8453 ? FUSION_SETTLEMENT_BASE : address(0));
    }

    // ─── Strategy A ──────────────────────────────────────────────────────────

    function _deployStrategyA(Deployment memory d, Params memory p) internal {
        YieldVault vault = new YieldVault(
            IERC20(d.usdc), IAqua(d.aqua), p.deployer, p.keeper, p.reserveBps, "YieldSolver USDC", "ysUSDC"
        );
        d.vault = address(vault);

        // Withdraw queue: Aave → Fluid → Morpho.
        address[] memory built = new address[](3);
        uint256 n;
        if (d.aavePool != address(0)) {
            require(d.aaveAToken != address(0), "AAVE_ATOKEN required with AAVE_POOL");
            built[n++] = address(new AaveV3Adapter(d.vault, IAaveV3Pool(d.aavePool), IAaveV3AToken(d.aaveAToken)));
        }
        if (d.fluidMarket != address(0)) built[n++] = address(new ERC4626Adapter(d.vault, IERC4626(d.fluidMarket)));
        if (d.morphoMarket != address(0)) built[n++] = address(new ERC4626Adapter(d.vault, IERC4626(d.morphoMarket)));
        d.adapters = new address[](n);
        for (uint256 i; i < n; ++i) {
            d.adapters[i] = built[i];
            vault.addAdapter(IYieldAdapter(built[i]));
        }

        vault.setLiquidityApp(d.app, true);
        JitLiquidityApp.Strategy memory strategy = JitLiquidityApp.Strategy({
            maker: d.vault, token: d.usdc, taker: d.resolver, feeBps: p.feeBps, salt: bytes32(0)
        });
        d.strategyHash = vault.shipStrategy(d.app, abi.encode(strategy), _stableBudget(d.usdc));
    }

    // ─── Strategy B ──────────────────────────────────────────────────────────

    function _deployStrategyB(Deployment memory d, Params memory p) internal {
        d.inventoryVaults = new address[](3);
        d.inventoryStrategyHashes = new bytes32[](3);
        for (uint256 i; i < 3; ++i) {
            InventoryVault inv = _deployInventory(d, p, i);
            d.inventoryVaults[i] = address(inv);
            OracleSwapApp.Strategy memory strategy = OracleSwapApp.Strategy({
                maker: address(inv),
                taker: d.resolver,
                spreadBps: p.spreadBps,
                skewBps: p.skewBps,
                maxTradeBps: p.maxTradeBps,
                salt: bytes32(0)
            });
            d.inventoryStrategyHashes[i] =
                inv.shipStrategy(d.swapApp, abi.encode(strategy), _stableBudget(d.usdc), type(uint128).max);
        }
    }

    function _deployInventory(Deployment memory d, Params memory p, uint256 i) internal returns (InventoryVault inv) {
        inv = new InventoryVault(
            InventoryVault.Config({
                stable: IERC20(d.usdc),
                volatileAsset: IERC20(d.weth),
                aqua: IAqua(d.aqua),
                oracle: IChainlinkAggregator(d.oracle),
                owner: p.deployer,
                keeper: p.keeper,
                targetStableBps: PROFILES[i],
                bandBps: p.bandBps,
                maxPriceAge: p.priceMaxAge,
                depositFeeBps: p.depositFeeBps,
                maxRebalanceLossBps: p.maxRebalanceLossBps,
                name: string.concat("YieldSolver Inventory ", PROFILE_NAMES[i]),
                symbol: PROFILE_SYMBOLS[i]
            })
        );
        if (d.aavePool != address(0)) {
            inv.setAdapter(
                d.usdc, new AaveV3Adapter(address(inv), IAaveV3Pool(d.aavePool), IAaveV3AToken(d.aaveAToken))
            );
        }
        if (d.aaveWethPool != address(0)) {
            inv.setAdapter(
                d.weth, new AaveV3Adapter(address(inv), IAaveV3Pool(d.aaveWethPool), IAaveV3AToken(d.aaveWethAToken))
            );
        }
        inv.setSwapApp(d.swapApp, true);
        if (d.router != address(0)) inv.setRebalanceTarget(d.router, true);
    }

    // ─── Shared ──────────────────────────────────────────────────────────────

    function _wireResolver(Deployment memory d) internal {
        YieldResolver resolver = YieldResolver(payable(d.resolver));
        // The LOP pulls the taker asset from the resolver, so it needs allowances like the routers.
        address[3] memory targets = [d.router, d.orderBook, d.limitOrderProtocol];
        for (uint256 i; i < 3; ++i) {
            if (targets[i] == address(0)) continue;
            resolver.setTarget(targets[i], true);
            resolver.approveToken(IERC20(d.usdc), targets[i], type(uint256).max);
            if (d.weth != address(0)) resolver.approveToken(IERC20(d.weth), targets[i], type(uint256).max);
        }
    }

    /// @dev Two-step handover: the new owner must call acceptOwnership() on every vault and the resolver.
    function _handOver(Deployment memory d, Params memory p) internal {
        if (p.owner == p.deployer) return;
        YieldVault(d.vault).transferOwnership(p.owner);
        YieldResolver(payable(d.resolver)).transferOwnership(p.owner);
        for (uint256 i; i < d.inventoryVaults.length; ++i) {
            InventoryVault(d.inventoryVaults[i]).transferOwnership(p.owner);
        }
    }

    function _stableBudget(address usdc) internal view returns (uint256) {
        return vm.envOr("AQUA_BUDGET", 1e9 * 10 ** uint256(_decimals(usdc)));
    }

    function _decimals(address token) internal view returns (uint8) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("decimals()"));
        require(ok && data.length == 32, "asset has no decimals()");
        return abi.decode(data, (uint8));
    }

    // ─── Output ──────────────────────────────────────────────────────────────

    function _log(Deployment memory d, Params memory p) internal view {
        console2.log("mode             ", d.mock ? "mock" : "live");
        console2.log("USDC / WETH      ", d.usdc, d.weth);
        console2.log("Aqua             ", d.aqua);
        console2.log("YieldResolver    ", d.resolver);
        console2.log("keeper / operator", p.keeper, p.operator);
        console2.log("[A] YieldVault   ", d.vault);
        console2.log("[A] JitLiquidityApp", d.app);
        for (uint256 i; i < d.adapters.length; ++i) {
            console2.log("[A] adapter      ", i, d.adapters[i]);
        }
        console2.log("[B] OracleSwapApp", d.swapApp);
        console2.log("[B] oracle       ", d.oracle);
        for (uint256 i; i < d.inventoryVaults.length; ++i) {
            console2.log(string.concat("[B] ", PROFILE_NAMES[i]), d.inventoryVaults[i]);
        }
        if (d.orderBook != address(0)) console2.log("MockOrderBook    ", d.orderBook);
        console2.log("LimitOrderProtocol", d.limitOrderProtocol);
        console2.log("FusionSettlement ", d.fusionSettlement);
    }

    function _write(Deployment memory d, Params memory p) internal {
        string memory k = "deployment";
        vm.serializeBool(k, "mock", d.mock);
        vm.serializeAddress(k, "usdc", d.usdc);
        vm.serializeAddress(k, "weth", d.weth);
        vm.serializeAddress(k, "aqua", d.aqua);
        vm.serializeAddress(k, "resolver", d.resolver);
        vm.serializeAddress(k, "router", d.router);
        vm.serializeAddress(k, "orderBook", d.orderBook);
        vm.serializeAddress(k, "limitOrderProtocol", d.limitOrderProtocol);
        vm.serializeAddress(k, "fusionSettlement", d.fusionSettlement);
        vm.serializeAddress(k, "fusionAccessToken", d.fusionAccessToken);
        vm.serializeUint(k, "deployBlock", block.number);
        // Strategy A
        vm.serializeAddress(k, "vault", d.vault);
        vm.serializeAddress(k, "app", d.app);
        vm.serializeAddress(k, "adapters", d.adapters);
        vm.serializeBytes32(k, "strategyHash", d.strategyHash);
        vm.serializeUint(k, "flashFeeBps", p.feeBps);
        vm.serializeAddress(k, "morphoMarket", d.morphoMarket);
        vm.serializeAddress(k, "fluidMarket", d.fluidMarket);
        vm.serializeAddress(k, "aavePool", d.aavePool);
        vm.serializeAddress(k, "aaveAToken", d.aaveAToken);
        // Strategy B
        vm.serializeAddress(k, "oracle", d.oracle);
        vm.serializeAddress(k, "swapApp", d.swapApp);
        vm.serializeAddress(k, "aaveWethPool", d.aaveWethPool);
        vm.serializeAddress(k, "inventoryVaults", d.inventoryVaults);
        vm.serializeBytes32(k, "inventoryStrategyHashes", d.inventoryStrategyHashes);
        vm.serializeUint(k, "spreadBps", p.spreadBps);
        vm.serializeUint(k, "skewBps", p.skewBps);
        string memory json = vm.serializeUint(k, "maxTradeBps", p.maxTradeBps);
        vm.writeJson(json, string.concat("./deployments/", vm.toString(block.chainid), ".json"));
    }
}
