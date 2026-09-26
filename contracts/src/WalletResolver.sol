// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

import {AquaYieldApp} from "./AquaYieldApp.sol";
import {IAquaYieldCallback} from "./interfaces/IAquaYield.sol";

/// @title WalletResolver
/// @notice Fills orders with liquidity that stays in users' wallets (AquaYieldApp strategies): borrows JIT from a
///         wallet (`executeFlash`) or buys from a wallet's committed inventory (`executeSwap`), runs calls against
///         whitelisted targets (1inch LOP fill, routers), pays the app and keeps the rest. Loss-making runs revert.
contract WalletResolver is Ownable2Step, IAquaYieldCallback {
    using SafeERC20 for IERC20;

    error OnlyOperator();
    error OnlyApp();
    error NotExecuting();
    error TargetNotAllowed(address target);
    error InsufficientProfit(uint256 profit, uint256 minProfit);
    error ZeroAddress();

    event OperatorSet(address indexed operator, bool allowed);
    event TargetSet(address indexed target, bool allowed);
    event Executed(address indexed maker, bytes32 indexed strategyHash, string action, address token, uint256 profit);

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    AquaYieldApp public immutable APP;
    mapping(address => bool) public isOperator;
    mapping(address => bool) public isAllowedTarget;
    bool private transient _executing;

    modifier onlyOperator() {
        if (!isOperator[msg.sender] && msg.sender != owner()) revert OnlyOperator();
        _;
    }

    modifier onlyAppDuringExecute() {
        if (msg.sender != address(APP)) revert OnlyApp();
        if (!_executing) revert NotExecuting();
        _;
    }

    constructor(AquaYieldApp app_, address owner_, address operator_) Ownable(owner_) {
        if (address(app_) == address(0)) revert ZeroAddress();
        APP = app_;
        if (operator_ != address(0)) {
            isOperator[operator_] = true;
            emit OperatorSet(operator_, true);
        }
    }

    receive() external payable {}

    /// @notice Borrows `assets` from a wallet's `market` position, runs `calls`, repays `assets + fee`.
    /// @return profit Net gain in the borrowed asset.
    function executeFlash(
        AquaYieldApp.Strategy calldata s,
        address market,
        uint256 assets,
        Call[] calldata calls,
        uint256 minProfit
    ) external onlyOperator returns (uint256 profit) {
        IERC20 token = IERC20(IERC4626(market).asset());
        uint256 before = token.balanceOf(address(this));
        _executing = true;
        APP.flash(s, market, assets, address(this), abi.encode(calls));
        _executing = false;
        profit = _profit(token.balanceOf(address(this)), before, minProfit);
        emit Executed(s.maker, APP.strategyHash(s), "flash", address(token), profit);
    }

    /// @notice Buys exactly `p.amountOut` from a wallet's inventory, runs `calls` (which must produce the payment,
    ///         e.g. by filling the user's order), pays the app. `p.to` must be this contract.
    /// @return profit Net gain in the paying token; the resolver may not end with less `tokenOut`.
    function executeSwap(
        AquaYieldApp.Strategy calldata s,
        AquaYieldApp.SwapParams calldata p,
        Call[] calldata calls,
        uint256 minProfit
    ) external onlyOperator returns (uint256 profit) {
        IERC20 pay = IERC20(p.tokenOut == s.stable ? s.volatileAsset : s.stable);
        uint256[2] memory before = [IERC20(p.tokenOut).balanceOf(address(this)), pay.balanceOf(address(this))];
        _executing = true;
        APP.swapExactOut(s, p, abi.encode(calls));
        _executing = false;
        if (IERC20(p.tokenOut).balanceOf(address(this)) < before[0]) revert InsufficientProfit(0, minProfit);
        profit = _profit(pay.balanceOf(address(this)), before[1], minProfit);
        emit Executed(s.maker, APP.strategyHash(s), "swap", address(pay), profit);
    }

    /// @inheritdoc IAquaYieldCallback
    function onAquaYieldFlash(address token, uint256 amount, uint256 fee, address, bytes32, bytes calldata data)
        external
        override
        onlyAppDuringExecute
    {
        _runCalls(data);
        IERC20(token).safeTransfer(msg.sender, amount + fee);
    }

    /// @inheritdoc IAquaYieldCallback
    function onAquaYieldSwap(address tokenIn, address, uint256 amountIn, uint256, address, bytes32, bytes calldata data)
        external
        override
        onlyAppDuringExecute
    {
        _runCalls(data);
        IERC20(tokenIn).safeTransfer(msg.sender, amountIn);
    }

    function _profit(uint256 afterBal, uint256 beforeBal, uint256 minProfit) internal pure returns (uint256 profit) {
        profit = afterBal > beforeBal ? afterBal - beforeBal : 0;
        if (afterBal < beforeBal || profit < minProfit) revert InsufficientProfit(profit, minProfit);
    }

    function _runCalls(bytes calldata data) internal {
        Call[] memory calls = abi.decode(data, (Call[]));
        for (uint256 i; i < calls.length; ++i) {
            if (!isAllowedTarget[calls[i].target]) revert TargetNotAllowed(calls[i].target);
            Address.functionCallWithValue(calls[i].target, calls[i].data, calls[i].value);
        }
    }

    // ─── Owner ───────────────────────────────────────────────────────────────

    function setOperator(address operator, bool allowed) external onlyOwner {
        if (operator == address(0)) revert ZeroAddress();
        isOperator[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    /// @notice Whitelists call targets. Never whitelist a token contract: that would let an operator move funds.
    function setTarget(address target, bool allowed) external onlyOwner {
        if (target == address(0)) revert ZeroAddress();
        isAllowedTarget[target] = allowed;
        emit TargetSet(target, allowed);
    }

    function approveToken(IERC20 token, address spender, uint256 amount) external onlyOwner {
        token.forceApprove(spender, amount);
    }

    function sweep(IERC20 token, address to, uint256 amount) external onlyOwner {
        token.safeTransfer(to, amount);
    }

    function sweepNative(address payable to, uint256 amount) external onlyOwner {
        Address.sendValue(to, amount);
    }
}
