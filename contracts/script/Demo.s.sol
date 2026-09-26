// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";

import {YieldVault} from "../src/YieldVault.sol";
import {InventoryVault} from "../src/InventoryVault.sol";
import {JitLiquidityApp} from "../src/JitLiquidityApp.sol";
import {OracleSwapApp} from "../src/OracleSwapApp.sol";
import {YieldResolver} from "../src/YieldResolver.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockSwapRouter} from "../src/mocks/MockSwapRouter.sol";
import {MockOrderBook} from "../src/mocks/MockOrderBook.sol";

/// @title Demo
/// @notice Runs both strategies end to end against a mock-mode deployment (reads deployments/<chainId>.json).
///         The broadcaster must be the keeper and operator (the Deploy defaults) and plays the end user too.
///
///   A: deposit → allocate across markets → resolver borrows JIT liquidity, trades, repays with fee.
///   B: seed each inventory profile at target → lend part on Aave → fill a USDC→ETH and an ETH→USDC intent
///      straight from inventory.
///
///  forge script script/Demo.s.sol --rpc-url base_sepolia --account <keystore> --broadcast
contract Demo is Script {
    string internal json;
    MockERC20 internal usdc;
    MockERC20 internal weth;
    YieldResolver internal resolver;
    MockOrderBook internal book;

    function run() external {
        json = vm.readFile(string.concat("./deployments/", vm.toString(block.chainid), ".json"));
        require(vm.parseJsonBool(json, ".mock"), "Demo only runs against a mock deployment");
        usdc = MockERC20(vm.parseJsonAddress(json, ".usdc"));
        weth = MockERC20(vm.parseJsonAddress(json, ".weth"));
        resolver = YieldResolver(payable(vm.parseJsonAddress(json, ".resolver")));
        book = MockOrderBook(vm.parseJsonAddress(json, ".orderBook"));

        vm.startBroadcast();
        _strategyA();
        address[] memory vaults = vm.parseJsonAddressArray(json, ".inventoryVaults");
        for (uint256 i; i < vaults.length; ++i) {
            _strategyB(InventoryVault(vaults[i]));
        }
        vm.stopBroadcast();
    }

    function _strategyA() internal {
        YieldVault vault = YieldVault(vm.parseJsonAddress(json, ".vault"));
        MockSwapRouter router = MockSwapRouter(vm.parseJsonAddress(json, ".router"));
        JitLiquidityApp.Strategy memory strategy = JitLiquidityApp.Strategy({
            maker: address(vault),
            token: address(usdc),
            taker: address(resolver),
            feeBps: uint16(vm.parseJsonUint(json, ".flashFeeBps")),
            salt: bytes32(0)
        });

        uint256 depositAmount = 10_000e6;
        uint256 flashAmount = 4_000e6; // larger than the 15% reserve → forces a JIT unwind

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

        console2.log("[A] vault totalAssets", vault.totalAssets());
        console2.log("[A] resolver profit  ", profit);
    }

    function _strategyB(InventoryVault inv) internal {
        OracleSwapApp.Strategy memory strategy = OracleSwapApp.Strategy({
            maker: address(inv),
            taker: address(resolver),
            spreadBps: uint16(vm.parseJsonUint(json, ".spreadBps")),
            skewBps: uint16(vm.parseJsonUint(json, ".skewBps")),
            maxTradeBps: uint16(vm.parseJsonUint(json, ".maxTradeBps")),
            salt: bytes32(0)
        });

        _seed(inv);
        uint256 valueBefore = inv.totalValue();
        (uint256 bid, uint256 ask,) = OracleSwapApp(vm.parseJsonAddress(json, ".swapApp")).prices(strategy);
        (uint256 profitBuy, uint256 profitSell) = _fillBothWays(inv, strategy);

        console2.log(string.concat("[B] ", inv.symbol()), address(inv));
        console2.log("    bid / ask (USDC)   ", bid / 1e18, ask / 1e18);
        console2.log("    value before/after ", valueBefore, inv.totalValue());
        console2.log("    stable ratio bps   ", inv.stableRatioBps());
        console2.log("    resolver profit USDC / WETH", profitBuy, profitSell);
    }

    /// @dev Seeds $100k at the profile's target split and lends half of each side on Aave.
    function _seed(InventoryVault inv) internal {
        uint256 p = inv.price(); // USDC units per WETH, 1e18-scaled
        (uint16 targetStable,) = inv.profile();
        uint256 stableIn = 100_000e6 * uint256(targetStable) / 10_000;
        uint256 wethIn = (100_000e6 - stableIn) * 1e18 * 1e18 / p;
        usdc.mint(msg.sender, stableIn);
        weth.mint(msg.sender, wethIn);
        usdc.approve(address(inv), stableIn);
        weth.approve(address(inv), wethIn);
        inv.deposit(stableIn, wethIn, msg.sender, 1);
        inv.allocate(address(usdc), stableIn / 2);
        inv.allocate(address(weth), wethIn / 2);
    }

    /// @dev A user buys 1 WETH offering 1% above oracle, then sells 1 WETH asking 1% below; both filled from stock.
    function _fillBothWays(InventoryVault inv, OracleSwapApp.Strategy memory strategy)
        internal
        returns (uint256 profitBuy, uint256 profitSell)
    {
        uint256 p = inv.price();
        uint256 give = p * 101 / 100 / 1e18;
        usdc.mint(msg.sender, give);
        usdc.approve(address(book), give);
        uint256 id = book.createOrder(address(usdc), address(weth), give, 1e18);
        profitBuy = resolver.executeSwap(strategy, address(weth), 1e18, type(uint256).max, _fill(id), 1);

        uint256 want = p * 99 / 100 / 1e18;
        weth.mint(msg.sender, 1e18);
        weth.approve(address(book), 1e18);
        id = book.createOrder(address(weth), address(usdc), 1e18, want);
        profitSell = resolver.executeSwap(strategy, address(usdc), want, type(uint256).max, _fill(id), 1);
    }

    function _fill(uint256 id) internal view returns (YieldResolver.Call[] memory calls) {
        calls = new YieldResolver.Call[](1);
        calls[0] = YieldResolver.Call(address(book), 0, abi.encodeCall(MockOrderBook.fill, (id)));
    }
}
