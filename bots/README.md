# YieldSolver bots

Off-chain side of YieldSolver: a 1inch Fusion relayer, the resolver that fills intents with vault liquidity, the
keeper that manages both strategies, simulated makers, and a testnet world simulator.

```
 maker ──signed Fusion order──▶ relayer ◀──poll── resolver ──executeSwap / execute──▶ YieldResolver
 (users)       POST /v1/orders    │  ▲                │                                   │
                                  │  └─ OrderFilled ──┘                    LimitOrderProtocol v4 + Fusion
                           LOP events                                      SimpleSettlement (official 1inch)
 keeper ──allocate / reallocate / queue / rebalance──▶ YieldVault (A) · InventoryVault ×3 (B)
 sim ──oracle (Chainlink mirror) · router prices · market interest──▶ mocks        (testnets only)
```

| Bot | Key | What it does |
|---|---|---|
| `relayer` | — | Accepts signed Fusion orders, validates them (hash, EIP-712 signature against the deployed LOP domain, settlement, resolver whitelist, balance/allowance, expiry), serves them to resolvers, tracks `OrderFilled` / `OrderCancelled` and nonce invalidation. JSON store with atomic writes. |
| `resolver` | `OPERATOR` | For each active order, computes the current Dutch-auction amount, simulates **B** (buy from each inventory profile via `OracleSwapApp`) and **A** (JIT USDC from the YieldVault + router leg), and fills with the most profitable route once net profit (after gas) clears the floor. `minProfit` is enforced on-chain. |
| `keeper` | `KEEPER` | **A:** measures each market's APY from its supply index over a rolling window, moves capital toward `apy × trust`, keeps the reserve, reorders the withdraw queue (with hysteresis). **B:** keeps an idle buffer per asset, lends the rest on Aave, swaps back to target when a profile leaves its band. |
| `maker` | `MAKER_MNEMONIC` | Simulated users posting real Fusion orders (USDC⇄WETH) priced off the oracle, auction from +0.5% to −1%. |
| `sim` | `DEPLOYER` | Mock deployments only: mirrors Chainlink ETH/USD from Base mainnet into the mock oracle, keeps the mock router near oracle, accrues interest on mock markets. |

Fusion orders are built and signed with the official `@1inch/fusion-sdk` / `@1inch/limit-order-sdk` against the
official LOP v4 + `SimpleSettlement` contracts. 1inch has no testnet deployment, so on Base Sepolia the contracts
script deploys them (unmodified) and this relayer stands in for the 1inch order API.

## Run on Base Sepolia

You need Foundry, Node ≥ 22 and Base Sepolia ETH on three **fresh** keys: deployer (~0.02 ETH), keeper and operator
(~0.005 ETH each). Never use anvil/hardhat test keys on a public testnet — they are EIP-7702-delegated to sweepers
(the bots refuse to run with such wallets).

```bash
# 1. Contracts (from repo root)
cd contracts
KEEPER=<keeper address> OPERATOR=<operator address> \
  forge script script/Deploy.s.sol --rpc-url https://sepolia.base.org --private-key $DEPLOYER_PRIVATE_KEY \
  --broadcast --slow
# → contracts/deployments/84532.json

# 2. Bots
cd ../bots
npm ci
cp .env.example .env        # fill RPC_URL, the three keys and a fresh MAKER_MNEMONIC
npm run setup               # sends gas ETH to maker wallets
npm run seed                # LP liquidity: markets, strategy A, three inventory profiles
npm run all                 # every bot in one process — or one per terminal:
#   npm run relayer · npm run sim · npm run keeper · npm run resolver · npm run maker
```

`--slow` sends deploy transactions one at a time; without it some RPCs drop part of a large batch.

### Demo commands

```bash
npm run order -- --side buy-eth --usd 1500     # post one intent as maker #0
npm run order -- --side sell-eth --usd 800
npm run status                                 # both strategies, resolver profit, relayer counts
curl localhost:8080/v1/orders?limit=10          # order history with fill tx + route
curl localhost:8080/v1/bots                     # bot health (all-in-one mode)
```

### Docker

`docker compose up -d --build` runs one container per bot with the same `.env`, mounting
`../contracts/deployments`. (Not exercised in the environment these bots were developed in; the npm scripts are.)

## Relayer API

| Method | Path | |
|---|---|---|
| GET | `/health` | liveness + last synced block |
| GET | `/v1/settings` | chain id, LOP EIP-712 domain, settlement, whitelisted resolvers, tokens |
| POST | `/v1/orders` | submit `{orderHash, order, extension, signature}` → 201 / 400 with reason |
| GET | `/v1/orders/active` | pending orders |
| GET | `/v1/orders?maker=&status=&limit=` | history |
| GET | `/v1/orders/:hash` | one order |
| POST | `/v1/orders/:hash/report` | resolver fill report (route, profit) |
| GET | `/v1/stats` · `/v1/bots` | counters · in-process bot status |

CORS is open so a dashboard can read it directly.

## Test

```bash
npm test          # unit: allocation math, APY, Fusion order signing / decoding / auction / calldata
npm run e2e       # local anvil: deploy → setup → seed → all bots for 120s → assertions
E2E_FORK_URL=https://sepolia.base.org PRICE_SOURCE_RPC_URL=https://mainnet.base.org npm run e2e
                  # same on a Base Sepolia fork (chain id 84532, Chainlink mirror)
```

The e2e asserts that makers post orders, most orders get filled, **both** routes are used, every fill is reported,
the keeper allocates strategy A and the inventories stay funded.

## Operating notes

- **One key per process.** Nonces are managed in-process; two processes sharing a key will collide.
- **Profit safety.** Every fill is simulated first; the transaction carries `minProfit = simulated × (1 −
  RESOLVER_PROFIT_TOLERANCE_BPS)`, and `YieldResolver` reverts loss-making runs.
- **Live mode (Base mainnet).** Leave `USDC` unset only for testnets. On Base the deploy script wires the canonical
  LOP / Fusion settlement / Chainlink / Aqua. Real 1inch Fusion order flow requires being a whitelisted 1inch resolver;
  route A additionally needs a DEX adapter (the bot only prices the mock router), so on mainnet only route B runs.
- **Regenerate ABIs** after changing contracts: `forge build` in `contracts/`, then `npm run abis`.
