// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// Pulls the official 1inch Limit Order Protocol v4 and Fusion settlement into the build so they can be deployed on
// testnets where 1inch has no deployment. Sources are unmodified (git submodules, MIT).
import {LimitOrderProtocol} from "@1inch/limit-order-protocol-contract/contracts/LimitOrderProtocol.sol";
import {SimpleSettlement} from "@1inch/fusion-protocol/contracts/SimpleSettlement.sol";
