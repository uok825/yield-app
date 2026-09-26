# YieldSolver

**Idle DeFi deposits become intent liquidity, and they keep earning yield while they do.**

YieldSolver lets the same capital earn twice. It stays in Morpho, Aave or Fluid earning lending yield, and it also
fills 1inch Fusion swap intents through 1inch **Aqua** (shared liquidity) and **SwapVM** (programmable swaps) on
**Base**. In self-custody mode the tokens never leave the user's wallet except inside a transaction that must return them.

Built for ETHGlobal Tokyo 2026 · 1inch Aqua × Fusion on Base. Live on **Base Sepolia**.

---

## How it works

```
 user signs a Fusion intent (gasless)            lending markets (Morpho · Aave · Fluid)
        │                                          ▲   yield accrues on ERC-4626 shares
        ▼                                          │
   relayer ──▶ resolver prices every route ──▶ fill from the best source, in one transaction:
                 · JIT: borrow liquidity, fill, repay + fee
                 · market-make: sell from inventory at oracle ± spread
                 · SwapVM: same wallet shares, our YieldOracleSwap instruction
        ▲
   keeper: moves capital to the best APY · keeps inventories in band · runs conditional carry
```

A single wallet position can back several strategies at once: JIT loans, market making and a SwapVM order. That is
Aqua's shared liquidity: one approval, per-strategy budgets, and tokens that stay in the wallet.

## Strategies

| | What it does | Where the money sits |
|---|---|---|
| **Self-custody · Aqua-native** (recommended) | Supply to Morpho / Fluid / Aave yourself and keep the shares. Ship one Aqua strategy: the keeper moves shares to the best market, resolvers borrow them JIT or buy from them (oracle ± spread), and the same shares also run as a **1inch SwapVM** order. Fees come back as shares. | Your wallet |
| **A · Yield + JIT** | ERC-4626 USDC vault spread across lending markets by APY × trust. Lends just-in-time to the resolver and is repaid with a fee in the same transaction. | Vault → lending markets |
| **B · Inventory MM** | USDC + WETH profiles (70/30, 50/50, 30/70) that fill intents from stock at oracle ± spread, with skew toward target and a ±5pp band. Idle inventory is lent on Aave. | Vault → Aave |
| **C · ETH Carry** (conditional) | WETH stays as Aave collateral. The vault borrows USDC into the best whitelisted ERC-4626 sink **only while** sink APY − borrow APR beats entry + exit costs, and unwinds by itself when the spread disappears. | Vault → Aave collateral |

## 1inch integration

- **Fusion (LOP v4 + SimpleSettlement).** Official contracts and SDKs. Gasless signed intents and a Dutch auction.
  Our relayer validates and serves orders; our resolvers fill them. 1inch has no testnet, so the unmodified contracts
  are deployed on Base Sepolia.
- **Aqua.** `AquaYieldApp` (self-custody: rebalance / flash / swap on committed ERC-4626 shares), `JitLiquidityApp`
  (A) and `OracleSwapApp` (B). Every pull is checked to come back in the same transaction.
- **SwapVM.** `YieldSwapVMRouter` = SwapVM 1.2 core + 1inch's Aqua opcodes + two YieldSolver instructions:
  - `YieldOracleSwap` (opcode 64): oracle ± spread market making on **yield-bearing shares**. It prices in
    underlying assets, skews toward the target ratio, and enforces the band and a size cap. It settles in shares, and
    rounding always favours the maker.
  - `SequencerGuard` (opcode 65): no trades while the Base sequencer is down or in its grace period.

  Wallets ship these orders over the same shares they committed to `AquaYieldApp`. Our program passes 1inch's own
  SwapVM `CoreInvariants` suite: symmetry, quote/swap consistency, monotonicity, additivity and maker-favouring rounding.

## Safety

The rules live in the contracts, not the bots:
- Carry: LTV hard cap (30%, max 50%), and **anyone** can deleverage above 40%.
- Inventory: ±band, max trade size, oracle staleness checks.
- Whitelisted sinks, routers and call targets only.
- Loss-making resolver runs revert on-chain.
- ERC-4626 inflation-attack offsets.
- Exits stay open while paused.

