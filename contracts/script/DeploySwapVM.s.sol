// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ISwapVM} from "@1inch/swap-vm/interfaces/ISwapVM.sol";

import {YieldSwapVMRouter} from "../src/swapvm/YieldSwapVMRouter.sol";
import {YieldSwapVMStrategies} from "../src/swapvm/YieldSwapVMStrategies.sol";
import {SwapVMResolver} from "../src/swapvm/SwapVMResolver.sol";

/// @title DeploySwapVM
/// @notice Adds 1inch SwapVM strategies on top of an existing deployment (deployments/<chainId>.json with self-custody
///         mode): YieldSwapVMRouter wired to the deployment's Aqua (so wallets reuse the same Aqua approval and the
///         same shares as AquaYieldApp), the canonical order builder, and SwapVMResolver (Fusion taker). Writes:
///         swapVMRouter, swapVMStrategies, swapVMResolver.
///
///    forge script script/DeploySwapVM.s.sol --rpc-url base_sepolia --account <keystore> --broadcast --slow
contract DeploySwapVM is Script {
    function run() external {
        string memory path = string.concat("./deployments/", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(path);
        address aqua = vm.parseJsonAddress(json, ".aqua");
        address usdc = vm.parseJsonAddress(json, ".usdc");
        address weth = vm.parseJsonAddress(json, ".weth");
        address[3] memory targets = [
            vm.parseJsonAddress(json, ".router"),
            vm.parseJsonAddress(json, ".orderBook"),
            vm.parseJsonAddress(json, ".limitOrderProtocol")
        ];
        address operator = vm.envOr("OPERATOR", msg.sender);
        address owner = vm.envOr("OWNER", msg.sender);

        vm.startBroadcast();
        YieldSwapVMRouter router = new YieldSwapVMRouter(aqua, weth, owner);
        YieldSwapVMStrategies builder = new YieldSwapVMStrategies();
        SwapVMResolver resolver = new SwapVMResolver(ISwapVM(address(router)), msg.sender, operator);
        for (uint256 i; i < 3; ++i) {
            if (targets[i] == address(0)) continue;
            resolver.setTarget(targets[i], true);
            resolver.approveToken(IERC20(usdc), targets[i], type(uint256).max);
            resolver.approveToken(IERC20(weth), targets[i], type(uint256).max);
        }
        if (owner != msg.sender) resolver.transferOwnership(owner);
        vm.stopBroadcast();

        console2.log("SwapVM router  ", address(router));
        console2.log("SwapVM builder ", address(builder));
        console2.log("SwapVMResolver ", address(resolver));
        vm.writeJson(_q(address(router)), path, ".swapVMRouter");
        vm.writeJson(_q(address(builder)), path, ".swapVMStrategies");
        vm.writeJson(_q(address(resolver)), path, ".swapVMResolver");
    }

    function _q(address a) internal pure returns (string memory) {
        return string.concat('"', vm.toString(a), '"');
    }
}
