// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CarryVault} from "../src/CarryVault.sol";
import {IAaveV3CreditPool, IAaveOracle} from "../src/interfaces/IAaveV3.sol";
import {IChainlinkAggregator} from "../src/interfaces/IChainlinkAggregator.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockCreditMarket, MockAaveOracle} from "../src/mocks/MockCreditMarket.sol";

/// @title DeployCarry
/// @notice Adds the conditional carry module (CarryVault) to an existing deployment (deployments/<chainId>.json).
///
///  Mock mode (deployment.mock): deploys a MockCreditMarket (Aave-like: WETH collateral, USDC variable debt) priced
///  by the deployment's oracle, and uses the mock Morpho / Fluid USDC markets as sinks.
///  Live mode on Base: Aave V3 (WETH collateral, USDC variable debt, Aave oracle) and Morpho USDC vaults
///  (Steakhouse, Gauntlet Prime, Spark) as sinks.
///
///  Env: KEEPER (default deployer), CARRY_MAX_LTV_BPS (3000), CARRY_DELEVERAGE_LTV_BPS (4000),
///       CARRY_SINK_CAP (5,000,000 USDC per sink), CARRY_BORROW_APR_BPS (mock only, 480).
///  Writes: carryVault, carrySinks[], creditMarket (mock), carryAaveOracle.
contract DeployCarry is Script {
    // Base mainnet
    address internal constant AAVE_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address internal constant AAVE_AWETH = 0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7;
    address internal constant AAVE_USDC_DEBT = 0x59dca05b6c26dbd64b5381374aAaC5CD05644C28;
    address internal constant AAVE_ORACLE = 0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156;
    address internal constant STEAKHOUSE_USDC = 0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183;
    address internal constant GAUNTLET_PRIME_USDC = 0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61;
    address internal constant SPARK_USDC = 0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A;

    struct Legs {
        address pool;
        address aCollateral;
        address debtToken;
        address oracle;
        address market; // mock only
        address[] sinks;
    }

    function run() external {
        string memory path = string.concat("./deployments/", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(path);
        bool mock = vm.parseJsonBool(json, ".mock");
        address usdc = vm.parseJsonAddress(json, ".usdc");
        address weth = vm.parseJsonAddress(json, ".weth");

        vm.startBroadcast();
        Legs memory l = mock ? _mockLegs(json, usdc, weth) : _liveLegs();
        CarryVault carry = new CarryVault(
            CarryVault.Config({
                asset: IERC20(weth),
                pool: IAaveV3CreditPool(l.pool),
                aCollateral: IERC20(l.aCollateral),
                debtAsset: IERC20(usdc),
                debtToken: IERC20(l.debtToken),
                oracle: IAaveOracle(l.oracle),
                owner: msg.sender,
                keeper: vm.envOr("KEEPER", msg.sender),
                maxLtvBps: uint16(vm.envOr("CARRY_MAX_LTV_BPS", uint256(3_000))),
                deleverageLtvBps: uint16(vm.envOr("CARRY_DELEVERAGE_LTV_BPS", uint256(4_000))),
                name: "YieldSolver Carry WETH",
                symbol: "ycWETH"
            })
        );
        uint256 cap = vm.envOr("CARRY_SINK_CAP", uint256(5_000_000e6));
        for (uint256 i; i < l.sinks.length; ++i) {
            carry.setSink(l.sinks[i], cap);
        }
        address router = mock ? vm.parseJsonAddress(json, ".router") : vm.envOr("CARRY_ROUTER", address(0));
        if (router != address(0)) carry.setRouter(router, true);
        vm.stopBroadcast();

        console2.log("CarryVault    ", address(carry));
        console2.log("credit pool   ", l.pool);
        for (uint256 i; i < l.sinks.length; ++i) {
            console2.log("sink          ", l.sinks[i]);
        }
        vm.writeJson(_q(address(carry)), path, ".carryVault");
        vm.writeJson(_q(l.market), path, ".creditMarket");
        vm.writeJson(_q(l.oracle), path, ".carryAaveOracle");
        vm.writeJson(_array(l.sinks), path, ".carrySinks");
    }

    function _mockLegs(string memory json, address usdc, address weth) internal returns (Legs memory l) {
        MockAaveOracle aaveOracle =
            new MockAaveOracle(IChainlinkAggregator(vm.parseJsonAddress(json, ".oracle")), weth);
        MockCreditMarket market = new MockCreditMarket(aaveOracle);
        market.initReserve(MockERC20(weth), 8_000, 8_250, false, 0);
        uint256 aprBps = vm.envOr("CARRY_BORROW_APR_BPS", uint256(480));
        market.initReserve(MockERC20(usdc), 7_500, 8_000, true, aprBps * 1e27 / 10_000);
        l.pool = address(market);
        l.market = address(market);
        l.aCollateral = market.aTokenOf(weth);
        l.debtToken = market.debtTokenOf(usdc);
        l.oracle = address(aaveOracle);
        l.sinks = new address[](2);
        l.sinks[0] = vm.parseJsonAddress(json, ".morphoMarket");
        l.sinks[1] = vm.parseJsonAddress(json, ".fluidMarket");
    }

    function _liveLegs() internal pure returns (Legs memory l) {
        l.pool = AAVE_POOL;
        l.aCollateral = AAVE_AWETH;
        l.debtToken = AAVE_USDC_DEBT;
        l.oracle = AAVE_ORACLE;
        l.sinks = new address[](3);
        (l.sinks[0], l.sinks[1], l.sinks[2]) = (STEAKHOUSE_USDC, GAUNTLET_PRIME_USDC, SPARK_USDC);
    }

    function _q(address a) internal pure returns (string memory) {
        return string.concat('"', vm.toString(a), '"');
    }

    function _array(address[] memory list) internal pure returns (string memory out) {
        out = "[";
        for (uint256 i; i < list.length; ++i) {
            out = string.concat(out, i == 0 ? "" : ",", '"', vm.toString(list[i]), '"');
        }
        out = string.concat(out, "]");
    }
}
