// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";

import {Aave4626} from "../src/Aave4626.sol";
import {AquaYieldApp} from "../src/AquaYieldApp.sol";
import {WalletResolver} from "../src/WalletResolver.sol";
import {IAaveV3Pool, IAaveV3AToken} from "../src/interfaces/IAaveV3.sol";

/// @title DeployWallet
/// @notice Adds self-custody mode on top of an existing deployment (deployments/<chainId>.json from Deploy.s.sol):
///         Aave-4626 wrappers (USDC, WETH), AquaYieldApp and WalletResolver. The file is updated in place with:
///         aquaYieldApp, walletResolver, walletStableMarkets[], walletVolatileMarkets[].
///
///  Wallet markets: USDC → Morpho, Fluid, Aave-4626 (from the deployment) · WETH → Aave-4626.
///  OWNER / OPERATOR default to the deployer, like Deploy.s.sol.
///
///    forge script script/DeployWallet.s.sol --rpc-url base_sepolia --account <keystore> --broadcast --slow
contract DeployWallet is Script {
    address internal constant ZERO = address(0);

    struct Ctx {
        string path;
        address aqua;
        address usdc;
        address weth;
        address morpho;
        address fluid;
        address aavePool;
        address aaveAToken;
        address aaveWethPool;
        address[3] targets; // router, order book, LOP
    }

    function run() external {
        Ctx memory c = _load();
        address operator = vm.envOr("OPERATOR", msg.sender);
        address owner = vm.envOr("OWNER", msg.sender);

        vm.startBroadcast();
        address[] memory stable = _stableMarkets(c);
        address[] memory vol = _volatileMarkets(c);
        AquaYieldApp app = new AquaYieldApp(IAqua(c.aqua));
        WalletResolver resolver = new WalletResolver(app, msg.sender, operator);
        _wire(c, resolver);
        if (owner != msg.sender) resolver.transferOwnership(owner);
        vm.stopBroadcast();

        console2.log("AquaYieldApp  ", address(app));
        console2.log("WalletResolver", address(resolver));
        for (uint256 i; i < stable.length; ++i) {
            console2.log("stable market ", stable[i]);
        }
        for (uint256 i; i < vol.length; ++i) {
            console2.log("volatile mkt  ", vol[i]);
        }
        vm.writeJson(string.concat('"', vm.toString(address(app)), '"'), c.path, ".aquaYieldApp");
        vm.writeJson(string.concat('"', vm.toString(address(resolver)), '"'), c.path, ".walletResolver");
        vm.writeJson(_array(stable), c.path, ".walletStableMarkets");
        vm.writeJson(_array(vol), c.path, ".walletVolatileMarkets");
    }

    function _load() internal view returns (Ctx memory c) {
        c.path = string.concat("./deployments/", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(c.path);
        c.aqua = vm.parseJsonAddress(json, ".aqua");
        c.usdc = vm.parseJsonAddress(json, ".usdc");
        c.weth = vm.parseJsonAddress(json, ".weth");
        c.morpho = vm.parseJsonAddress(json, ".morphoMarket");
        c.fluid = vm.parseJsonAddress(json, ".fluidMarket");
        c.aavePool = vm.parseJsonAddress(json, ".aavePool");
        c.aaveAToken = vm.parseJsonAddress(json, ".aaveAToken");
        c.aaveWethPool = vm.parseJsonAddress(json, ".aaveWethPool");
        c.targets = [
            vm.parseJsonAddress(json, ".router"),
            vm.parseJsonAddress(json, ".orderBook"),
            vm.parseJsonAddress(json, ".limitOrderProtocol")
        ];
    }

    function _stableMarkets(Ctx memory c) internal returns (address[] memory list) {
        address[] memory tmp = new address[](3);
        uint256 n;
        if (c.morpho != ZERO) tmp[n++] = c.morpho;
        if (c.fluid != ZERO) tmp[n++] = c.fluid;
        if (c.aavePool != ZERO) {
            tmp[n++] = address(
                new Aave4626(IAaveV3Pool(c.aavePool), IAaveV3AToken(c.aaveAToken), "Aave USDC (4626)", "a4USDC")
            );
        }
        list = new address[](n);
        for (uint256 i; i < n; ++i) {
            list[i] = tmp[i];
        }
    }

    function _volatileMarkets(Ctx memory c) internal returns (address[] memory list) {
        if (c.aaveWethPool == ZERO) return new address[](0);
        list = new address[](1);
        address aWeth = _aToken(c.aaveWethPool, c.weth);
        list[0] = address(new Aave4626(IAaveV3Pool(c.aaveWethPool), IAaveV3AToken(aWeth), "Aave WETH (4626)", "a4WETH"));
    }

    function _wire(Ctx memory c, WalletResolver resolver) internal {
        for (uint256 i; i < 3; ++i) {
            if (c.targets[i] == ZERO) continue;
            resolver.setTarget(c.targets[i], true);
            resolver.approveToken(IERC20(c.usdc), c.targets[i], type(uint256).max);
            if (c.weth != ZERO) resolver.approveToken(IERC20(c.weth), c.targets[i], type(uint256).max);
        }
    }

    /// @dev The Aave WETH aToken, read from the deployment's mock pool (`aToken()`), or AAVE_WETH_ATOKEN in live mode.
    function _aToken(address pool, address weth) internal view returns (address aToken) {
        aToken = vm.envOr("AAVE_WETH_ATOKEN", address(0));
        if (aToken != ZERO) return aToken;
        (bool ok, bytes memory data) = pool.staticcall(abi.encodeWithSignature("aToken()"));
        require(ok && data.length == 32, "set AAVE_WETH_ATOKEN");
        aToken = abi.decode(data, (address));
        require(IAaveV3AToken(aToken).UNDERLYING_ASSET_ADDRESS() == weth, "aToken is not WETH");
    }

    function _array(address[] memory list) internal pure returns (string memory out) {
        out = "[";
        for (uint256 i; i < list.length; ++i) {
            out = string.concat(out, i == 0 ? "" : ",", '"', vm.toString(list[i]), '"');
        }
        out = string.concat(out, "]");
    }
}
