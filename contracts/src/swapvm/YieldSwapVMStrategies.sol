// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ISwapVM} from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import {MakerTraitsLib} from "@1inch/swap-vm/libs/MakerTraits.sol";

import {YieldInstructions} from "./YieldInstructions.sol";

/// @title YieldSwapVMStrategies
/// @notice Canonical builder for YieldSolver SwapVM strategies, so wallets, bots and the UI produce byte-identical
///         orders (Aqua strategy hash = keccak256(abi.encode(order))). Program:
///
///           [SequencerGuard(feed, grace)]      only if a sequencer uptime feed is configured (Base mainnet)
///           [Salt(salt)]                       only if salt ≠ 0 (several strategies on the same pair)
///           YieldOracleSwap(stableShare, volatileShare, oracle, maxAge, spread, skew, maxTrade, target, band)
///
///         The order is Aqua-backed (`useAquaInsteadOfSignature`): no signature, balances are the maker's Aqua
///         budgets of the two ERC-4626 share tokens, settled by `AQUA.pull` / `AQUA.push`.
contract YieldSwapVMStrategies is YieldInstructions {
    uint8 internal constant OP_SALT = 20; // AquaOpcodes: Controls._salt

    struct Params {
        address maker;
        address stableShare;
        address volatileShare;
        address oracle;
        uint32 maxPriceAge;
        uint16 spreadBps;
        uint16 skewBps;
        uint16 maxTradeBps;
        uint16 targetStableBps;
        uint16 bandBps;
        address sequencerFeed; // address(0) = no guard
        uint32 sequencerGrace;
        bytes32 salt;
    }

    function program(Params calldata p) public pure returns (bytes memory prog) {
        if (p.sequencerFeed != address(0)) prog = _buildSequencerGuard(p.sequencerFeed, p.sequencerGrace);
        if (p.salt != bytes32(0)) prog = bytes.concat(prog, abi.encodePacked(OP_SALT, uint8(32), p.salt));
        prog = bytes.concat(
            prog,
            _buildYieldOracleSwap(
                YieldOracleSwapArgs({
                    stableShare: p.stableShare,
                    volatileShare: p.volatileShare,
                    oracle: p.oracle,
                    maxPriceAge: p.maxPriceAge,
                    spreadBps: p.spreadBps,
                    skewBps: p.skewBps,
                    maxTradeBps: p.maxTradeBps,
                    targetStableBps: p.targetStableBps,
                    bandBps: p.bandBps
                })
            )
        );
    }

    function buildOrder(Params calldata p) external pure returns (ISwapVM.Order memory order) {
        (address tokenA, address tokenB) =
            p.stableShare < p.volatileShare ? (p.stableShare, p.volatileShare) : (p.volatileShare, p.stableShare);
        order = MakerTraitsLib.build(
            MakerTraitsLib.Args({
                maker: p.maker,
                receiver: address(0),
                tokenA: tokenA,
                tokenB: tokenB,
                shouldUnwrapWeth: false,
                useAquaInsteadOfSignature: true,
                allowZeroAmountIn: false,
                hasPreTransferInHook: false,
                hasPostTransferInHook: false,
                hasPreTransferOutHook: false,
                hasPostTransferOutHook: false,
                preTransferInTarget: address(0),
                preTransferInData: "",
                postTransferInTarget: address(0),
                postTransferInData: "",
                preTransferOutTarget: address(0),
                preTransferOutData: "",
                postTransferOutTarget: address(0),
                postTransferOutData: "",
                program: program(p)
            })
        );
    }

    /// @notice Aqua strategy bytes (what the maker passes to `AQUA.ship`) and its hash (= SwapVM order hash).
    function strategy(Params calldata p) external view returns (bytes memory encoded, bytes32 hash) {
        encoded = abi.encode(this.buildOrder(p));
        hash = keccak256(encoded);
    }
}
