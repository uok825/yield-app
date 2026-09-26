// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IAqua} from "@1inch/aqua/interfaces/IAqua.sol";
import {Aqua} from "@1inch/aqua/Aqua.sol";

import {YieldVault} from "../src/YieldVault.sol";
import {JitLiquidityApp} from "../src/JitLiquidityApp.sol";
import {YieldResolver} from "../src/YieldResolver.sol";
import {ERC4626Adapter} from "../src/adapters/ERC4626Adapter.sol";
import {AaveV3Adapter} from "../src/adapters/AaveV3Adapter.sol";
import {IYieldAdapter} from "../src/interfaces/IYieldAdapter.sol";
import {IAaveV3Pool, IAaveV3AToken} from "../src/interfaces/IAaveV3.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockLendingVault} from "../src/mocks/MockLendingVault.sol";
import {MockAavePool} from "../src/mocks/MockAavePool.sol";
import {MockSwapRouter} from "../src/mocks/MockSwapRouter.sol";

/// @title Deploy
/// @notice Deploys the full YieldSolver stack.
///
///  Mock mode (no `USDC` env var, e.g. Base Sepolia): deploys test USDC/WETH, two ERC-4626 markets, an Aave-like
///  pool and a fixed-price router, so everything can be exercised end-to-end on a testnet.
///
///  Live mode (`USDC` set, e.g. Base): wires real markets from env vars — any of MORPHO_VAULT, FLUID_VAULT,
///  AAVE_POOL + AAVE_ATOKEN. Withdraw queue order = Aave, Fluid, Morpho (keeper can reorder later).
///
///  Aqua: uses `AQUA` if set, else the canonical 1inch deployment if it has code on this chain, else deploys one.
///
///  Optional: OWNER, KEEPER, OPERATOR (default: deployer), RESERVE_BPS (1500), FLASH_FEE_BPS (5),
///  AQUA_BUDGET (1e9 * 10**decimals).
///
///  Usage:
///    forge script script/Deploy.s.sol --rpc-url base_sepolia --account <keystore> --broadcast --verify
contract Deploy is Script {
    address internal constant CANONICAL_AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;

    struct Deployment {
        address usdc;
        address weth;
        address aqua;
        address vault;
        address app;
        address resolver;
        address router;
        address morphoMarket;
        address fluidMarket;
        address aavePool;
        address aaveAToken;
        address[] adapters;
        bytes32 strategyHash;
        bool mock;
    }

    struct Params {
        address deployer;
        address owner;
        address keeper;
        address operator;
        uint16 reserveBps;
        uint16 feeBps;
    }

    function run() external returns (Deployment memory d) {
        Params memory p = Params({
            deployer: msg.sender,
            owner: vm.envOr("OWNER", msg.sender),
            keeper: vm.envOr("KEEPER", msg.sender),
            operator: vm.envOr("OPERATOR", msg.sender),
            reserveBps: uint16(vm.envOr("RESERVE_BPS", uint256(1500))),
            feeBps: uint16(vm.envOr("FLASH_FEE_BPS", uint256(5)))
        });

        d.usdc = vm.envOr("USDC", address(0));
        d.mock = d.usdc == address(0);

        vm.startBroadcast();
        _deployAqua(d);
        if (d.mock) _deployMockMarkets(d);
        else _readLiveMarkets(d);
        _deployCore(d, p);
        _deployAdapters(d);
        _wire(d, p);
        vm.stopBroadcast();

        _log(d, p);
        _write(d, p.feeBps);
    }

    function _deployAqua(Deployment memory d) internal {
        d.aqua = vm.envOr("AQUA", address(0));
        if (d.aqua == address(0)) {
            d.aqua = CANONICAL_AQUA.code.length > 0 ? CANONICAL_AQUA : address(new Aqua());
        }
    }

    function _deployMockMarkets(Deployment memory d) internal {
        MockERC20 usdc = new MockERC20("Test USD Coin", "USDC", 6);
        MockERC20 weth = new MockERC20("Test Wrapped Ether", "WETH", 18);
        d.usdc = address(usdc);
        d.weth = address(weth);
        d.morphoMarket = address(new MockLendingVault(usdc, "Mock Morpho USDC", "mmUSDC"));
        d.fluidMarket = address(new MockLendingVault(usdc, "Mock Fluid USDC", "mfUSDC"));
        MockAavePool pool = new MockAavePool(usdc);
        d.aavePool = address(pool);
        d.aaveAToken = address(pool.aToken());
        MockSwapRouter router = new MockSwapRouter();
        d.router = address(router);
        router.setPrice(d.usdc, d.weth, uint256(1e30) / 3000); // 3000 USDC / WETH
        router.setPrice(d.weth, d.usdc, 3006e6); // +0.2% on the way back
    }

    function _readLiveMarkets(Deployment memory d) internal view {
        d.morphoMarket = vm.envOr("MORPHO_VAULT", address(0));
        d.fluidMarket = vm.envOr("FLUID_VAULT", address(0));
        d.aavePool = vm.envOr("AAVE_POOL", address(0));
        d.aaveAToken = vm.envOr("AAVE_ATOKEN", address(0));
    }

    function _deployCore(Deployment memory d, Params memory p) internal {
        d.vault = address(
            new YieldVault(
                IERC20(d.usdc), IAqua(d.aqua), p.deployer, p.keeper, p.reserveBps, "YieldSolver USDC", "ysUSDC"
            )
        );
        d.app = address(new JitLiquidityApp(IAqua(d.aqua)));
        d.resolver = address(new YieldResolver(IAqua(d.aqua), JitLiquidityApp(d.app), p.deployer, p.operator));
    }

    /// @dev Withdraw queue order: Aave → Fluid → Morpho.
    function _deployAdapters(Deployment memory d) internal {
        address[] memory built = new address[](3);
        uint256 n;
        if (d.aavePool != address(0)) {
            require(d.aaveAToken != address(0), "AAVE_ATOKEN required with AAVE_POOL");
            built[n++] = address(new AaveV3Adapter(d.vault, IAaveV3Pool(d.aavePool), IAaveV3AToken(d.aaveAToken)));
        }
        if (d.fluidMarket != address(0)) {
            built[n++] = address(new ERC4626Adapter(d.vault, IERC4626(d.fluidMarket)));
        }
        if (d.morphoMarket != address(0)) {
            built[n++] = address(new ERC4626Adapter(d.vault, IERC4626(d.morphoMarket)));
        }
        d.adapters = new address[](n);
        for (uint256 i; i < n; ++i) {
            d.adapters[i] = built[i];
            YieldVault(d.vault).addAdapter(IYieldAdapter(built[i]));
        }
    }

    function _wire(Deployment memory d, Params memory p) internal {
        YieldVault vault = YieldVault(d.vault);
        YieldResolver resolver = YieldResolver(payable(d.resolver));

        // Aqua strategy: the vault lends to the resolver only.
        vault.setLiquidityApp(d.app, true);
        uint256 budget = vm.envOr("AQUA_BUDGET", 1e9 * 10 ** uint256(_decimals(d.usdc)));
        JitLiquidityApp.Strategy memory strategy = JitLiquidityApp.Strategy({
            maker: d.vault, token: d.usdc, taker: d.resolver, feeBps: p.feeBps, salt: bytes32(0)
        });
        d.strategyHash = vault.shipStrategy(d.app, abi.encode(strategy), budget);

        if (d.router != address(0)) {
            resolver.setTarget(d.router, true);
            resolver.approveToken(IERC20(d.usdc), d.router, type(uint256).max);
            resolver.approveToken(IERC20(d.weth), d.router, type(uint256).max);
        }

        // Two-step handover: the new owner must call acceptOwnership() on both contracts.
        if (p.owner != p.deployer) {
            vault.transferOwnership(p.owner);
            resolver.transferOwnership(p.owner);
        }
    }

    function _decimals(address token) internal view returns (uint8) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("decimals()"));
        require(ok && data.length == 32, "asset has no decimals()");
        return abi.decode(data, (uint8));
    }

    function _log(Deployment memory d, Params memory p) internal pure {
        console2.log("mode          ", d.mock ? "mock" : "live");
        console2.log("USDC          ", d.usdc);
        console2.log("Aqua          ", d.aqua);
        console2.log("YieldVault    ", d.vault);
        console2.log("JitLiquidityApp", d.app);
        console2.log("YieldResolver ", d.resolver);
        console2.log("keeper        ", p.keeper);
        console2.log("operator      ", p.operator);
        console2.log("flash fee bps ", p.feeBps);
        for (uint256 i; i < d.adapters.length; ++i) {
            console2.log("adapter       ", i, d.adapters[i]);
        }
        console2.logBytes32(d.strategyHash);
    }

    function _write(Deployment memory d, uint16 feeBps) internal {
        string memory k = "deployment";
        vm.serializeBool(k, "mock", d.mock);
        vm.serializeAddress(k, "usdc", d.usdc);
        vm.serializeAddress(k, "weth", d.weth);
        vm.serializeAddress(k, "aqua", d.aqua);
        vm.serializeAddress(k, "vault", d.vault);
        vm.serializeAddress(k, "app", d.app);
        vm.serializeAddress(k, "resolver", d.resolver);
        vm.serializeAddress(k, "router", d.router);
        vm.serializeAddress(k, "morphoMarket", d.morphoMarket);
        vm.serializeAddress(k, "fluidMarket", d.fluidMarket);
        vm.serializeAddress(k, "aavePool", d.aavePool);
        vm.serializeAddress(k, "aaveAToken", d.aaveAToken);
        vm.serializeAddress(k, "adapters", d.adapters);
        vm.serializeUint(k, "flashFeeBps", feeBps);
        string memory json = vm.serializeBytes32(k, "strategyHash", d.strategyHash);
        vm.writeJson(json, string.concat("./deployments/", vm.toString(block.chainid), ".json"));
    }
}