Tests: **157 Foundry tests** (unit, fuzz, invariant, Base mainnet fork) and a full local end-to-end run (anvil + all
bots, 16 checks).

## Live on Base Sepolia

| Contract | Address |
|---|---|
| Aqua | `0xdeEe49292CF979c7b70B0178356F0EB0ccF4C7fb` |
| AquaYieldApp (self-custody) | `0xc84AE0f7Aa3D61679DE522f54b307713Ae801626` |
| WalletResolver | `0x0D5eB0a1934b9466FD4C763D6C8822E69FaEb0cf` |
| YieldSwapVMRouter (SwapVM) | `0x1e547BC55D093b0F0E519B71FBC6095FAEF8E5F1` |
| SwapVMResolver | `0x6cDCEB3e34DD47f5ffb63D297F4C70e590015E4b` |
| YieldSwapVMStrategies (order builder) | `0x418D61b0a275c7a3B4556d59e5677412F744E529` |
| YieldVault (A) | `0xF267dCD5ed085B222495748F90b0FC07F125Ef23` |
| InventoryVaults (B: 70/30 · 50/50 · 30/70) | `0x2939d967…4297` · `0xdE440e7F…8C2D` · `0xF15a8Bbb…80bb` |
| YieldResolver | `0x07bA78782d894358A96cb39b3F7eB939c622215e` |
| CarryVault (C) | `0x7eaCf93332803b8F63948FaA9c5A22652eb054C1` |
| 1inch LimitOrderProtocol v4 · Fusion SimpleSettlement | `0x676d295f7050d319bd596Ba4df12eC63eC151c93` · `0x6F4b0bAbcaCf20E50762BcEeD5324bBb55B59000` |

Example transactions:
- SwapVM fill from wallet shares: [`0x338e9cc5…`](https://sepolia.basescan.org/tx/0x338e9cc5793051011ec509088b4d3362e52eb318a7aee85868906dcc8690fd5e)
- JIT fill from the vault: [`0x223675b2…`](https://sepolia.basescan.org/tx/0x223675b27edac19bde3511b5fad6186c789c5761dfc4e76a01c2726a1f88e5f5)

The contracts are also linked to **MultiBaas** (Curvegrid), whose TX Explorer decodes these transactions (function
arguments and events) without Basescan source verification.

Testnet note: lending markets, oracle and router are mocks driven by a simulator. The ETH price mirrors Chainlink on
Base mainnet. The dashboard shows **realised** returns until a full 24h of data exists, because annualising a few hours
of synthetic flow would overstate them.

## Repository

```
contracts/          Foundry: vaults, Aqua apps, SwapVM router + instructions, resolvers, carry, mocks, tests
  src/swapvm/       YieldSwapVMRouter, YieldInstructions (opcodes 64/65), order builder, SwapVMResolver
  script/           Deploy · DeployWallet · DeployCarry · DeploySwapVM
  deployments/      deployed addresses per chain
bots/               TypeScript bots: relayer, resolver, keeper (+ carry), maker simulator, market simulator
  scripts/          deploy, end-to-end test, ABI generation, MultiBaas linking
src/                dashboard (Vite + TypeScript): strategy views, Fusion intent flow, wallet, SwapVM program view
```

Details: [`contracts/README.md`](contracts/README.md) (contracts, tests, deployment) ·
[`bots/README.md`](bots/README.md) (bots, Base Sepolia runbook, configuration).

## Run it

```bash
git clone --recurse-submodules https://github.com/uok825/yield-app.git && cd yield-app

# contracts
cd contracts && forge build && forge test && cd ..

# full stack (bots + dashboard) against the Base Sepolia deployment
cp bots/.env.example bots/.env          # add RPC + keys
cd bots && docker compose up -d --build # dashboard: http://localhost:4173 · API: http://localhost:8080/v1/snapshot

# or everything locally on anvil, with assertions
cd bots && npm install && npm run e2e
```

Dashboard only (points at a running relayer): `bun install && bun run dev`.
