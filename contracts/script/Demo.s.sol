// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";

import {YieldVault} from "../src/YieldVault.sol";
import {JitLiquidityApp} from "../src/JitLiquidityApp.sol";
import {YieldResolver} from "../src/YieldResolver.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockSwapRouter} from "../src/mocks/MockSwapRouter.sol";

/// @title Demo
/// @notice Runs the whole flow against a mock-mode deployment (reads deployments/<chainId>.json):
///         deposit → allocate across markets → resolver borrows JIT liquidity, trades, repays with fee.
///         The broadcaster must be the keeper and operator (the Deploy defaults).
///
///  forge script script/Demo.s.sol --rpc-url base_sepolia --account <keystore> --broadcast
contract Demo is Script {
    function run() external {
        string memory json = vm.readFile(string.concat("./deployments/", vm.toString(block.chainid), ".json"));
        require(vm.parseJsonBool(json, ".mock"), "Demo only runs against a mock deployment");

        MockERC20 usdc = MockERC20(vm.parseJsonAddress(json, ".usdc"));
        MockERC20 weth = MockERC20(vm.parseJsonAddress(json, ".weth"));
        YieldVault vault = YieldVault(vm.parseJsonAddress(json, ".vault"));
        YieldResolver resolver = YieldResolver(payable(vm.parseJsonAddress(json, ".resolver")));
        MockSwapRouter router = MockSwapRouter(vm.parseJsonAddress(json, ".router"));
        uint16 feeBps = uint16(vm.parseJsonUint(json, ".flashFeeBps"));

        JitLiquidityApp.Strategy memory strategy = JitLiquidityApp.Strategy({
            maker: address(vault), token: address(usdc), taker: address(resolver), feeBps: feeBps, salt: bytes32(0)
        });

        uint256 depositAmount = 10_000e6;
        uint256 flashAmount = 4_000e6; // larger than the 15% reserve → forces a JIT unwind

        vm.startBroadcast();
        usdc.mint(msg.sender, depositAmount);
        usdc.approve(address(vault), depositAmount);
        vault.deposit(depositAmount, msg.sender);

        uint256 n = vault.adapterCount();
        uint256 deployable = depositAmount - vault.reserveTarget();
        for (uint256 i; i < n; ++i) {
            vault.allocate(i, deployable / n);
        }

        uint256 wethOut = router.quote(address(usdc), address(weth), flashAmount);
        YieldResolver.Call[] memory calls = new YieldResolver.Call[](2);
        calls[0] = YieldResolver.Call(
            address(router),
            0,
            abi.encodeCall(MockSwapRouter.swap, (address(usdc), address(weth), flashAmount, 0, address(resolver)))
        );
        calls[1] = YieldResolver.Call(
            address(router),
            0,
            abi.encodeCall(MockSwapRouter.swap, (address(weth), address(usdc), wethOut, 0, address(resolver)))
        );
        uint256 profit = resolver.execute(strategy, flashAmount, calls, 1);
        vm.stopBroadcast();

        console2.log("vault totalAssets", vault.totalAssets());
        console2.log("vault idle       ", vault.idleAssets());
        console2.log("resolver profit  ", profit);
        console2.log("share price (1e12 shares)", vault.convertToAssets(1e12));
    }
}
