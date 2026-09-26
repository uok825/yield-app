// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Simulator} from "@1inch/solidity-utils/contracts/mixins/Simulator.sol";

import {SwapVM} from "@1inch/swap-vm/SwapVM.sol";
import {AquaOpcodes} from "@1inch/swap-vm/opcodes/AquaOpcodes.sol";
import {Context} from "@1inch/swap-vm/libs/VM.sol";

import {YieldInstructions} from "./YieldInstructions.sol";

/// @title YieldSwapVMRouter
/// @notice 1inch SwapVM (unmodified core, release 1.2) with the full Aqua instruction set (XYC / concentrated /
///         pegged curves, decay, fees, guards, extruction) plus YieldSolver's instructions for liquidity that keeps
///         earning yield: `YieldOracleSwap` (64) and `SequencerGuard` (65). Strategies are shipped through the same
///         Aqua instance as `AquaYieldApp`, so one wallet position backs both apps at once.
contract YieldSwapVMRouter is Simulator, SwapVM, AquaOpcodes, YieldInstructions {
    constructor(address aqua, address weth, address owner)
        SwapVM(aqua, weth, owner, "YieldSolver SwapVM", "1")
        AquaOpcodes(aqua)
    {}

    function _dispatch(Context memory ctx, uint256 opcode, bytes calldata args) internal override {
        if (opcode == OP_YIELD_ORACLE_SWAP) _yieldOracleSwap(ctx, args);
        else if (opcode == OP_SEQUENCER_GUARD) _sequencerGuard(ctx, args);
        else _runOpcode(ctx, opcode, args);
    }
}
