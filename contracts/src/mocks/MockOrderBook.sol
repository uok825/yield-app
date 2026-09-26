// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Minimal on-chain limit order book standing in for 1inch LOP / Fusion on testnets. Users post an intent
///         ("give `makingAmount` of makerAsset for at least `takingAmount` of takerAsset"); a resolver fills it.
///         Transfer order mirrors LOP v4: maker → taker first, then taker → maker.
contract MockOrderBook {
    using SafeERC20 for IERC20;

    error NotMaker();
    error NotOpen();

    struct Order {
        address maker;
        address makerAsset;
        address takerAsset;
        uint256 makingAmount;
        uint256 takingAmount;
        bool open;
    }

    Order[] public orders;

    event OrderCreated(
        uint256 indexed id,
        address indexed maker,
        address makerAsset,
        address takerAsset,
        uint256 making,
        uint256 taking
    );
    event OrderFilled(uint256 indexed id, address indexed taker);
    event OrderCancelled(uint256 indexed id);

    /// @notice The maker must approve this contract for `makingAmount` of `makerAsset`.
    function createOrder(address makerAsset, address takerAsset, uint256 makingAmount, uint256 takingAmount)
        external
        returns (uint256 id)
    {
        id = orders.length;
        orders.push(Order(msg.sender, makerAsset, takerAsset, makingAmount, takingAmount, true));
        emit OrderCreated(id, msg.sender, makerAsset, takerAsset, makingAmount, takingAmount);
    }

    function fill(uint256 id) external {
        Order storage o = orders[id];
        if (!o.open) revert NotOpen();
        o.open = false;
        IERC20(o.makerAsset).safeTransferFrom(o.maker, msg.sender, o.makingAmount);
        IERC20(o.takerAsset).safeTransferFrom(msg.sender, o.maker, o.takingAmount);
        emit OrderFilled(id, msg.sender);
    }

    function cancel(uint256 id) external {
        Order storage o = orders[id];
        if (o.maker != msg.sender) revert NotMaker();
        if (!o.open) revert NotOpen();
        o.open = false;
        emit OrderCancelled(id);
    }

    function orderCount() external view returns (uint256) {
        return orders.length;
    }
}
