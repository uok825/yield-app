// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {IAqua} from "@1inch/aqua/interfaces/IAqua.sol";

import {JitLiquidityApp} from "./JitLiquidityApp.sol";
import {OracleSwapApp} from "./OracleSwapApp.sol";
import {IJitLiquidityCallback} from "./interfaces/IJitLiquidity.sol";
import {IInventoryMaker, IOracleSwapCallback} from "./interfaces/IOracleSwap.sol";

/// @title YieldResolver
/// @notice Order resolver for both strategies. An operator runs a list of calls against whitelisted targets
///         (e.g. the 1inch Limit Order Protocol / Fusion settlement to fill an order, a router to unwind) funded by:
///         - Strategy A (`execute`): JIT liquidity borrowed from a YieldVault through `JitLiquidityApp`, repaid
///           with a fee in the same transaction.
///         - Strategy B (`executeSwap`): inventory bought from an InventoryVault through `OracleSwapApp` at
///           oracle-anchored prices, paid for with the proceeds of the fill.
///         Whatever is left over is the resolver's profit; loss-making runs revert.
contract YieldResolver is Ownable2Step, IJitLiquidityCallback, IOracleSwapCallback {
    using SafeERC20 for IERC20;

    error OnlyOperator();
    error OnlyApp();
    error NotExecuting();
    error TargetNotAllowed(address target);
    error InsufficientProfit(uint256 profit, uint256 minProfit);
    error ZeroAddress();

    event OperatorSet(address indexed operator, bool allowed);
    event TargetSet(address indexed target, bool allowed);
    event Executed(bytes32 indexed strategyHash, address indexed token, uint256 amount, uint256 fee, uint256 profit);
    event SwapExecuted(
        bytes32 indexed strategyHash, address indexed tokenOut, uint256 amountOut, uint256 amountIn, uint256 profit
    );

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    IAqua public immutable AQUA;
    JitLiquidityApp public immutable APP;
    OracleSwapApp public immutable SWAP_APP;

    mapping(address => bool) public isOperator;
    mapping(address => bool) public isAllowedTarget;

    bool private transient _executing;

    modifier onlyOperator() {
        if (!isOperator[msg.sender] && msg.sender != owner()) revert OnlyOperator();
        _;
    }

    constructor(IAqua aqua_, JitLiquidityApp app_, OracleSwapApp swapApp_, address owner_, address operator_)
        Ownable(owner_)
    {
        if (address(aqua_) == address(0) || address(app_) == address(0) || address(swapApp_) == address(0)) {
            revert ZeroAddress();
        }
        AQUA = aqua_;
        APP = app_;
        SWAP_APP = swapApp_;
        if (operator_ != address(0)) {
            isOperator[operator_] = true;
            emit OperatorSet(operator_, true);
        }
    }

    receive() external payable {}

    /// @notice Borrows `amount`, runs `calls`, repays, and requires at least `minProfit` left over.
    /// @return profit Net gain in the borrowed token after repaying principal and fee.
    function execute(
        JitLiquidityApp.Strategy calldata strategy,
        uint256 amount,
        Call[] calldata calls,
        uint256 minProfit
    ) external onlyOperator returns (uint256 profit) {
        IERC20 token = IERC20(strategy.token);
        uint256 balanceBefore = token.balanceOf(address(this));

        _executing = true;
        uint256 fee = APP.flash(strategy, amount, address(this), abi.encode(calls));
        _executing = false;

        uint256 balanceAfter = token.balanceOf(address(this));
        profit = balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0;
        if (balanceAfter < balanceBefore || profit < minProfit) revert InsufficientProfit(profit, minProfit);

        emit Executed(APP.strategyHash(strategy), address(token), amount, fee, profit);
    }

    /// @notice Buys exactly `amountOut` of `tokenOut` from inventory, runs `calls` (which must produce the other
    ///         asset to pay with, e.g. by filling the user's order), pays the vault and keeps the rest.
    /// @return profit Net gain in the paying token. The resolver may not end with less `tokenOut` than it started.
    function executeSwap(
        OracleSwapApp.Strategy calldata strategy,
        address tokenOut,
        uint256 amountOut,
        uint256 maxAmountIn,
        Call[] calldata calls,
        uint256 minProfit
    ) external onlyOperator returns (uint256 profit) {
        (IERC20 out, IERC20 pay) = _swapTokens(strategy.maker, tokenOut);
        uint256[2] memory before = [out.balanceOf(address(this)), pay.balanceOf(address(this))];

        _executing = true;
        uint256 amountIn =
            SWAP_APP.swapExactOut(strategy, tokenOut, amountOut, maxAmountIn, address(this), abi.encode(calls));
        _executing = false;

        uint256 payAfter = pay.balanceOf(address(this));
        profit = payAfter > before[1] ? payAfter - before[1] : 0;
        if (out.balanceOf(address(this)) < before[0] || payAfter < before[1] || profit < minProfit) {
            revert InsufficientProfit(profit, minProfit);
        }
        emit SwapExecuted(SWAP_APP.strategyHash(strategy), tokenOut, amountOut, amountIn, profit);
    }

    function _swapTokens(address maker, address tokenOut) internal view returns (IERC20 out, IERC20 pay) {
        address stableToken = IInventoryMaker(maker).stable();
        out = IERC20(tokenOut);
        pay = IERC20(tokenOut == stableToken ? IInventoryMaker(maker).volatileAsset() : stableToken);
    }

    /// @inheritdoc IOracleSwapCallback
    function oracleSwapCallback(
        address tokenIn,
        address,
        uint256 amountIn,
        uint256,
        address maker,
        bytes32 strategyHash,
        bytes calldata data
    ) external override {
        if (msg.sender != address(SWAP_APP)) revert OnlyApp();
        if (!_executing) revert NotExecuting();
        _runCalls(data);
        IERC20(tokenIn).forceApprove(address(AQUA), amountIn);
        AQUA.push(maker, address(SWAP_APP), strategyHash, tokenIn, amountIn);
    }

    /// @inheritdoc IJitLiquidityCallback
    function onJitLiquidity(
        address token,
        uint256 amount,
        uint256 fee,
        address maker,
        bytes32 strategyHash,
        bytes calldata data
    ) external override {
        if (msg.sender != address(APP)) revert OnlyApp();
        if (!_executing) revert NotExecuting();

        _runCalls(data);

        uint256 repay = amount + fee;
        IERC20(token).forceApprove(address(AQUA), repay);
        AQUA.push(maker, address(APP), strategyHash, token, repay);
    }

    function _runCalls(bytes calldata data) internal {
        Call[] memory calls = abi.decode(data, (Call[]));
        for (uint256 i; i < calls.length; ++i) {
            Call memory c = calls[i];
            if (!isAllowedTarget[c.target]) revert TargetNotAllowed(c.target);
            Address.functionCallWithValue(c.target, c.data, c.value);
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

    /// @notice Grants a spender (router, settlement contract) an allowance over resolver-held tokens.
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
