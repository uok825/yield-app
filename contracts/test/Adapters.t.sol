// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {ERC4626Adapter} from "../src/adapters/ERC4626Adapter.sol";
import {AaveV3Adapter} from "../src/adapters/AaveV3Adapter.sol";
import {BaseAdapter} from "../src/adapters/BaseAdapter.sol";
import {IAaveV3Pool, IAaveV3AToken} from "../src/interfaces/IAaveV3.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockLendingVault} from "../src/mocks/MockLendingVault.sol";
import {MockAavePool, MockAToken} from "../src/mocks/MockAavePool.sol";

contract AdaptersTest is Test {
    address internal vault = makeAddr("vault");
    MockERC20 internal usdc;
    MockLendingVault internal market;
    MockAavePool internal pool;
    ERC4626Adapter internal erc4626;
    AaveV3Adapter internal aave;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        market = new MockLendingVault(usdc, "m", "m");
        pool = new MockAavePool(usdc);
        erc4626 = new ERC4626Adapter(vault, IERC4626(address(market)));
        aave = new AaveV3Adapter(vault, IAaveV3Pool(address(pool)), IAaveV3AToken(address(pool.aToken())));
        usdc.mint(vault, 1_000_000e6);
    }

    function _supply(address adapter, uint256 amount) internal {
        vm.startPrank(vault);
        usdc.transfer(adapter, amount);
        BaseAdapter(adapter).deposit(amount);
        vm.stopPrank();
    }

    function test_erc4626_roundTrip() public {
        _supply(address(erc4626), 1_000e6);
        assertEq(erc4626.totalAssets(), 1_000e6);
        assertEq(erc4626.maxWithdraw(), 1_000e6);
        assertEq(erc4626.asset(), address(usdc));

        market.accrue(200);
        assertApproxEqAbs(erc4626.totalAssets(), 1_020e6, 1);

        vm.prank(vault);
        erc4626.withdraw(1_000e6, vault);
        assertEq(usdc.balanceOf(vault), 1_000_000e6);
        assertApproxEqAbs(erc4626.totalAssets(), 20e6, 1);
    }

    function test_erc4626_liquidityBound() public {
        _supply(address(erc4626), 1_000e6);
        market.setBorrowed(800e6);
        assertEq(erc4626.maxWithdraw(), 200e6);
        vm.prank(vault);
        vm.expectRevert();
        erc4626.withdraw(201e6, vault);
    }

    function test_aave_roundTrip() public {
        _supply(address(aave), 1_000e6);
        assertEq(aave.totalAssets(), 1_000e6);
        pool.accrue(100);
        assertApproxEqAbs(aave.totalAssets(), 1_010e6, 1);

        vm.prank(vault);
        aave.withdraw(1_005e6, vault);
        assertApproxEqAbs(aave.totalAssets(), 5e6, 1);
    }

    function test_aave_liquidityBound() public {
        _supply(address(aave), 1_000e6);
        pool.borrow(900e6, address(0xdead));
        assertEq(aave.maxWithdraw(), 100e6);
    }

    function test_onlyVault() public {
        vm.expectRevert(BaseAdapter.OnlyVault.selector);
        erc4626.deposit(1);
        vm.expectRevert(BaseAdapter.OnlyVault.selector);
        erc4626.withdraw(1, address(this));
        vm.expectRevert(BaseAdapter.OnlyVault.selector);
        aave.deposit(1);
        vm.expectRevert(BaseAdapter.OnlyVault.selector);
        aave.withdraw(1, address(this));
    }

    function test_constructorChecks() public {
        vm.expectRevert(BaseAdapter.ZeroAddress.selector);
        new ERC4626Adapter(address(0), IERC4626(address(market)));

        MockAavePool other = new MockAavePool(usdc);
        vm.expectRevert(AaveV3Adapter.PoolMismatch.selector);
        new AaveV3Adapter(vault, IAaveV3Pool(address(other)), IAaveV3AToken(address(pool.aToken())));
    }
}
