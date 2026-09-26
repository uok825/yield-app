// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

import {ISwapVM} from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import {ITakerCallbacks} from "@1inch/swap-vm/interfaces/ITakerCallbacks.sol";
import {TakerTraitsLib} from "@1inch/swap-vm/libs/TakerTraits.sol";

/// @title SwapVMResolver
/// @notice Fills 1inch Fusion orders from wallet liquidity through SwapVM: buys exactly `sharesOut` of a wallet's
///         ERC-4626 shares from a SwapVM Aqua strategy, and inside SwapVM's pre-transfer-in callback redeems them,
///         runs the whitelisted calls (the Fusion/LOP fill that produces the payment), mints the input shares and
///         lets SwapVM push them to the maker through Aqua. The wallet keeps earning on both sides; loss-making
///         runs revert.
contract SwapVMResolver is Ownable2Step, ITakerCallbacks {
    using SafeERC20 for IERC20;

    error OnlyOperator();
    error OnlyRouter();
    error NotExecuting();
    error TargetNotAllowed(address target);
    error InsufficientProfit(uint256 profit, uint256 minProfit);
    error UnknownShare(address share);
    error ZeroAddress();

    event OperatorSet(address indexed operator, bool allowed);
    event TargetSet(address indexed target, bool allowed);
    event Executed(
        address indexed maker,
        bytes32 indexed orderHash,
        address shareIn,
        address shareOut,
        uint256 sharesIn,
        uint256 sharesOut,
        address profitToken,
        uint256 profit
    );

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    ISwapVM public immutable ROUTER;
    mapping(address => bool) public isOperator;
    mapping(address => bool) public isAllowedTarget;
    bool private transient _executing;

    modifier onlyOperator() {
        if (!isOperator[msg.sender] && msg.sender != owner()) revert OnlyOperator();
        _;
    }

    constructor(ISwapVM router_, address owner_, address operator_) Ownable(owner_) {
        if (address(router_) == address(0)) revert ZeroAddress();
        ROUTER = router_;
        if (operator_ != address(0)) {
            isOperator[operator_] = true;
            emit OperatorSet(operator_, true);
        }
    }

    receive() external payable {}

    /// @notice Buys exactly `sharesOut` of `shareOut` from the wallet strategy `order` (paying at most
    ///         `maxSharesIn` of the pair's other share), redeeming them for the underlying that `calls` deliver.
    /// @return profit Net gain in the underlying of the input share (what the filled order paid us).
    function executeSwap(
        ISwapVM.Order calldata order,
        address shareOut,
        uint256 sharesOut,
        uint256 maxSharesIn,
        Call[] calldata calls,
        uint256 minProfit
    ) external onlyOperator returns (uint256 profit) {
        (address tokenA, address tokenB) = _pair(order);
        if (shareOut != tokenA && shareOut != tokenB) revert UnknownShare(shareOut);
        address shareIn = shareOut == tokenA ? tokenB : tokenA;
        IERC20 assetOut = IERC20(IERC4626(shareOut).asset());
        IERC20 assetIn = IERC20(IERC4626(shareIn).asset());
        uint256[2] memory before = [assetOut.balanceOf(address(this)), assetIn.balanceOf(address(this))];

        bytes memory takerData = TakerTraitsLib.build(
            TakerTraitsLib.Args({
                taker: address(this),
                isExactIn: false,
                shouldUnwrapWeth: false,
                isStrictThresholdAmount: false,
                isFirstTransferFromTaker: false, // wallet shares first → redeem → fill → pay
                useTransferFromAndAquaPush: true,
                isAToB: shareIn == tokenA,
                threshold: abi.encodePacked(maxSharesIn),
                to: address(0),
                deadline: 0,
                hasPreTransferInCallback: true,
                hasPreTransferOutCallback: false,
                preTransferInHookData: "",
                postTransferInHookData: "",
                preTransferOutHookData: "",
                postTransferOutHookData: "",
                preTransferInCallbackData: abi.encode(calls),
                preTransferOutCallbackData: "",
                instructionsArgs: "",
                signature: ""
            })
        );

        _executing = true;
        (uint256 sharesIn,, bytes32 orderHash) = ROUTER.swap(order, sharesOut, takerData);
        _executing = false;

        // Any input shares minted beyond what the wallet was paid are ours: turn them back into the asset.
        uint256 spare = IERC20(shareIn).balanceOf(address(this));
        if (spare > 0) IERC4626(shareIn).redeem(spare, address(this), address(this));

        if (assetOut.balanceOf(address(this)) < before[0]) revert InsufficientProfit(0, minProfit);
        uint256 afterIn = assetIn.balanceOf(address(this));
        profit = afterIn > before[1] ? afterIn - before[1] : 0;
        if (afterIn < before[1] || profit < minProfit) revert InsufficientProfit(profit, minProfit);
        emit Executed(order.maker, orderHash, shareIn, shareOut, sharesIn, sharesOut, address(assetIn), profit);
    }

    /// @inheritdoc ITakerCallbacks
    /// @dev SwapVM has already sent `amountOut` wallet shares here. Redeem → fill → mint `amountIn` input shares →
    ///      approve the router, which pulls them and pushes them to the maker through Aqua.
    function preTransferInCallback(
        address,
        address,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        bytes32,
        bytes calldata takerData
    ) external override {
        if (msg.sender != address(ROUTER)) revert OnlyRouter();
        if (!_executing) revert NotExecuting();
        IERC4626(tokenOut).redeem(amountOut, address(this), address(this));
        _runCalls(takerData);
        IERC20 assetIn = IERC20(IERC4626(tokenIn).asset());
        assetIn.forceApprove(tokenIn, IERC4626(tokenIn).previewMint(amountIn));
        IERC4626(tokenIn).mint(amountIn, address(this));
        IERC20(tokenIn).forceApprove(address(ROUTER), amountIn);
    }

    /// @inheritdoc ITakerCallbacks
    function preTransferOutCallback(address, address, address, address, uint256, uint256, bytes32, bytes calldata)
        external
        pure
        override
    {
        revert NotExecuting(); // not used
    }

    function _pair(ISwapVM.Order calldata order) internal pure returns (address tokenA, address tokenB) {
        bytes calldata data = order.data;
        tokenA = address(bytes20(data[0:20]));
        tokenB = address(bytes20(data[20:40]));
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
