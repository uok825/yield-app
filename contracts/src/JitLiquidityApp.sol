// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IAqua} from "@1inch/aqua/interfaces/IAqua.sol";
import {AquaApp} from "@1inch/aqua/AquaApp.sol";

import {IJitLiquidityProvider, IJitLiquidityCallback} from "./interfaces/IJitLiquidity.sol";

/// @title JitLiquidityApp
/// @notice Aqua app that lends a maker's liquidity for the duration of one call (flash-style) against a fee.
///         The maker's tokens can sit in lending markets; the maker is asked to unwind just in time before
///         `AQUA.pull`, and must see its tokens returned (plus fee) through `AQUA.push` before the call ends.
contract JitLiquidityApp is AquaApp {
    using Math for uint256;

    error UnauthorizedTaker(address caller, address allowed);
    error InvalidFee(uint256 feeBps);
    error ZeroAmount();

    event Flash(
        address indexed maker,
        bytes32 indexed strategyHash,
        address indexed taker,
        address token,
        uint256 amount,
        uint256 fee
    );

    /// @param maker    Liquidity owner (an IJitLiquidityProvider, e.g. YieldVault).
    /// @param token    Token lent out.
    /// @param taker    Only address allowed to borrow; address(0) means anyone.
    /// @param feeBps   Fee charged on the borrowed amount, rounded up.
    /// @param salt     Lets one maker ship several otherwise identical strategies.
    struct Strategy {
        address maker;
        address token;
        address taker;
        uint16 feeBps;
        bytes32 salt;
    }

    uint256 public constant MAX_FEE_BPS = 1_000;
    uint256 internal constant BPS = 10_000;

    constructor(IAqua aqua_) AquaApp(aqua_) {}

    function strategyHash(Strategy calldata strategy) public pure returns (bytes32) {
        return keccak256(abi.encode(strategy));
    }

    function flashFee(Strategy calldata strategy, uint256 amount) public pure returns (uint256) {
        return amount.mulDiv(strategy.feeBps, BPS, Math.Rounding.Ceil);
    }

    /// @notice Remaining Aqua budget for this strategy.
    function available(Strategy calldata strategy) external view returns (uint256 balance) {
        (balance,) = AQUA.rawBalances(strategy.maker, address(this), strategyHash(strategy), strategy.token);
    }

    /// @notice Sends `amount` of the strategy token to `receiver`, calls back `msg.sender`, and requires
    ///         `amount + fee` to have been pushed back to the maker through Aqua.
    function flash(Strategy calldata strategy, uint256 amount, address receiver, bytes calldata data)
        external
        nonReentrantStrategy(strategy.maker, keccak256(abi.encode(strategy)))
        returns (uint256 fee)
    {
        if (amount == 0) revert ZeroAmount();
        if (strategy.feeBps > MAX_FEE_BPS) revert InvalidFee(strategy.feeBps);
        if (strategy.taker != address(0) && msg.sender != strategy.taker) {
            revert UnauthorizedTaker(msg.sender, strategy.taker);
        }

        bytes32 hash = keccak256(abi.encode(strategy));
        (uint256 balanceBefore,) = AQUA.rawBalances(strategy.maker, address(this), hash, strategy.token);
        fee = flashFee(strategy, amount);

        IJitLiquidityProvider(strategy.maker).lendLiquidity(strategy.token, amount);
        AQUA.pull(strategy.maker, hash, strategy.token, amount, receiver);

        IJitLiquidityCallback(msg.sender).onJitLiquidity(strategy.token, amount, fee, strategy.maker, hash, data);

        _safeCheckAquaPush(strategy.maker, hash, strategy.token, balanceBefore + fee);
        IJitLiquidityProvider(strategy.maker).settleLiquidity(strategy.token, amount);

        emit Flash(strategy.maker, hash, msg.sender, strategy.token, amount, fee);
    }
}
