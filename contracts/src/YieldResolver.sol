// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {IAqua} from "@1inch/aqua/interfaces/IAqua.sol";

import {JitLiquidityApp} from "./JitLiquidityApp.sol";
import {IJitLiquidityCallback} from "./interfaces/IJitLiquidity.sol";

/// @title YieldResolver
/// @notice Order resolver funded by JIT liquidity. An operator borrows vault liquidity through
///         `JitLiquidityApp`, runs a list of calls against whitelisted targets (e.g. the 1inch Limit Order
///         Protocol / Fusion settlement to fill an order, then a router to unwind the received asset), repays
///         principal + fee to the vault and keeps the rest as profit.
contract YieldResolver is Ownable2Step, IJitLiquidityCallback {
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

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    IAqua public immutable AQUA;
    JitLiquidityApp public immutable APP;

    mapping(address => bool) public isOperator;
    mapping(address => bool) public isAllowedTarget;

    bool private transient _executing;

    modifier onlyOperator() {
        if (!isOperator[msg.sender] && msg.sender != owner()) revert OnlyOperator();
        _;
    }

    constructor(IAqua aqua_, JitLiquidityApp app_, address owner_, address operator_) Ownable(owner_) {
        if (address(aqua_) == address(0) || address(app_) == address(0)) revert ZeroAddress();
        AQUA = aqua_;
        APP = app_;
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

        Call[] memory calls = abi.decode(data, (Call[]));
        for (uint256 i; i < calls.length; ++i) {
            Call memory c = calls[i];
            if (!isAllowedTarget[c.target]) revert TargetNotAllowed(c.target);
            Address.functionCallWithValue(c.target, c.data, c.value);
        }

        uint256 repay = amount + fee;
        IERC20(token).forceApprove(address(AQUA), repay);
        AQUA.push(maker, address(APP), strategyHash, token, repay);
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
