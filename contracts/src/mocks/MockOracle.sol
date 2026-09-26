// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IChainlinkAggregator} from "../interfaces/IChainlinkAggregator.sol";

/// @notice Chainlink-compatible price feed whose answer is set by its owner. Testnets only.
contract MockOracle is IChainlinkAggregator, Ownable {
    uint8 public immutable override decimals;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public roundId;

    event AnswerUpdated(int256 answer, uint80 roundId, uint256 updatedAt);

    constructor(uint8 decimals_, int256 answer_, address owner_) Ownable(owner_) {
        decimals = decimals_;
        _set(answer_);
    }

    function setAnswer(int256 answer_) external onlyOwner {
        _set(answer_);
    }

    /// @notice For tests: backdate the last update to simulate a stale feed.
    function setUpdatedAt(uint256 updatedAt_) external onlyOwner {
        updatedAt = updatedAt_;
    }

    function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }

    function _set(int256 answer_) internal {
        answer = answer_;
        updatedAt = block.timestamp;
        roundId++;
        emit AnswerUpdated(answer_, roundId, block.timestamp);
    }
}
